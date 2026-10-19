import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MEMBER_PASSWORD, OWNER, startServer } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;

describe('Üye detayı ve üyeye göre giriş kayıtları', () => {
  let s, gymId, token, other, staffToken, ali, veli;
  const get = (path, tok = token, gym = gymId) => s.request('GET', `/api/gyms/${gym}${path}`, null, tok);
  const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

  before(async () => {
    s = await startServer();
    gymId = s.gymId;
    token = await s.login(OWNER.email, OWNER.password);
    other = await s.signupGym('Baska Salon', 'baska@test.local');
    await s.request('POST', `/api/gyms/${gymId}/staff`, { email: 'calisan@test.local', name: 'Cal', password: MEMBER_PASSWORD }, token);
    staffToken = await s.login('calisan@test.local', MEMBER_PASSWORD);

    const add = async (name, email, phone) =>
      (await s.request('POST', `/api/gyms/${gymId}/members`, { name, email, phone, password: MEMBER_PASSWORD }, token)).body.id;
    ali = await add('Ali', 'ali@test.local', '0532 000 00 01');
    veli = await add('Veli', 'veli@test.local');

    // Ali'ye iki paket üst üste tanımla (Aylık + 3 Aylık)
    const plans = (await get('/plans')).body;
    const aylik = plans.find((p) => p.name === 'Aylık').id;
    const uc = plans.find((p) => p.name === '3 Aylık').id;
    await s.request('POST', `/api/gyms/${gymId}/members/${ali}/memberships`, { planId: aylik }, token);
    await s.request('POST', `/api/gyms/${gymId}/members/${ali}/memberships`, { planId: uc }, token);

    const ins = s.db.prepare('INSERT INTO entries (gym_id, user_id, gate_id, at, allowed, reason) VALUES (?, ?, ?, ?, ?, ?)');
    ins.run(gymId, ali, 'kapi-1', iso(1 * DAY), 1, null); // dün
    ins.run(gymId, ali, 'kapi-1', iso(5 * DAY), 1, null);
    ins.run(gymId, ali, 'kapi-1', iso(40 * DAY), 1, null); // 30 günden eski
    ins.run(gymId, ali, 'kapi-1', iso(2 * DAY), 0, 'recent_entry'); // red: son geliş sayılmaz
    ins.run(gymId, veli, 'kapi-1', iso(3 * DAY), 1, null);
    const stranger = s.db.prepare("INSERT INTO users (name, email, password_hash) VALUES ('Y', 'y@test.local', 'x')").run().lastInsertRowid;
    ins.run(other.gymId, stranger, 'baska', iso(1 * DAY), 1, null);
  });
  after(() => s.close());

  it('üye detayı: bilgiler, üyelik geçmişi ve giriş istatistikleri', async () => {
    const res = await get(`/members/${ali}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'Ali');
    assert.equal(res.body.email, 'ali@test.local');
    assert.equal(res.body.phone, '0532 000 00 01');
    assert.equal(res.body.active, true);
    assert.ok(res.body.joinedAt);

    // En yeni üyelik üstte; ikisi de geçerli. Üst üste tanımlanınca ikincisinin bitişi 30+90 gün sonradır.
    assert.deepEqual(res.body.memberships.map((m) => [m.plan, m.status]), [['3 Aylık', 'active'], ['Aylık', 'active']]);
    const days = (m) => Math.round((Date.parse(m.endsAt) - Date.now()) / DAY);
    assert.equal(days(res.body.memberships[1]), 30);
    assert.equal(days(res.body.memberships[0]), 120);

    assert.equal(res.body.stats.visits, 3); // yalnızca geçen girişler
    assert.equal(res.body.stats.visitsLast30, 2);
    assert.equal(res.body.stats.denied, 1);
    assert.ok(Math.abs(Date.parse(res.body.stats.lastVisitAt) - (Date.now() - DAY)) < 5000); // dünkü giriş; red sayılmaz
  });

  it('hiç girişi ve paketi olmayan üye için boş ama geçerli yanıt döner', async () => {
    const res = await get(`/members/${veli}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.memberships, []);
    assert.equal(res.body.stats.visits, 1);
    const empty = (await s.request('POST', `/api/gyms/${gymId}/members`, { name: 'Yeni', email: 'yeni@test.local', password: MEMBER_PASSWORD }, token)).body.id;
    const fresh = await get(`/members/${empty}`);
    assert.deepEqual(fresh.body.stats, { visits: 0, visitsLast30: 0, denied: 0, lastVisitAt: null });
  });

  it('süresi dolmuş üyelik "ended" olarak görünür', async () => {
    const plans = (await get('/plans')).body;
    const eski = (await s.request('POST', `/api/gyms/${gymId}/members`, { name: 'Eski', email: 'eski@test.local', password: MEMBER_PASSWORD }, token)).body.id;
    s.db.prepare('INSERT INTO memberships (gym_id, user_id, plan_id, starts_at, ends_at) VALUES (?, ?, ?, ?, ?)').run(
      gymId, eski, plans[0].id, iso(100 * DAY), iso(10 * DAY),
    );
    const res = await get(`/members/${eski}`);
    assert.equal(res.body.memberships[0].status, 'ended');
  });

  it('başka salonun üyesi veya var olmayan üye 404; çalışan görebilir; yetkisiz 401', async () => {
    assert.equal((await get('/members/999999')).status, 404);
    const stranger = s.db.prepare("SELECT id FROM users WHERE email = 'y@test.local'").get().id;
    assert.equal((await get(`/members/${stranger}`)).status, 404); // başka salonun üyesi bu salonda yok
    assert.equal((await get(`/members/${ali}`, other.token, other.gymId)).status, 404); // Ali bu salona üye değil
    assert.equal((await get(`/members/${ali}`, staffToken)).status, 200);
    assert.equal((await get(`/members/${ali}`, null)).status, 401);
  });

  it('listede "son geliş" yalnızca geçen girişlerden hesaplanır', async () => {
    const list = (await get('/members')).body;
    const byName = Object.fromEntries(list.map((m) => [m.name, m]));
    assert.ok(Math.abs(Date.parse(byName.Ali.lastVisitAt) - (Date.now() - DAY)) < 5000);
    assert.ok(Math.abs(Date.parse(byName.Veli.lastVisitAt) - (Date.now() - 3 * DAY)) < 5000);
    assert.equal(byName.Yeni.lastVisitAt, null);
  });

  it('girişler yalnızca seçilen üyeye göre filtrelenebilir', async () => {
    const all = (await get('/entries?limit=500')).body;
    assert.equal(all.length, 5);
    const aliOnly = (await get(`/entries?userId=${ali}&limit=500`)).body;
    assert.equal(aliOnly.length, 4);
    assert.ok(aliOnly.every((e) => e.userId === ali));
    // aralık ve sonuç filtresiyle birlikte çalışır
    const range = new URLSearchParams({ from: iso(10 * DAY), to: new Date(Date.now() + DAY).toISOString(), userId: String(ali), result: 'allowed' });
    assert.equal((await get(`/entries?${range}`)).body.length, 2);
    // başka salonun kaydı başka salonun üyesi için bile sızmaz
    const stranger = s.db.prepare("SELECT id FROM users WHERE email = 'y@test.local'").get().id;
    assert.equal((await get(`/entries?userId=${stranger}`)).body.length, 0);
    assert.equal((await get('/entries?userId=abc')).status, 400);
    assert.equal((await get('/entries?userId=0')).status, 400);
  });
});
