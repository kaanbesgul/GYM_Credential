// İlk kurulum: .env dosyasını (rastgele sırlarla) üretir, veritabanını hazırlar ve
// örnek salon sahibi + salon + ilk kapıyı ekler. Tekrar çalıştırmak güvenlidir.
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { openDb } from './db.js';
import { newGateKey } from './security.js';
import { seedDefaults } from './seed.js';

const ENV_PATH = '.env';

if (!existsSync(ENV_PATH)) {
  const lines = [
    'PORT=3000',
    'DB_PATH=data/gym.db',
    `JWT_SECRET=${randomBytes(32).toString('hex')}`,
    'ADMIN_EMAIL=admin@gym.local',
    `ADMIN_PASSWORD=${randomBytes(9).toString('base64url')}`,
    'GYM_NAME=Demo Salon',
    'GATE_ID=kapi-1',
    `GATE_KEY=${newGateKey()}`,
    '',
  ];
  writeFileSync(ENV_PATH, lines.join('\n'), { mode: 0o600 });
  console.log(`${ENV_PATH} oluşturuldu (salon sahibi şifresi ve kapı anahtarı içinde).`);
}

process.loadEnvFile(ENV_PATH);
const env = process.env;
const db = openDb(env.DB_PATH ?? 'data/gym.db');
const created = seedDefaults(db, {
  ownerEmail: env.ADMIN_EMAIL,
  ownerPassword: env.ADMIN_PASSWORD,
  gymName: env.GYM_NAME,
  gateId: env.GATE_ID,
  gateKey: env.GATE_KEY,
});
db.close();

console.log('Veritabanı hazır:', created);
