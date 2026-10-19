import fastifyRateLimit from '@fastify/rate-limit';

/**
 * Bu kapsamda hız sınırını etkinleştirir. `global: false` iken yalnızca
 * route seçeneğinde `...limit('login')` ile işaretlenen uç noktalar sınırlanır;
 * `global: true` iken kapsamdaki tüm uç noktalara `api` sınırı uygulanır.
 */
export async function setupRateLimit(app, config, { global = false } = {}) {
  if (!config.rateLimitEnabled) return;
  await app.register(fastifyRateLimit, {
    global,
    ...(global ? config.limits.api : {}),
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      code: 'RATE_LIMITED',
      error: `Çok fazla istek gönderildi. ${Math.ceil(context.ttl / 1000)} saniye sonra tekrar deneyin.`,
    }),
  });
}

/** Route seçeneklerine yayılır: `app.post(path, { ...limit(config, 'login'), schema }, handler)` */
export function limit(config, name, extra = {}) {
  return config.rateLimitEnabled ? { config: { rateLimit: { ...config.limits[name], ...extra } } } : {};
}
