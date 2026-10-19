import Fastify from 'fastify';
import fastifyHelmet from '@fastify/helmet';
import fastifyJwt from '@fastify/jwt';
import fastifyWebsocket from '@fastify/websocket';
import { GateHub } from './gateHub.js';
import authRoutes from './routes/auth.js';
import gymAdminRoutes from './routes/gymAdmin.js';
import scanRoutes from './routes/scan.js';

export async function buildApp({ db, config, logger = false, staticDir = null }) {
  const app = Fastify({
    logger,
    trustProxy: config.trustProxy,
    // Şemada additionalProperties:false olan uç noktalar tanımsız alanı sessizce silmesin, 400 dönsün
    // (aksi halde {"name": "..."} gönderen istemci 200 alır ama hiçbir şey değişmez).
    ajv: { customOptions: { removeAdditional: false } },
  });
  const hub = new GateHub({ rotateMs: config.qrRotateMs, ttlMs: config.qrTtlMs });

  // Gövdesiz POST/PATCH/DELETE isteklerini (ör. elle kapı açma) JSON başlığı olsa bile kabul et
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    if (body === '') return done(null, {});
    try {
      done(null, JSON.parse(body));
    } catch {
      const err = new Error('Geçersiz JSON');
      err.statusCode = 400;
      done(err);
    }
  });

  // Güvenlik başlıkları. Panel aynı sunucudan sunulur ve yalnızca kendi dosyalarını yükler;
  // bu yüzden sıkı bir içerik politikası (CSP) uygulanabilir. upgrade-insecure-requests
  // bilerek yok: yerel ağdaki http geliştirme ortamını bozar. HSTS yalnızca HTTPS'te açılır.
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    strictTransportSecurity: config.hsts ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
  });

  // API yanıtları (kişisel veri, oturum) ara belleklerde saklanmasın
  app.addHook('onSend', async (request, reply) => {
    if (request.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
  });

  await app.register(fastifyJwt, { secret: config.jwtSecret, sign: { expiresIn: config.jwtTtl } });
  await app.register(fastifyWebsocket, { options: { maxPayload: 4096 } });

  app.addHook('onClose', async () => {
    hub.close();
    for (const gateId of hub.onlineGateIds()) hub.gates.get(gateId).socket.terminate();
  });

  // Oturum anahtarı üretir. `tv` (token_version) artırılınca eski anahtarlar geçersiz olur.
  app.decorate('issueToken', (account) => app.jwt.sign({ sub: account.id, tv: account.token_version }));

  // Oturumu doğrular; hesabı `request.account` olarak ekler (request.user JWT içeriğidir)
  app.decorate('authenticate', async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Oturum geçersiz, lütfen tekrar giriş yapın.' });
    }
    const account = db.prepare('SELECT * FROM users WHERE id = ?').get(request.user.sub);
    if (!account || !account.active || request.user.tv !== account.token_version) {
      return reply.code(401).send({ error: 'Oturum sona erdi, lütfen tekrar giriş yapın.' });
    }
    request.account = account;
  });

  await app.register(authRoutes, { db, config });
  await app.register(scanRoutes, { db, hub, config });
  await app.register(gymAdminRoutes, { db, hub, config, prefix: '/api/gyms/:gymId' });

  // Web panelinin derlenmiş dosyaları (varsa) aynı sunucudan sunulur
  if (staticDir) {
    const { default: fastifyStatic } = await import('@fastify/static');
    await app.register(fastifyStatic, { root: staticDir });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/') && !request.url.startsWith('/ws/')) {
        return reply.sendFile('index.html'); // tek sayfa uygulaması: bilinmeyen yollar panele düşer
      }
      return reply.code(404).send({ error: 'Bulunamadı.' });
    });
  }

  app.decorate('hub', hub);
  return app;
}
