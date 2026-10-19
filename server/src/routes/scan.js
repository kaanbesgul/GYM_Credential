import { DAY_MS, currentMembership } from '../membership.js';
import { limit, setupRateLimit } from '../rateLimit.js';
import { verifyGateKey } from '../security.js';

function logEntry(db, { gymId, userId, gateId, allowed, reason }) {
  db.prepare('INSERT INTO entries (gym_id, user_id, gate_id, at, allowed, reason) VALUES (?, ?, ?, ?, ?, ?)').run(
    gymId,
    userId,
    gateId,
    new Date().toISOString(),
    allowed ? 1 : 0,
    reason ?? null,
  );
}

export default async function scanRoutes(app, { db, hub, config }) {
  await setupRateLimit(app, config);

  // Üye telefonundan: kapıdaki QR okutulur. Hangi salon olduğu QR'daki kapıdan bulunur.
  app.post(
    '/api/scan',
    {
      // Aynı salon Wi-Fi'sindeki telefonlar tek IP'den çıkabilir; bu yüzden oturum anahtarı başına sayılır
      ...limit(config, 'scan', { keyGenerator: (request) => request.headers.authorization ?? request.ip }),
      preHandler: app.authenticate,
      schema: {
        body: {
          type: 'object',
          required: ['code'],
          properties: { code: { type: 'string', maxLength: 200 } },
        },
      },
    },
    async (request, reply) => {
      const user = request.account;
      const scanned = hub.consume(request.body.code);
      if (!scanned.ok) {
        return reply.code(400).send({
          ok: false,
          reason: 'invalid_code',
          message: 'QR kod geçersiz veya süresi dolmuş. Ekrandaki güncel kodu okutun.',
        });
      }
      const { gateId } = scanned;
      const gate = db
        .prepare('SELECT g.gym_id AS gymId, y.name AS gymName FROM gates g JOIN gyms y ON y.id = g.gym_id WHERE g.id = ?')
        .get(gateId);
      const { gymId, gymName } = gate;

      const deny = (status, reason, message) => {
        logEntry(db, { gymId, userId: user.id, gateId, allowed: false, reason });
        hub.send(gateId, { type: 'deny', name: user.name, message });
        return reply.code(status).send({ ok: false, reason, message, gymName });
      };

      const link = db.prepare('SELECT active FROM gym_members WHERE gym_id = ? AND user_id = ?').get(gymId, user.id);
      if (!link) return deny(403, 'not_a_member', `${gymName} salonunun üyesi değilsiniz.`);
      if (!link.active) return deny(403, 'member_disabled', 'Bu salondaki üyeliğiniz devre dışı bırakılmış.');

      const ms = currentMembership(db, gymId, user.id);
      if (!ms) return deny(403, 'no_active_membership', 'Aktif üyeliğiniz bulunmuyor.');

      const last = db
        .prepare('SELECT at FROM entries WHERE gym_id = ? AND user_id = ? AND allowed = 1 ORDER BY id DESC LIMIT 1')
        .get(gymId, user.id);
      if (last && Date.now() - Date.parse(last.at) < config.antiPassbackMs) {
        return deny(429, 'recent_entry', 'Az önce giriş yaptınız. Biraz bekleyin.');
      }

      if (!hub.send(gateId, { type: 'open', name: user.name })) {
        return deny(503, 'gate_offline', 'Kapı şu an yanıt vermiyor.');
      }

      logEntry(db, { gymId, userId: user.id, gateId, allowed: true });
      return {
        ok: true,
        message: `Hoş geldin ${user.name}!`,
        gymName,
        membership: { plan: ms.plan_name, endsAt: ms.ends_at },
      };
    },
  );

  /**
   * Kapının "internet yokken serbest geçiş" dönemi raporunu kaydeder. Kapının saati internet
   * olmadan sapabileceği (Pi'de pil yok) için zamanlar makul aralıkta değilse kayıt "saat
   * doğrulanamadı" işaretiyle yine saklanır; rapor sessizce kaybolmasın.
   */
  function storeOfflineReport(gate, msg) {
    const id = typeof msg.id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(msg.id) ? msg.id : null;
    const from = Date.parse(msg.from);
    const to = Date.parse(msg.to);
    if (!id || !Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 400 * DAY_MS) {
      return { id, stored: false };
    }
    const now = Date.now();
    const suspect = to > now + 10 * 60_000 || from < now - 90 * DAY_MS ? 1 : 0;
    // report_id benzersiz: Pi aynı raporu yeniden gönderirse ikinci kayıt oluşmaz
    db.prepare(
      `INSERT OR IGNORE INTO gate_events (gym_id, gate_id, kind, started_at, ended_at, clock_suspect, report_id, created_at)
       VALUES (?, ?, 'offline_open', ?, ?, ?, ?, ?)`,
    ).run(gate.gym_id, gate.id, new Date(from).toISOString(), new Date(to).toISOString(), suspect, id, new Date(now).toISOString());
    return { id, stored: true };
  }

  // Kapı cihazı (Raspberry Pi) bağlantısı
  app.get('/ws/gate', { websocket: true, ...limit(config, 'gate') }, (socket) => {
    let gateId = null;
    let gateRow = null;
    // Kimlik doğrulaması yapmayan bağlantıyı kısa sürede kapat
    const authTimeout = setTimeout(() => {
      if (!gateId) socket.close(4001, 'auth timeout');
    }, 5000);

    socket.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return socket.close(4002, 'bad message');
      }

      if (!gateId) {
        if (msg.type !== 'hello' || typeof msg.gateId !== 'string' || typeof msg.key !== 'string') {
          return socket.close(4003, 'hello expected');
        }
        const gate = db.prepare('SELECT * FROM gates WHERE id = ?').get(msg.gateId);
        if (!gate || !verifyGateKey(msg.key, gate.key_hash)) {
          return socket.close(4003, 'unauthorized');
        }
        gateId = gate.id;
        gateRow = gate;
        clearTimeout(authTimeout);
        // Pi "internet yokken" ayarını buradan öğrenir ve dosyada saklar (çevrimdışı açılışta da bilsin)
        socket.send(
          JSON.stringify({
            type: 'hello_ok',
            name: gate.name,
            offlinePolicy: gate.offline_policy,
            offlineGraceSeconds: gate.offline_grace_seconds,
          }),
        );
        hub.register(gateId, socket);
      } else if (msg.type === 'offline_report') {
        const { id, stored } = storeOfflineReport(gateRow, msg);
        // Geçerli de olsa geçersiz de olsa onaylanır ki Pi aynı raporu sonsuza dek yeniden denemesin
        if (id) socket.send(JSON.stringify({ type: 'offline_report_ack', id, rejected: !stored }));
      }
    });

    socket.on('close', () => {
      clearTimeout(authTimeout);
      if (gateId) hub.unregister(gateId, socket);
    });
  });
}
