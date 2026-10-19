import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';

describe('Veritabanı geçişleri', () => {
  it('v2 şemasındaki mevcut veritabanı veri kaybetmeden en son sürüme yükseltilir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gym-migration-'));
    const path = join(dir, 'gym.db');
    try {
      // Güncel şemayı kur, sonra v2 hâline geri götür ve içine veri koy
      openDb(path).close();
      const raw = new DatabaseSync(path);
      raw.exec('DROP TABLE gate_events; ALTER TABLE gates DROP COLUMN offline_policy; ALTER TABLE gates DROP COLUMN offline_grace_seconds;');
      raw.exec('DROP INDEX idx_entries_gym_at; DROP TABLE audit_log; ALTER TABLE users DROP COLUMN token_version; ALTER TABLE users DROP COLUMN failed_logins; ALTER TABLE users DROP COLUMN locked_until;');
      raw.exec("INSERT INTO users (name, email, password_hash) VALUES ('Eski Kullanıcı', 'eski@test.local', 'hash')");
      raw.exec('PRAGMA user_version = 2');
      raw.close();

      const db = openDb(path);
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5);
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_entries_gym_at'").get());
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'gate_events'").get());
      const user = db.prepare("SELECT name, token_version, failed_logins, locked_until FROM users WHERE email = 'eski@test.local'").get();
      assert.equal(user.name, 'Eski Kullanıcı');
      assert.equal(user.token_version, 0);
      assert.equal(user.failed_logins, 0);
      assert.equal(user.locked_until, null);
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'audit_log'").get());
      db.close();

      // İkinci açılış değişiklik yapmaz
      const again = openDb(path);
      assert.equal(again.prepare('PRAGMA user_version').get().user_version, 5);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('eski tek salonlu şemayı fark edip anlaşılır hata verir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gym-legacy-'));
    const path = join(dir, 'gym.db');
    try {
      const raw = new DatabaseSync(path);
      raw.exec('CREATE TABLE members (id INTEGER PRIMARY KEY)');
      raw.close();
      assert.throws(() => openDb(path), /eski \(tek salonlu\) şemada/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
