import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Sıfırdan kurulumda önce BASE_VERSION şeması, sonra sıradaki geçişler uygulanır.
// Mevcut veritabanları yalnızca eksik geçişleri alır. Yeni bir değişiklik için MIGRATIONS'a
// bir sonraki numarayla ekleme yapın; var olan geçişi asla değiştirmeyin.
const BASE_VERSION = 2;

const MIGRATIONS = {
  3: `
    ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN failed_logins INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN locked_until TEXT;

    CREATE TABLE audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      gym_id      INTEGER REFERENCES gyms(id),
      user_id     INTEGER NOT NULL REFERENCES users(id),
      action      TEXT NOT NULL,
      target_type TEXT,
      target_id   TEXT,
      details     TEXT,
      at          TEXT NOT NULL
    );
    CREATE INDEX idx_audit_gym ON audit_log(gym_id, id);
  `,
  // Giriş kayıtlarını tarih aralığına göre hızlı sorgulamak için
  4: `
    CREATE INDEX idx_entries_gym_at ON entries(gym_id, at);
  `,
  // İnternet kesilince kapının davranışı (kapı başına) ve kapının bildirdiği çevrimdışı dönemler.
  // Varsayılan "open": bağlantı offline_grace_seconds'tan uzun kesilirse kapı serbest geçişe açılır.
  5: `
    ALTER TABLE gates ADD COLUMN offline_policy TEXT NOT NULL DEFAULT 'open';
    ALTER TABLE gates ADD COLUMN offline_grace_seconds INTEGER NOT NULL DEFAULT 30;

    CREATE TABLE gate_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      gym_id        INTEGER NOT NULL REFERENCES gyms(id),
      gate_id       TEXT NOT NULL,
      kind          TEXT NOT NULL,
      started_at    TEXT NOT NULL,
      ended_at      TEXT NOT NULL,
      clock_suspect INTEGER NOT NULL DEFAULT 0,
      report_id     TEXT NOT NULL UNIQUE,
      created_at    TEXT NOT NULL
    );
    CREATE INDEX idx_gate_events_gym ON gate_events(gym_id, id);
  `,
};

const LATEST_VERSION = Math.max(BASE_VERSION, ...Object.keys(MIGRATIONS).map(Number));

// Hesaplar (users) küreseldir: bir kişi birden fazla salona üye olabilir.
// Salona özel her şey (paket, üyelik, kapı, giriş kaydı) gym_id ile ayrılır.
const schema = `
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE gyms (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Web panelini kullanan salon çalışanları
CREATE TABLE gym_staff (
  gym_id  INTEGER NOT NULL REFERENCES gyms(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  role    TEXT NOT NULL CHECK (role IN ('owner', 'staff')),
  PRIMARY KEY (gym_id, user_id)
);

-- Kişinin bir salonla ilişkisi (aynı kişi birden çok salonda satır sahibi olabilir)
CREATE TABLE gym_members (
  gym_id     INTEGER NOT NULL REFERENCES gyms(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (gym_id, user_id)
);
CREATE INDEX idx_gym_members_user ON gym_members(user_id);

CREATE TABLE plans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  gym_id      INTEGER NOT NULL REFERENCES gyms(id),
  name        TEXT NOT NULL,
  days        INTEGER NOT NULL CHECK (days > 0),
  price_cents INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_plans_gym ON plans(gym_id);

CREATE TABLE memberships (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  gym_id    INTEGER NOT NULL,
  user_id   INTEGER NOT NULL,
  plan_id   INTEGER NOT NULL REFERENCES plans(id),
  starts_at TEXT NOT NULL,
  ends_at   TEXT NOT NULL,
  FOREIGN KEY (gym_id, user_id) REFERENCES gym_members(gym_id, user_id)
);
CREATE INDEX idx_memberships_member ON memberships(gym_id, user_id, ends_at);

CREATE TABLE gates (
  id       TEXT PRIMARY KEY,
  gym_id   INTEGER NOT NULL REFERENCES gyms(id),
  name     TEXT NOT NULL,
  key_hash TEXT NOT NULL
);
CREATE INDEX idx_gates_gym ON gates(gym_id);

CREATE TABLE entries (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  gym_id  INTEGER NOT NULL REFERENCES gyms(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  gate_id TEXT NOT NULL,
  at      TEXT NOT NULL,
  allowed INTEGER NOT NULL,
  reason  TEXT
);
CREATE INDEX idx_entries_gym ON entries(gym_id, id);
CREATE INDEX idx_entries_user ON entries(gym_id, user_id, at);
`;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    prepareDatabase(db, path);
  } catch (err) {
    db.close(); // hata durumunda dosya kilitli kalmasın
    throw err;
  }
  return db;
}

function prepareDatabase(db, path) {
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

  let { user_version: version } = db.prepare('PRAGMA user_version').get();
  if (version === 0) {
    const legacy = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'members'").get();
    if (legacy) {
      throw new Error(`${path} eski (tek salonlu) şemada. Geliştirme verisiyse dosyayı silip "npm run setup" çalıştırın.`);
    }
    db.exec(schema);
    db.exec(`PRAGMA user_version = ${BASE_VERSION}`);
    version = BASE_VERSION;
  } else if (version < BASE_VERSION || version > LATEST_VERSION) {
    throw new Error(`Desteklenmeyen veritabanı sürümü: ${version} (beklenen ${BASE_VERSION}-${LATEST_VERSION})`);
  }

  for (let next = version + 1; next <= LATEST_VERSION; next++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[next]);
      db.exec(`PRAGMA user_version = ${next}`);
    });
  }
}

const openTransactions = new WeakSet();

/**
 * Birden çok yazmayı tek işlem olarak çalıştırır; hata olursa hepsi geri alınır.
 * İç içe çağrılırsa dıştaki işleme katılır (SQLite iç içe BEGIN'e izin vermez).
 */
export function transaction(db, fn) {
  if (openTransactions.has(db)) return fn();
  db.exec('BEGIN');
  openTransactions.add(db);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    openTransactions.delete(db);
  }
}
