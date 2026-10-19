import { randomBytes } from 'node:crypto';

try {
  process.loadEnvFile('.env');
} catch {
  // .env yoksa varsayılanlar / ortam değişkenleri kullanılır
}

export function loadConfig(overrides = {}) {
  const env = process.env;
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '0.0.0.0',
    dbPath: env.DB_PATH ?? 'data/gym.db',
    jwtSecret: env.JWT_SECRET ?? randomBytes(32).toString('hex'),
    // Oturum anahtarının ömrü (şifre değişince veya "her yerden çıkış" ile ayrıca iptal edilir)
    jwtTtl: env.JWT_TTL ?? '14d',

    // Kapıdaki QR ne sıklıkla yenilenir ve eski kod ne kadar süre geçerli kalır
    qrRotateMs: Number(env.QR_ROTATE_MS ?? 20_000),
    qrTtlMs: Number(env.QR_TTL_MS ?? 30_000),
    // Aynı üyenin tekrar tekrar geçmesini engelleyen bekleme süresi
    antiPassbackMs: Number(env.ANTI_PASSBACK_MS ?? 120_000),

    // Tek seferde CSV olarak indirilebilecek en fazla giriş kaydı
    maxExportRows: Number(env.MAX_EXPORT_ROWS ?? 50_000),

    // Ters vekil (Caddy/nginx) arkasındaysanız TRUST_PROXY=true: gerçek istemci IP'si için gerekir
    trustProxy: env.TRUST_PROXY === 'true',
    // Yalnızca HTTPS ile yayındayken HSTS=true
    hsts: env.HSTS === 'true',

    // Şifre deneme saldırılarına karşı: art arda hatalı girişte hesap geçici kilitlenir
    lockoutMaxFailures: Number(env.LOCKOUT_MAX_FAILURES ?? 5),
    lockoutMs: Number(env.LOCKOUT_MS ?? 15 * 60_000),

    // IP başına istek sınırları (RATE_LIMIT=off ile kapatılır, yalnızca geliştirme için)
    rateLimitEnabled: env.RATE_LIMIT !== 'off',
    limits: {
      login: { max: 10, timeWindow: '1 minute' },
      signup: { max: 5, timeWindow: '1 hour' },
      password: { max: 5, timeWindow: '15 minutes' },
      // Aynı salon Wi-Fi'sindeki çok sayıda telefon aynı IP'den çıkabilir, bu yüzden cömert
      scan: { max: 120, timeWindow: '1 minute' },
      gate: { max: 20, timeWindow: '1 minute' },
      api: { max: 300, timeWindow: '1 minute' },
    },
    ...overrides,
  };
}
