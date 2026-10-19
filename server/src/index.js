import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { isDummy, loadConfig } from './config.js';
import { openDb } from './db.js';

const config = loadConfig();
if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET tanımlı değil. Önce "npm run setup" çalıştırın.');
  process.exit(1);
}
if (isDummy(process.env.JWT_SECRET)) {
  // Herkesin okuyabildiği bir anahtarla imzalanan oturumlar sahte üretilebilir
  console.error('JWT_SECRET örnek (DUMMY) bir değer. .env dosyasını silip "npm run setup" ile gerçek değerler üretin.');
  process.exit(1);
}

// Web panelinin derlenmiş hâli (web/ klasöründe "npm run build" ile üretilir)
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
const staticDir = existsSync(webDist) ? webDist : null;
if (!staticDir) console.warn('web/dist bulunamadı: web paneli sunulmayacak (yalnızca API çalışır).');

const db = openDb(config.dbPath);
const app = await buildApp({ db, config, logger: { level: 'info' }, staticDir });

await app.listen({ port: config.port, host: config.host });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await app.close();
    db.close();
    process.exit(0);
  });
}
