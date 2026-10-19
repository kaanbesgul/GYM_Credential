import { createGym } from './gyms.js';
import { hashGateKey, hashPassword } from './security.js';

/**
 * Geliştirme için örnek veri: salon sahibi hesabı, bir salon (varsayılan paketleriyle) ve ilk kapı.
 * Her parça yalnızca yoksa eklenir, tekrar çalıştırmak güvenlidir.
 */
export function seedDefaults(db, { ownerEmail, ownerPassword, gymName = 'Demo Salon', gateId, gateKey }) {
  const created = { owner: false, gym: false, gate: false };

  let owner = db.prepare('SELECT id FROM users WHERE email = ?').get(ownerEmail);
  if (!owner) {
    const info = db
      .prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
      .run('Salon Sahibi', ownerEmail, hashPassword(ownerPassword));
    owner = { id: Number(info.lastInsertRowid) };
    created.owner = true;
  }

  let gym = db
    .prepare("SELECT gym_id AS id FROM gym_staff WHERE user_id = ? AND role = 'owner' ORDER BY gym_id LIMIT 1")
    .get(owner.id);
  if (!gym) {
    gym = { id: createGym(db, { name: gymName, ownerUserId: owner.id }) };
    created.gym = true;
  }

  if (!db.prepare('SELECT 1 FROM gates WHERE id = ?').get(gateId)) {
    db.prepare('INSERT INTO gates (id, gym_id, name, key_hash) VALUES (?, ?, ?, ?)').run(
      gateId,
      gym.id,
      'Ana Giriş',
      hashGateKey(gateKey),
    );
    created.gate = true;
  }

  return { ...created, gymId: gym.id };
}
