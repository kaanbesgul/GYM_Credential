/**
 * Hassas işlemleri denetim kaydına yazar: kim, hangi salonda, ne yaptı.
 * `request.account` oturumdaki kişidir; salon dışı işlemlerde (şifre değişimi) gymId null kalır.
 */
export function audit(db, request, action, { gymId = request.gymId ?? null, targetType = null, targetId = null, details = null } = {}) {
  db.prepare(
    'INSERT INTO audit_log (gym_id, user_id, action, target_type, target_id, details, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    gymId,
    request.account.id,
    action,
    targetType,
    targetId === null ? null : String(targetId),
    details ? JSON.stringify(details) : null,
    new Date().toISOString(),
  );
}
