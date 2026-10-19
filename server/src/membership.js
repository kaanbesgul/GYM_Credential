export const DAY_MS = 24 * 60 * 60 * 1000;

/** Bu salonda şu an geçerli olan üyelik (yoksa undefined). */
export function currentMembership(db, gymId, userId, now = new Date()) {
  const iso = now.toISOString();
  return db
    .prepare(
      `SELECT ms.id, ms.starts_at, ms.ends_at, p.name AS plan_name
         FROM memberships ms JOIN plans p ON p.id = ms.plan_id
        WHERE ms.gym_id = ? AND ms.user_id = ? AND ms.starts_at <= ? AND ms.ends_at >= ?
        ORDER BY ms.ends_at DESC LIMIT 1`,
    )
    .get(gymId, userId, iso, iso);
}

/** Bu salondaki en son biten üyelik; süresi dolmuş olsa da gösterim için kullanılır. */
export function latestMembership(db, gymId, userId) {
  return db
    .prepare(
      `SELECT ms.id, ms.starts_at, ms.ends_at, p.name AS plan_name
         FROM memberships ms JOIN plans p ON p.id = ms.plan_id
        WHERE ms.gym_id = ? AND ms.user_id = ?
        ORDER BY ms.ends_at DESC LIMIT 1`,
    )
    .get(gymId, userId);
}

export function daysLeft(endsAt, now = Date.now()) {
  return Math.max(0, Math.ceil((Date.parse(endsAt) - now) / DAY_MS));
}
