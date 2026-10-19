import { transaction } from './db.js';

// Yeni salona hazır gelen paketler; fiyatlar salon sahibi tarafından girilir
const DEFAULT_PLANS = [
  { name: 'Aylık', days: 30 },
  { name: '3 Aylık', days: 90 },
  { name: 'Yıllık', days: 365 },
];

/** Salonu, sahibini ve varsayılan paketleri oluşturur. Salon kimliğini döndürür. */
export function createGym(db, { name, ownerUserId }) {
  return transaction(db, () => {
    const gymId = Number(db.prepare('INSERT INTO gyms (name) VALUES (?)').run(name).lastInsertRowid);
    db.prepare("INSERT INTO gym_staff (gym_id, user_id, role) VALUES (?, ?, 'owner')").run(gymId, ownerUserId);
    const insertPlan = db.prepare('INSERT INTO plans (gym_id, name, days, price_cents) VALUES (?, ?, ?, 0)');
    for (const plan of DEFAULT_PLANS) insertPlan.run(gymId, plan.name, plan.days);
    return gymId;
  });
}

export function staffGyms(db, userId) {
  return db
    .prepare(
      `SELECT g.id, g.name, s.role
         FROM gym_staff s JOIN gyms g ON g.id = s.gym_id
        WHERE s.user_id = ? ORDER BY g.name`,
    )
    .all(userId);
}
