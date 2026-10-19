import { audit } from '../audit.js';
import { transaction } from '../db.js';
import { createGym, staffGyms } from '../gyms.js';
import { currentMembership, daysLeft, latestMembership } from '../membership.js';
import { limit, setupRateLimit } from '../rateLimit.js';
import { hashPassword, verifyPassword } from '../security.js';

export function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

const passwordSchema = { type: 'string', minLength: 8, maxLength: 200 };
const emailSchema = { type: 'string', minLength: 3, maxLength: 200 };
const nameSchema = { type: 'string', minLength: 1, maxLength: 100 };

export default async function authRoutes(app, { db, config }) {
  await setupRateLimit(app, config);

  app.post(
    '/api/auth/login',
    {
      ...limit(config, 'login'),
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: { email: { type: 'string', maxLength: 200 }, password: { type: 'string', maxLength: 200 } },
        },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body;
      const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizeEmail(email));

      // Art arda hatalı girişten sonra hesap kısa süre kilitlenir (şifre deneme saldırısına karşı)
      if (user?.locked_until && Date.parse(user.locked_until) > Date.now()) {
        const minutes = Math.ceil((Date.parse(user.locked_until) - Date.now()) / 60_000);
        return reply.code(429).send({
          error: `Çok fazla hatalı deneme. Hesap geçici olarak kilitlendi, yaklaşık ${minutes} dakika sonra tekrar deneyin.`,
        });
      }

      // Kullanıcı yoksa da hash hesaplanır; yanıt süresinden hesap varlığı anlaşılmasın
      const ok = verifyPassword(password, user?.password_hash ?? hashPassword('x'));
      if (!user || !ok || !user.active) {
        if (user) {
          const failures = user.failed_logins + 1;
          if (failures >= config.lockoutMaxFailures) {
            db.prepare('UPDATE users SET failed_logins = 0, locked_until = ? WHERE id = ?').run(
              new Date(Date.now() + config.lockoutMs).toISOString(),
              user.id,
            );
          } else {
            db.prepare('UPDATE users SET failed_logins = ? WHERE id = ?').run(failures, user.id);
          }
        }
        return reply.code(401).send({ error: 'E-posta veya şifre hatalı.' });
      }

      if (user.failed_logins > 0 || user.locked_until) {
        db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(user.id);
      }
      return { token: app.issueToken(user), name: user.name, gyms: staffGyms(db, user.id) };
    },
  );

  // Salon sahibi kaydı: hesap + salon + varsayılan paketler
  app.post(
    '/api/auth/signup-gym',
    {
      ...limit(config, 'signup'),
      schema: {
        body: {
          type: 'object',
          required: ['gymName', 'name', 'email', 'password'],
          properties: { gymName: nameSchema, name: nameSchema, email: emailSchema, password: passwordSchema },
        },
      },
    },
    async (request, reply) => {
      const { gymName, name, email, password } = request.body;
      if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(normalizeEmail(email))) {
        return reply.code(409).send({ error: 'Bu e-posta zaten kayıtlı. Giriş yapıp yeni salon ekleyebilirsiniz.' });
      }
      const { account, gymId } = transaction(db, () => {
        const userId = Number(
          db
            .prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
            .run(name.trim(), normalizeEmail(email), hashPassword(password)).lastInsertRowid,
        );
        return {
          account: db.prepare('SELECT * FROM users WHERE id = ?').get(userId),
          gymId: createGym(db, { name: gymName.trim(), ownerUserId: userId }),
        };
      });
      return reply.code(201).send({
        token: app.issueToken(account),
        name: account.name,
        gyms: staffGyms(db, account.id).filter((g) => g.id === gymId),
      });
    },
  );

  // Giriş yapmış kullanıcı ek bir salon açar
  app.post(
    '/api/gyms',
    {
      ...limit(config, 'signup'),
      preHandler: app.authenticate,
      schema: { body: { type: 'object', required: ['name'], properties: { name: nameSchema } } },
    },
    async (request, reply) => {
      const gymId = createGym(db, { name: request.body.name.trim(), ownerUserId: request.account.id });
      audit(db, request, 'gym.create', { gymId, targetType: 'gym', targetId: gymId });
      return reply.code(201).send({ id: gymId, name: request.body.name.trim(), role: 'owner' });
    },
  );

  // Şifre değişince bu hesabın TÜM eski oturum anahtarları geçersiz olur; yenisi döner.
  app.post(
    '/api/auth/change-password',
    {
      ...limit(config, 'password'),
      preHandler: app.authenticate,
      schema: {
        body: {
          type: 'object',
          required: ['currentPassword', 'newPassword'],
          properties: { currentPassword: { type: 'string', maxLength: 200 }, newPassword: passwordSchema },
        },
      },
    },
    async (request, reply) => {
      const { currentPassword, newPassword } = request.body;
      if (!verifyPassword(currentPassword, request.account.password_hash)) {
        return reply.code(400).send({ error: 'Mevcut şifre hatalı.' });
      }
      if (currentPassword === newPassword) {
        return reply.code(400).send({ error: 'Yeni şifre mevcut şifrenizden farklı olmalı.' });
      }
      db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(
        hashPassword(newPassword),
        request.account.id,
      );
      audit(db, request, 'password.change', { gymId: null, targetType: 'user', targetId: request.account.id });
      const account = db.prepare('SELECT * FROM users WHERE id = ?').get(request.account.id);
      return { token: app.issueToken(account) };
    },
  );

  // Tüm cihazlardaki oturumları kapatır (kayıp telefon, paylaşılan bilgisayar)
  app.post('/api/auth/logout-all', { preHandler: app.authenticate }, async (request) => {
    db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(request.account.id);
    audit(db, request, 'session.logout_all', { gymId: null, targetType: 'user', targetId: request.account.id });
    return { ok: true };
  });

  // Üye uygulaması ve web paneli için profil: üye olunan salonlar + çalışılan salonlar
  app.get('/api/me', { preHandler: app.authenticate }, async (request) => {
    const user = request.account;
    const links = db
      .prepare(
        `SELECT gm.gym_id AS gymId, g.name AS gymName, gm.active
           FROM gym_members gm JOIN gyms g ON g.id = gm.gym_id
          WHERE gm.user_id = ? ORDER BY g.name`,
      )
      .all(user.id);

    const memberships = links.map((link) => {
      const current = currentMembership(db, link.gymId, user.id);
      const shown = current ?? latestMembership(db, link.gymId, user.id);
      return {
        gymId: link.gymId,
        gymName: link.gymName,
        enabled: Boolean(link.active),
        active: Boolean(current) && Boolean(link.active),
        plan: shown?.plan_name ?? null,
        endsAt: shown?.ends_at ?? null,
        daysLeft: current ? daysLeft(current.ends_at) : 0,
      };
    });

    return { id: user.id, name: user.name, email: user.email, memberships, gyms: staffGyms(db, user.id) };
  });
}
