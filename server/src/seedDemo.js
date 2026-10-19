// Geliştirme için örnek veri: paneli dolu görmek ve denemek içindir. Canlı veritabanında ÇALIŞTIRMAYIN.
// Örnek salon sahibinin salonuna üyeler, süresi dolmuş/devre dışı örnekler, bir çalışan ve giriş kayıtları ekler.
// Tekrar çalıştırmak güvenlidir: örnek veri varsa hiçbir şey eklemez.
import { openDb, transaction } from './db.js';
import { hashPassword } from './security.js';

process.loadEnvFile('.env');
const db = openDb(process.env.DB_PATH ?? 'data/gym.db');

const owner = db.prepare('SELECT id FROM users WHERE email = ?').get(process.env.ADMIN_EMAIL);
const gym = owner && db.prepare("SELECT gym_id AS id FROM gym_staff WHERE user_id = ? AND role = 'owner' ORDER BY gym_id LIMIT 1").get(owner.id);
if (!gym) {
  console.error('Örnek salon bulunamadı. Önce "npm run setup" çalıştırın.');
  process.exit(1);
}
if (db.prepare("SELECT 1 FROM users WHERE email LIKE '%@ornek.local' LIMIT 1").get()) {
  console.log('Örnek veri zaten var, bir şey eklenmedi.');
  process.exit(0);
}

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const gate = db.prepare('SELECT id FROM gates WHERE gym_id = ? ORDER BY id LIMIT 1').get(gym.id);

transaction(db, () => {
  // Paket fiyatları (kuruş)
  const prices = { Aylık: 150_000, '3 Aylık': 400_000, Yıllık: 1_400_000 };
  for (const [name, cents] of Object.entries(prices)) {
    db.prepare('UPDATE plans SET price_cents = ? WHERE gym_id = ? AND name = ?').run(cents, gym.id, name);
  }
  const plan = Object.fromEntries(db.prepare('SELECT id, name, days FROM plans WHERE gym_id = ?').all(gym.id).map((p) => [p.name, p]));

  // Örnek hesapların şifresini kimse bilmez; bunlar yalnızca panelde görünsün diye var
  const passwordHash = hashPassword(`ornek-${now}-${Math.random()}`);
  const addUser = (name, phone) => {
    const email = `${name.toLowerCase().replaceAll(' ', '.').replaceAll('ı', 'i').replaceAll('ş', 's').replaceAll('ğ', 'g').replaceAll('ü', 'u').replaceAll('ö', 'o').replaceAll('ç', 'c')}@ornek.local`;
    return Number(db.prepare('INSERT INTO users (name, email, phone, password_hash) VALUES (?, ?, ?, ?)').run(name, email, phone, passwordHash).lastInsertRowid);
  };

  // [ad, telefon, paket, kaç gün önce başladı, devre dışı mı]
  const members = [
    ['Ahmet Yılmaz', '0532 111 22 01', 'Yıllık', 40, false],
    ['Ayşe Demir', '0532 111 22 02', 'Aylık', 5, false],
    ['Mehmet Kaya', '0532 111 22 03', '3 Aylık', 30, false],
    ['Fatma Şahin', '0532 111 22 04', 'Aylık', 27, false], // birkaç güne bitiyor
    ['Mustafa Çelik', '0532 111 22 05', 'Aylık', 50, false], // süresi doldu
    ['Zeynep Arslan', '0532 111 22 06', '3 Aylık', 10, false],
    ['Emre Koç', '0532 111 22 07', 'Aylık', 12, false],
    ['Elif Öztürk', '0532 111 22 08', 'Yıllık', 200, false],
    ['Burak Aydın', '0532 111 22 09', 'Aylık', 90, false], // süresi doldu
    ['Selin Polat', '0532 111 22 10', null, 0, false], // paketi yok
    ['Can Erdoğan', '0532 111 22 11', 'Aylık', 3, true], // devre dışı
    ['Deniz Yıldız', '0532 111 22 12', '3 Aylık', 60, false],
  ];

  const people = members.map(([name, phone, planName, daysAgo, disabled]) => {
    const id = addUser(name, phone);
    db.prepare('INSERT INTO gym_members (gym_id, user_id, active) VALUES (?, ?, ?)').run(gym.id, id, disabled ? 0 : 1);
    let active = false;
    if (planName) {
      const start = now - daysAgo * DAY;
      const end = start + plan[planName].days * DAY;
      db.prepare('INSERT INTO memberships (gym_id, user_id, plan_id, starts_at, ends_at) VALUES (?, ?, ?, ?, ?)').run(
        gym.id, id, plan[planName].id, iso(start), iso(end),
      );
      active = end > now && !disabled;
    }
    return { id, active, disabled, hasPlan: Boolean(planName) };
  });

  // Bir çalışan
  const staffId = addUser('Sevgi Resepsiyon', null);
  db.prepare("INSERT INTO gym_staff (gym_id, user_id, role) VALUES (?, ?, 'staff')").run(gym.id, staffId);

  // Son 3 günde giriş kayıtları (deterministik, tekrar edebilir görünüm için basit bir sıra)
  if (gate) {
    const insert = db.prepare('INSERT INTO entries (gym_id, user_id, gate_id, at, allowed, reason) VALUES (?, ?, ?, ?, ?, ?)');
    const activeOnes = people.filter((p) => p.active);
    const denied = [
      ...people.filter((p) => p.hasPlan && !p.active && !p.disabled).map((p) => [p, 'no_active_membership']),
      ...people.filter((p) => p.disabled).map((p) => [p, 'member_disabled']),
      ...people.filter((p) => !p.hasPlan).map((p) => [p, 'no_active_membership']),
    ];
    const rows = [];
    for (let i = 0; i < 46; i++) {
      const at = now - i * 97 * 60_000 - 15 * 60_000; // yaklaşık 1,6 saat arayla geriye doğru
      if (i % 9 === 4 && denied.length) {
        const [p, reason] = denied[(i / 9 | 0) % denied.length];
        rows.push([p.id, at, 0, reason]);
      } else {
        rows.push([activeOnes[(i * 5) % activeOnes.length].id, at, 1, null]);
      }
    }
    for (const [userId, at, allowed, reason] of rows) insert.run(gym.id, userId, gate.id, iso(at), allowed, reason);
  }
});

console.log('Örnek veri eklendi: 12 üye, 1 çalışan, paket fiyatları ve giriş kayıtları.');
db.close();
