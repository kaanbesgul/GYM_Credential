import { randomBytes } from 'node:crypto';
import { audit } from '../audit.js';
import { REASON_TEXT, localParts, toCsv } from '../csv.js';
import { transaction } from '../db.js';
import { DAY_MS } from '../membership.js';
import { setupRateLimit } from '../rateLimit.js';
import { hashGateKey, hashPassword, newGateKey } from '../security.js';
import { normalizeEmail } from './auth.js';

const nameSchema = { type: 'string', minLength: 1, maxLength: 100 };

/**
 * Salon çalışanlarının web panelinden kullandığı uç noktalar: /api/gyms/:gymId/...
 * Roller: `owner` her şeyi yapar; `staff` üye/paket tanımlama, giriş kayıtları ve elle kapı açma gibi
 * günlük işleri yapar ama paket fiyatı, kapı, çalışan ve denetim kaydına dokunamaz.
 */
export default async function gymAdminRoutes(app, { db, hub, config }) {
  await setupRateLimit(app, config, { global: true });

  // Her istekte: oturum geçerli mi, bu kişi bu salonun çalışanı mı?
  app.addHook('preHandler', async (request, reply) => {
    const denied = await app.authenticate(request, reply);
    if (denied) return denied;
    const gymId = Number(request.params.gymId);
    const staff = Number.isInteger(gymId)
      ? db.prepare('SELECT role FROM gym_staff WHERE gym_id = ? AND user_id = ?').get(gymId, request.account.id)
      : null;
    // Salon var mı yok mu bilgisi sızmasın: yetkisizse de 404 döner
    if (!staff) return reply.code(404).send({ error: 'Salon bulunamadı.' });
    request.gymId = gymId;
    request.role = staff.role;
  });

  const ownerOnly = async (request, reply) => {
    if (request.role !== 'owner') {
      return reply.code(403).send({ error: 'Bu işlem için salon sahibi yetkisi gerekir.' });
    }
  };

  const userName = (userId) => db.prepare('SELECT name FROM users WHERE id = ?').get(userId)?.name ?? null;
  const ownerCount = (gymId) =>
    db.prepare("SELECT COUNT(*) AS n FROM gym_staff WHERE gym_id = ? AND role = 'owner'").get(gymId).n;

  app.get('/', async (request) => {
    const { gymId, role } = request;
    const gym = db.prepare('SELECT id, name FROM gyms WHERE id = ?').get(gymId);
    const now = new Date();
    const since = new Date(now.getTime() - DAY_MS).toISOString();
    const gates = db.prepare('SELECT id FROM gates WHERE gym_id = ?').all(gymId);
    return {
      ...gym,
      role,
      stats: {
        activeMembers: db
          .prepare(
            `SELECT COUNT(DISTINCT ms.user_id) AS n
               FROM memberships ms JOIN gym_members gm ON gm.gym_id = ms.gym_id AND gm.user_id = ms.user_id
              WHERE ms.gym_id = ? AND gm.active = 1 AND ms.starts_at <= ? AND ms.ends_at >= ?`,
          )
          .get(gymId, now.toISOString(), now.toISOString()).n,
        totalMembers: db.prepare('SELECT COUNT(*) AS n FROM gym_members WHERE gym_id = ?').get(gymId).n,
        entriesLast24h: db
          .prepare('SELECT COUNT(*) AS n FROM entries WHERE gym_id = ? AND allowed = 1 AND at >= ?')
          .get(gymId, since).n,
        gatesOnline: gates.filter((g) => hub.isOnline(g.id)).length,
        gatesTotal: gates.length,
      },
    };
  });

  // ---- Paketler (fiyat ve süre belirleme yalnızca sahipte) ----

  app.get('/plans', async (request) =>
    db
      .prepare('SELECT id, name, days, price_cents AS priceCents FROM plans WHERE gym_id = ? ORDER BY days, id')
      .all(request.gymId),
  );

  const planBody = {
    type: 'object',
    properties: {
      name: nameSchema,
      days: { type: 'integer', minimum: 1, maximum: 3660 },
      priceCents: { type: 'integer', minimum: 0, maximum: 100_000_000 },
    },
  };

  app.post(
    '/plans',
    { preHandler: ownerOnly, schema: { body: { ...planBody, required: ['name', 'days'] } } },
    async (request, reply) => {
      const { name, days, priceCents = 0 } = request.body;
      const info = db
        .prepare('INSERT INTO plans (gym_id, name, days, price_cents) VALUES (?, ?, ?, ?)')
        .run(request.gymId, name.trim(), days, priceCents);
      const id = Number(info.lastInsertRowid);
      audit(db, request, 'plan.create', { targetType: 'plan', targetId: id, details: { name: name.trim(), days, priceCents } });
      return reply.code(201).send({ id, name: name.trim(), days, priceCents });
    },
  );

  // Paket değişikliği, daha önce satılmış üyeliklerin tarihlerini etkilemez
  app.patch(
    '/plans/:planId',
    { preHandler: ownerOnly, schema: { body: { ...planBody, additionalProperties: false } } },
    async (request, reply) => {
      const plan = db
        .prepare('SELECT * FROM plans WHERE id = ? AND gym_id = ?')
        .get(Number(request.params.planId), request.gymId);
      if (!plan) return reply.code(404).send({ error: 'Paket bulunamadı.' });
      const { name = plan.name, days = plan.days, priceCents = plan.price_cents } = request.body;
      db.prepare('UPDATE plans SET name = ?, days = ?, price_cents = ? WHERE id = ?').run(name.trim(), days, priceCents, plan.id);
      audit(db, request, 'plan.update', {
        targetType: 'plan',
        targetId: plan.id,
        details: { name: name.trim(), days, priceCents, before: { name: plan.name, days: plan.days, priceCents: plan.price_cents } },
      });
      return { id: plan.id, name: name.trim(), days, priceCents };
    },
  );

  // ---- Üyeler ----

  app.get('/members', async (request) => {
    const iso = new Date().toISOString();
    return db
      .prepare(
        `SELECT u.id, u.name, u.email, u.phone, gm.active,
                (SELECT MAX(ends_at) FROM memberships ms WHERE ms.gym_id = gm.gym_id AND ms.user_id = u.id) AS membershipEndsAt,
                EXISTS (SELECT 1 FROM memberships ms WHERE ms.gym_id = gm.gym_id AND ms.user_id = u.id
                         AND ms.starts_at <= ? AND ms.ends_at >= ?) AS hasActiveMembership,
                (SELECT MAX(e.at) FROM entries e WHERE e.gym_id = gm.gym_id AND e.user_id = u.id AND e.allowed = 1) AS lastVisitAt
           FROM gym_members gm JOIN users u ON u.id = gm.user_id
          WHERE gm.gym_id = ? ORDER BY u.name`,
      )
      .all(iso, iso, request.gymId)
      .map((m) => ({ ...m, active: Boolean(m.active), hasActiveMembership: Boolean(m.hasActiveMembership) }));
  });

  // Üye detayı: bilgiler, üyelik geçmişi ve giriş istatistikleri (günlere göre döküm için
  // GET /entries?userId=... kullanılır).
  app.get('/members/:userId', async (request, reply) => {
    const { gymId } = request;
    const userId = Number(request.params.userId);
    const member = db
      .prepare(
        `SELECT u.id, u.name, u.email, u.phone, gm.active, gm.created_at AS joinedAt
           FROM gym_members gm JOIN users u ON u.id = gm.user_id
          WHERE gm.gym_id = ? AND gm.user_id = ?`,
      )
      .get(gymId, userId);
    if (!member) return reply.code(404).send({ error: 'Üye bulunamadı.' });

    const nowIso = new Date().toISOString();
    // `assignedAt`: paketin tanımlandığı an. Üst üste tanımlanan paketler bir öncekinin bitişinden sonra
    // başladığı için "başlangıç" yerine bu tarih ve bitiş gösterilir.
    const memberships = db
      .prepare(
        `SELECT ms.id, p.name AS plan, ms.starts_at AS assignedAt, ms.ends_at AS endsAt
           FROM memberships ms JOIN plans p ON p.id = ms.plan_id
          WHERE ms.gym_id = ? AND ms.user_id = ? ORDER BY ms.id DESC`,
      )
      .all(gymId, userId)
      .map((ms) => ({ ...ms, status: ms.endsAt >= nowIso ? 'active' : 'ended' }));

    const since30 = new Date(Date.now() - 30 * DAY_MS).toISOString();
    const stats = db
      .prepare(
        `SELECT COALESCE(SUM(allowed), 0) AS visits,
                COALESCE(SUM(CASE WHEN allowed = 1 AND at >= ? THEN 1 ELSE 0 END), 0) AS visitsLast30,
                COALESCE(SUM(1 - allowed), 0) AS denied,
                MAX(CASE WHEN allowed = 1 THEN at END) AS lastVisitAt
           FROM entries WHERE gym_id = ? AND user_id = ?`,
      )
      .get(since30, gymId, userId);

    return { ...member, active: Boolean(member.active), memberships, stats };
  });

  // E-posta sistemde varsa o kişi salona bağlanır (hesabı ve şifresi değişmez);
  // yoksa yeni hesap açılır ve ilk şifreyi salon belirler.
  app.post(
    '/members',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string', minLength: 3, maxLength: 200 },
            name: nameSchema,
            phone: { type: 'string', maxLength: 30 },
            password: { type: 'string', minLength: 8, maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      const { gymId } = request;
      const email = normalizeEmail(request.body.email);
      const { name, phone = null, password } = request.body;

      const result = transaction(db, () => {
        let user = db.prepare('SELECT id, name FROM users WHERE email = ?').get(email);
        let created = false;
        if (!user) {
          if (!name || !password) return { error: 'Yeni üye için ad ve en az 8 karakterli şifre gerekli.' };
          const id = Number(
            db
              .prepare('INSERT INTO users (name, email, phone, password_hash) VALUES (?, ?, ?, ?)')
              .run(name.trim(), email, phone, hashPassword(password)).lastInsertRowid,
          );
          user = { id, name: name.trim() };
          created = true;
        }
        if (db.prepare('SELECT 1 FROM gym_members WHERE gym_id = ? AND user_id = ?').get(gymId, user.id)) {
          return { conflict: true };
        }
        db.prepare('INSERT INTO gym_members (gym_id, user_id) VALUES (?, ?)').run(gymId, user.id);
        return { id: user.id, name: user.name, created };
      });

      if (result.error) return reply.code(400).send({ error: result.error });
      if (result.conflict) return reply.code(409).send({ error: 'Bu kişi zaten salonunuzun üyesi.' });
      audit(db, request, 'member.add', {
        targetType: 'member',
        targetId: result.id,
        details: { name: result.name, email, newAccount: result.created },
      });
      return reply.code(201).send(result);
    },
  );

  app.patch(
    '/members/:userId',
    { schema: { body: { type: 'object', required: ['active'], additionalProperties: false, properties: { active: { type: 'boolean' } } } } },
    async (request, reply) => {
      const userId = Number(request.params.userId);
      const info = db
        .prepare('UPDATE gym_members SET active = ? WHERE gym_id = ? AND user_id = ?')
        .run(request.body.active ? 1 : 0, request.gymId, userId);
      if (info.changes === 0) return reply.code(404).send({ error: 'Üye bulunamadı.' });
      audit(db, request, request.body.active ? 'member.enable' : 'member.disable', {
        targetType: 'member',
        targetId: userId,
        details: { name: userName(userId) },
      });
      return { id: userId, active: request.body.active };
    },
  );

  app.post(
    '/members/:userId/memberships',
    { schema: { body: { type: 'object', required: ['planId'], properties: { planId: { type: 'integer' } } } } },
    async (request, reply) => {
      const { gymId } = request;
      const userId = Number(request.params.userId);
      const linked = db.prepare('SELECT 1 FROM gym_members WHERE gym_id = ? AND user_id = ?').get(gymId, userId);
      const plan = db.prepare('SELECT * FROM plans WHERE id = ? AND gym_id = ?').get(request.body.planId, gymId);
      if (!linked || !plan) return reply.code(404).send({ error: 'Üye veya paket bulunamadı.' });

      // Süresi devam eden üyelik varsa yeni paket bitişinden itibaren başlar
      const now = new Date();
      const latest = db
        .prepare('SELECT MAX(ends_at) AS ends_at FROM memberships WHERE gym_id = ? AND user_id = ?')
        .get(gymId, userId);
      const start = latest.ends_at && Date.parse(latest.ends_at) > now.getTime() ? new Date(latest.ends_at) : now;
      const end = new Date(start.getTime() + plan.days * DAY_MS);
      const info = db
        .prepare('INSERT INTO memberships (gym_id, user_id, plan_id, starts_at, ends_at) VALUES (?, ?, ?, ?, ?)')
        .run(gymId, userId, plan.id, now.toISOString(), end.toISOString());
      audit(db, request, 'membership.assign', {
        targetType: 'member',
        targetId: userId,
        details: { name: userName(userId), plan: plan.name, endsAt: end.toISOString() },
      });
      return reply.code(201).send({ id: Number(info.lastInsertRowid), endsAt: end.toISOString() });
    },
  );

  // ---- Giriş kayıtları ----

  // Tarih aralığı: `from` dahil, `to` hariç (ISO zaman damgası). Gün sınırlarını istemci kendi
  // saat diliminde hesaplayıp gönderir; sunucu yalnızca anlık zamanlarla çalışır.
  const rangeQuery = {
    from: { type: 'string', format: 'date-time' },
    to: { type: 'string', format: 'date-time' },
    result: { type: 'string', enum: ['all', 'allowed', 'denied'] },
  };
  const MAX_RANGE_DAYS = 400;

  /** Sorgu parametrelerini doğrular; { from, to, resultSql } ya da { error } döner. */
  function parseRange(query) {
    const from = query.from ? new Date(query.from) : new Date(0);
    const to = query.to ? new Date(query.to) : new Date(Date.now() + DAY_MS);
    if (!(from < to)) return { error: 'Başlangıç, bitişten önce olmalı.' };
    // Üst sınır yalnızca iki uç da verildiyse uygulanır; parametresiz çağrı "tüm kayıtlar"dır
    if (query.from && query.to && to - from > MAX_RANGE_DAYS * DAY_MS) {
      return { error: `En fazla ${MAX_RANGE_DAYS} günlük aralık seçilebilir.` };
    }
    const resultSql = query.result === 'allowed' ? ' AND e.allowed = 1' : query.result === 'denied' ? ' AND e.allowed = 0' : '';
    return { from: from.toISOString(), to: to.toISOString(), resultSql };
  }

  app.get(
    '/entries',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            ...rangeQuery,
            userId: { type: 'integer', minimum: 1 }, // yalnızca bu üyenin kayıtları
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
            offset: { type: 'integer', minimum: 0, default: 0 },
          },
        },
      },
    },
    async (request, reply) => {
      const range = parseRange(request.query);
      if (range.error) return reply.code(400).send({ error: range.error });
      const { userId, limit, offset } = request.query;
      return db
        .prepare(
          `SELECT e.id, e.at, e.allowed, e.reason, e.gate_id AS gateId, g.name AS gateName,
                  u.id AS userId, u.name AS memberName
             FROM entries e
             JOIN users u ON u.id = e.user_id
             LEFT JOIN gates g ON g.id = e.gate_id
            WHERE e.gym_id = ? AND e.at >= ? AND e.at < ?${range.resultSql}${userId ? ' AND e.user_id = ?' : ''}
            ORDER BY e.at DESC, e.id DESC LIMIT ? OFFSET ?`,
        )
        .all(request.gymId, range.from, range.to, ...(userId ? [userId] : []), limit, offset)
        .map((e) => ({ ...e, allowed: Boolean(e.allowed) }));
    },
  );

  // Seçilen aralığın özeti ve gün gün dağılımı. `tzOffsetMinutes`: istemcinin UTC'ye farkı
  // (Türkiye için 180); günler bu farka göre gruplanır.
  app.get(
    '/entries/summary',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['from', 'to'], // gün gün döküm için sınırlı bir aralık şart
          properties: { ...rangeQuery, tzOffsetMinutes: { type: 'integer', minimum: -840, maximum: 840, default: 0 } },
        },
      },
    },
    async (request, reply) => {
      const range = parseRange(request.query);
      if (range.error) return reply.code(400).send({ error: range.error });
      const { tzOffsetMinutes } = request.query;
      const modifier = `${tzOffsetMinutes >= 0 ? '+' : '-'}${Math.abs(tzOffsetMinutes)} minutes`;

      const totals = db
        .prepare(
          `SELECT COALESCE(SUM(e.allowed), 0) AS allowed,
                  COALESCE(SUM(1 - e.allowed), 0) AS denied,
                  COUNT(DISTINCT CASE WHEN e.allowed = 1 THEN e.user_id END) AS uniqueMembers
             FROM entries e WHERE e.gym_id = ? AND e.at >= ? AND e.at < ?`,
        )
        .get(request.gymId, range.from, range.to);
      const byDay = db
        .prepare(
          `SELECT strftime('%Y-%m-%d', datetime(e.at, ?)) AS day,
                  SUM(e.allowed) AS allowed, SUM(1 - e.allowed) AS denied
             FROM entries e WHERE e.gym_id = ? AND e.at >= ? AND e.at < ?
            GROUP BY day ORDER BY day`,
        )
        .all(modifier, request.gymId, range.from, range.to);
      return { ...totals, total: totals.allowed + totals.denied, byDay };
    },
  );

  // Excel'de açılan CSV dökümü (yalnızca sahip: toplu kişisel veri çıkışıdır ve denetim kaydına yazılır).
  // Kayıtlar kronolojik (eskiden yeniye) sıralanır; tarih ve saat istemcinin saat dilimindedir.
  const MAX_EXPORT_ROWS = config.maxExportRows;
  app.get(
    '/entries/export',
    {
      preHandler: ownerOnly,
      schema: {
        querystring: {
          type: 'object',
          required: ['from', 'to'],
          properties: { ...rangeQuery, tzOffsetMinutes: { type: 'integer', minimum: -840, maximum: 840, default: 0 } },
        },
      },
    },
    async (request, reply) => {
      const range = parseRange(request.query);
      if (range.error) return reply.code(400).send({ error: range.error });
      const { tzOffsetMinutes } = request.query;

      const where = 'e.gym_id = ? AND e.at >= ? AND e.at < ?' + range.resultSql;
      const { n: count } = db.prepare(`SELECT COUNT(*) AS n FROM entries e WHERE ${where}`).get(request.gymId, range.from, range.to);
      if (count > MAX_EXPORT_ROWS) {
        return reply.code(400).send({
          error: `Seçilen aralıkta ${count} kayıt var; en fazla ${MAX_EXPORT_ROWS} kayıt indirilebilir. Aralığı daraltın.`,
        });
      }

      const rows = db
        .prepare(
          `SELECT e.at, e.allowed, e.reason, e.gate_id AS gateId, g.name AS gateName, u.name AS memberName, u.email
             FROM entries e
             JOIN users u ON u.id = e.user_id
             LEFT JOIN gates g ON g.id = e.gate_id
            WHERE ${where} ORDER BY e.at ASC, e.id ASC`,
        )
        .all(request.gymId, range.from, range.to);

      const csv = toCsv(
        ['Tarih', 'Saat', 'Üye', 'E-posta', 'Kapı', 'Sonuç', 'Neden'],
        rows.map((e) => {
          const when = localParts(e.at, tzOffsetMinutes);
          return [
            when.date,
            when.time,
            e.memberName,
            e.email,
            e.gateName ?? e.gateId,
            e.allowed ? 'Geçti' : 'Reddedildi',
            e.allowed ? '' : (REASON_TEXT[e.reason] ?? e.reason ?? ''),
          ];
        }),
      );

      const firstDay = localParts(range.from, tzOffsetMinutes).key;
      const lastDay = localParts(new Date(Date.parse(range.to) - 1).toISOString(), tzOffsetMinutes).key;
      audit(db, request, 'entries.export', { targetType: 'entries', details: { from: firstDay, to: lastDay, result: request.query.result ?? 'all', count } });

      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="giris-kayitlari_${firstDay}_${lastDay}.csv"`)
        .header('x-row-count', String(count));
      return csv;
    },
  );

  // ---- Kapılar (oluşturma, anahtar yenileme ve silme yalnızca sahipte) ----

  const GATE_COLUMNS = 'id, name, offline_policy AS offlinePolicy, offline_grace_seconds AS offlineGraceSeconds';

  // "İnternet kesilirse": open = bekleme süresi sonunda kapı serbest geçişe açılır, closed = kapalı kalır
  const offlineProps = {
    offlinePolicy: { type: 'string', enum: ['open', 'closed'] },
    offlineGraceSeconds: { type: 'integer', minimum: 0, maximum: 3600 },
  };

  app.get('/gates', async (request) =>
    db
      .prepare(`SELECT ${GATE_COLUMNS} FROM gates WHERE gym_id = ? ORDER BY name`)
      .all(request.gymId)
      .map((g) => ({ ...g, online: hub.isOnline(g.id) })),
  );

  // Kapının bildirdiği çevrimdışı serbest geçiş dönemleri (en yeni üstte)
  app.get(
    '/gates/events',
    { schema: { querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } } } } },
    async (request) =>
      db
        .prepare(
          `SELECT e.id, e.gate_id AS gateId, g.name AS gateName, e.kind, e.started_at AS startedAt,
                  e.ended_at AS endedAt, e.clock_suspect AS clockSuspect, e.created_at AS reportedAt
             FROM gate_events e LEFT JOIN gates g ON g.id = e.gate_id
            WHERE e.gym_id = ? ORDER BY e.id DESC LIMIT ?`,
        )
        .all(request.gymId, request.query.limit)
        .map((e) => ({
          ...e,
          clockSuspect: Boolean(e.clockSuspect),
          durationSeconds: Math.round((Date.parse(e.endedAt) - Date.parse(e.startedAt)) / 1000),
        })),
  );

  app.post(
    '/gates',
    {
      preHandler: ownerOnly,
      schema: { body: { type: 'object', required: ['name'], properties: { name: nameSchema, ...offlineProps } } },
    },
    async (request, reply) => {
      const id = `g_${randomBytes(5).toString('hex')}`;
      const key = newGateKey();
      const name = request.body.name.trim();
      const { offlinePolicy = 'open', offlineGraceSeconds = 30 } = request.body;
      db.prepare(
        'INSERT INTO gates (id, gym_id, name, key_hash, offline_policy, offline_grace_seconds) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id, request.gymId, name, hashGateKey(key), offlinePolicy, offlineGraceSeconds);
      audit(db, request, 'gate.create', { targetType: 'gate', targetId: id, details: { name, offlinePolicy, offlineGraceSeconds } });
      // Anahtar yalnızca burada gösterilir, sunucuda sadece özeti saklanır
      return reply.code(201).send({ id, name, key, offlinePolicy, offlineGraceSeconds });
    },
  );

  const findGate = (request) =>
    db.prepare(`SELECT ${GATE_COLUMNS} FROM gates WHERE id = ? AND gym_id = ?`).get(request.params.gateId, request.gymId);

  // İnternet yokken kapı ayarı. Kapı bağlıysa yeni ayar hemen iletilir; çevrimdışıysa bir sonraki bağlanışında öğrenir.
  app.patch(
    '/gates/:gateId',
    { preHandler: ownerOnly, schema: { body: { type: 'object', additionalProperties: false, minProperties: 1, properties: offlineProps } } },
    async (request, reply) => {
      const gate = findGate(request);
      if (!gate) return reply.code(404).send({ error: 'Kapı bulunamadı.' });
      const { offlinePolicy = gate.offlinePolicy, offlineGraceSeconds = gate.offlineGraceSeconds } = request.body;
      db.prepare('UPDATE gates SET offline_policy = ?, offline_grace_seconds = ? WHERE id = ?').run(offlinePolicy, offlineGraceSeconds, gate.id);
      hub.send(gate.id, { type: 'config', offlinePolicy, offlineGraceSeconds });
      audit(db, request, 'gate.update', {
        targetType: 'gate',
        targetId: gate.id,
        details: {
          name: gate.name,
          offlinePolicy,
          offlineGraceSeconds,
          before: { offlinePolicy: gate.offlinePolicy, offlineGraceSeconds: gate.offlineGraceSeconds },
        },
      });
      return { id: gate.id, name: gate.name, offlinePolicy, offlineGraceSeconds };
    },
  );

  // Kapı cihazı çalındı veya anahtar sızdı: yeni anahtar üretilir, eskisiyle bağlı cihaz hemen düşer
  app.post('/gates/:gateId/rotate-key', { preHandler: ownerOnly }, async (request, reply) => {
    const gate = findGate(request);
    if (!gate) return reply.code(404).send({ error: 'Kapı bulunamadı.' });
    const key = newGateKey();
    db.prepare('UPDATE gates SET key_hash = ? WHERE id = ?').run(hashGateKey(key), gate.id);
    hub.disconnect(gate.id, 'key rotated');
    audit(db, request, 'gate.rotate_key', { targetType: 'gate', targetId: gate.id, details: { name: gate.name } });
    return { id: gate.id, name: gate.name, key, offlinePolicy: gate.offlinePolicy, offlineGraceSeconds: gate.offlineGraceSeconds };
  });

  app.delete('/gates/:gateId', { preHandler: ownerOnly }, async (request, reply) => {
    const gate = findGate(request);
    if (!gate) return reply.code(404).send({ error: 'Kapı bulunamadı.' });
    db.prepare('DELETE FROM gates WHERE id = ?').run(gate.id);
    hub.disconnect(gate.id, 'deleted');
    audit(db, request, 'gate.delete', { targetType: 'gate', targetId: gate.id, details: { name: gate.name } });
    return { ok: true };
  });

  // Resepsiyondan elle kapı açma (unutulan telefon, arıza vb.)
  app.post('/gates/:gateId/open', async (request, reply) => {
    const gate = findGate(request);
    if (!gate) return reply.code(404).send({ error: 'Kapı bulunamadı.' });
    if (!hub.send(gate.id, { type: 'open', name: 'Resepsiyon' })) {
      return reply.code(503).send({ error: 'Kapı çevrimdışı.' });
    }
    audit(db, request, 'gate.open', { targetType: 'gate', targetId: gate.id, details: { name: gate.name } });
    return { ok: true };
  });

  // ---- Çalışanlar (yalnızca sahip) ----

  const roleSchema = { type: 'string', enum: ['owner', 'staff'] };

  app.get('/staff', { preHandler: ownerOnly }, async (request) =>
    db
      .prepare(
        `SELECT u.id AS userId, u.name, u.email, s.role
           FROM gym_staff s JOIN users u ON u.id = s.user_id
          WHERE s.gym_id = ?
          ORDER BY CASE s.role WHEN 'owner' THEN 0 ELSE 1 END, u.name`,
      )
      .all(request.gymId),
  );

  // E-posta sistemde varsa o kişi çalışan olarak bağlanır (hesabı ve şifresi değişmez);
  // yoksa yeni hesap açılır ve ilk şifreyi sahip belirler.
  app.post(
    '/staff',
    {
      preHandler: ownerOnly,
      schema: {
        body: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string', minLength: 3, maxLength: 200 },
            role: roleSchema,
            name: nameSchema,
            password: { type: 'string', minLength: 8, maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      const { gymId } = request;
      const email = normalizeEmail(request.body.email);
      const { role = 'staff', name, password } = request.body;

      const result = transaction(db, () => {
        let user = db.prepare('SELECT id, name FROM users WHERE email = ?').get(email);
        let created = false;
        if (!user) {
          if (!name || !password) return { error: 'Yeni çalışan için ad ve en az 8 karakterli şifre gerekli.' };
          const id = Number(
            db
              .prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
              .run(name.trim(), email, hashPassword(password)).lastInsertRowid,
          );
          user = { id, name: name.trim() };
          created = true;
        }
        if (db.prepare('SELECT 1 FROM gym_staff WHERE gym_id = ? AND user_id = ?').get(gymId, user.id)) {
          return { conflict: true };
        }
        db.prepare('INSERT INTO gym_staff (gym_id, user_id, role) VALUES (?, ?, ?)').run(gymId, user.id, role);
        return { userId: user.id, name: user.name, role, created };
      });

      if (result.error) return reply.code(400).send({ error: result.error });
      if (result.conflict) return reply.code(409).send({ error: 'Bu kişi zaten salonun çalışanı.' });
      audit(db, request, 'staff.add', {
        targetType: 'staff',
        targetId: result.userId,
        details: { name: result.name, email, role, newAccount: result.created },
      });
      return reply.code(201).send(result);
    },
  );

  app.patch(
    '/staff/:userId',
    { preHandler: ownerOnly, schema: { body: { type: 'object', required: ['role'], additionalProperties: false, properties: { role: roleSchema } } } },
    async (request, reply) => {
      const { gymId } = request;
      const userId = Number(request.params.userId);
      const target = db.prepare('SELECT role FROM gym_staff WHERE gym_id = ? AND user_id = ?').get(gymId, userId);
      if (!target) return reply.code(404).send({ error: 'Çalışan bulunamadı.' });
      if (target.role === 'owner' && request.body.role !== 'owner' && ownerCount(gymId) <= 1) {
        return reply.code(400).send({ error: 'Salonun en az bir sahibi olmalı.' });
      }
      db.prepare('UPDATE gym_staff SET role = ? WHERE gym_id = ? AND user_id = ?').run(request.body.role, gymId, userId);
      audit(db, request, 'staff.role', {
        targetType: 'staff',
        targetId: userId,
        details: { name: userName(userId), from: target.role, to: request.body.role },
      });
      return { userId, role: request.body.role };
    },
  );

  app.delete('/staff/:userId', { preHandler: ownerOnly }, async (request, reply) => {
    const { gymId } = request;
    const userId = Number(request.params.userId);
    const target = db.prepare('SELECT role FROM gym_staff WHERE gym_id = ? AND user_id = ?').get(gymId, userId);
    if (!target) return reply.code(404).send({ error: 'Çalışan bulunamadı.' });
    if (target.role === 'owner' && ownerCount(gymId) <= 1) {
      return reply.code(400).send({ error: 'Salonun en az bir sahibi olmalı.' });
    }
    db.prepare('DELETE FROM gym_staff WHERE gym_id = ? AND user_id = ?').run(gymId, userId);
    audit(db, request, 'staff.remove', { targetType: 'staff', targetId: userId, details: { name: userName(userId) } });
    return { ok: true };
  });

  // ---- Denetim kaydı (yalnızca sahip) ----

  app.get('/audit', { preHandler: ownerOnly }, async (request) => {
    const limit = Math.min(Number(request.query.limit) || 100, 500);
    return db
      .prepare(
        `SELECT a.id, a.at, a.action, a.target_type AS targetType, a.target_id AS targetId, a.details,
                u.name AS actorName
           FROM audit_log a JOIN users u ON u.id = a.user_id
          WHERE a.gym_id = ? ORDER BY a.id DESC LIMIT ?`,
      )
      .all(request.gymId, limit)
      .map((row) => ({ ...row, details: row.details ? JSON.parse(row.details) : null }));
  });
}
