import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MEMBER_PASSWORD, OWNER, startServer } from './helpers.js';

// Zamanlar sabit tutulur ki testler günün saatinden bağımsız olsun (UTC).
const T = (s) => `2026-03-${s}Z`; // örn. T('10T09:00:00.000')

describe('Giriş kayıtları: tarih aralığı, filtre ve özet', () => {
  let s, gymId, token, other, staffToken;

  const get = (path, tok = token, gym = gymId) => s.request('GET', `/api/gyms/${gym}${path}`, null, tok);
  const q = (params) => '?' + new URLSearchParams(params).toString();

  before(async () => {
    s = await startServer();
    gymId = s.gymId;
    token = await s.login(OWNER.email, OWNER.password);
    other = await s.signupGym('Baska Salon', 'baska@test.local');

    // İki üye ekle
    const add = async (name, email) =>
      (await s.request('POST', `/api/gyms/${gymId}/members`, { name, email, password: MEMBER_PASSWORD }, token)).body.id;
    const ali = await add('Ali', 'ali@test.local');
    const veli = await add('Veli', 'veli@test.local');

    // Çalışan hesabı: okuma yetkisi olmalı
    await s.request('POST', `/api/gyms/${gymId}/staff`, { email: 'calisan@test.local', name: 'Cal', password: MEMBER_PASSWORD }, token);
    staffToken = await s.login('calisan@test.local', MEMBER_PASSWORD);

    // Kayıtları doğrudan ekle (zamanı biz belirleyelim). at = UTC.
    const gateId = 'kapi-1';
    const ins = s.db.prepare('INSERT INTO entries (gym_id, user_id, gate_id, at, allowed, reason) VALUES (?, ?, ?, ?, ?, ?)');
    // 10 Mart: 3 giriş (Ali x2, Veli x1) + 1 red
    ins.run(gymId, ali, gateId, T('10T09:00:00.000'), 1, null);
    ins.run(gymId, ali, gateId, T('10T18:00:00.000'), 1, null);
    ins.run(gymId, veli, gateId, T('10T12:00:00.000'), 1, null);
    ins.run(gymId, veli, gateId, T('10T13:00:00.000'), 0, 'no_active_membership');
    // 11 Mart 00:00 tam sınır: "to" hariç olduğu için 10 Mart aralığına girmemeli
    ins.run(gymId, ali, gateId, T('11T00:00:00.000'), 1, null);
    // 11 Mart 22:30 UTC = Türkiye'de (UTC+3) 12 Mart 01:30
    ins.run(gymId, veli, gateId, T('11T22:30:00.000'), 1, null);
    // Başka salonun kaydı sızmamalı
    const stranger = s.db.prepare("INSERT INTO users (name, email, password_hash) VALUES ('Y', 'y@test.local', 'x')").run().lastInsertRowid;
    ins.run(other.gymId, stranger, 'baska-kapi', T('10T10:00:00.000'), 1, null);
  });
  after(() => s.close());

  it('tarih aralığı: başlangıç dahil, bitiş hariç', async () => {
    const day10 = await get('/entries' + q({ from: T('10T00:00:00.000'), to: T('11T00:00:00.000') }));
    assert.equal(day10.status, 200);
    assert.equal(day10.body.length, 4); // 11 Mart 00:00 kaydı dışarıda
    assert.ok(day10.body.every((e) => e.at.startsWith('2026-03-10')));

    const both = await get('/entries' + q({ from: T('10T00:00:00.000'), to: T('12T00:00:00.000') }));
    assert.equal(both.body.length, 6);
    // En yeni üstte
    assert.deepEqual(both.body.map((e) => e.at), [...both.body.map((e) => e.at)].sort().reverse());
  });

  it('sonuç filtresi geçenleri ve reddedilenleri ayırır', async () => {
    const range = { from: T('10T00:00:00.000'), to: T('12T00:00:00.000') };
    const allowed = await get('/entries' + q({ ...range, result: 'allowed' }));
    const denied = await get('/entries' + q({ ...range, result: 'denied' }));
    assert.equal(allowed.body.length, 5);
    assert.equal(denied.body.length, 1);
    assert.equal(denied.body[0].reason, 'no_active_membership');
    assert.equal(denied.body[0].memberName, 'Veli');
  });

  it('sayfalama: limit ve offset ile tüm kayıtlar tekrarsız gelir', async () => {
    const range = { from: T('10T00:00:00.000'), to: T('12T00:00:00.000') };
    const page1 = (await get('/entries' + q({ ...range, limit: 4, offset: 0 }))).body;
    const page2 = (await get('/entries' + q({ ...range, limit: 4, offset: 4 }))).body;
    assert.equal(page1.length, 4);
    assert.equal(page2.length, 2);
    const ids = [...page1, ...page2].map((e) => e.id);
    assert.equal(new Set(ids).size, 6);
  });

  it('başka salonun kayıtları görünmez', async () => {
    const mine = await get('/entries' + q({ from: T('01T00:00:00.000'), to: T('30T00:00:00.000') }));
    assert.equal(mine.body.length, 6);
    assert.ok(mine.body.every((e) => e.gateId !== 'baska-kapi'));
    const theirs = await get('/entries' + q({ from: T('01T00:00:00.000'), to: T('30T00:00:00.000') }), other.token, other.gymId);
    assert.equal(theirs.body.length, 1);
  });

  it('özet: toplamlar ve farklı üye sayısı', async () => {
    const res = await get('/entries/summary' + q({ from: T('10T00:00:00.000'), to: T('12T00:00:00.000') }));
    assert.equal(res.status, 200);
    assert.equal(res.body.allowed, 5);
    assert.equal(res.body.denied, 1);
    assert.equal(res.body.total, 6);
    assert.equal(res.body.uniqueMembers, 2); // yalnızca geçen girişlerdeki farklı kişiler

    const empty = await get('/entries/summary' + q({ from: T('20T00:00:00.000'), to: T('21T00:00:00.000') }));
    assert.deepEqual({ ...empty.body }, { allowed: 0, denied: 0, uniqueMembers: 0, total: 0, byDay: [] });
  });

  it('özet: günler istemcinin saat dilimine göre gruplanır', async () => {
    const range = { from: T('10T00:00:00.000'), to: T('13T00:00:00.000') };
    const utc = (await get('/entries/summary' + q({ ...range, tzOffsetMinutes: 0 }))).body.byDay;
    assert.deepEqual(utc.map((d) => [d.day, d.allowed, d.denied]), [
      ['2026-03-10', 3, 1],
      ['2026-03-11', 2, 0],
    ]);
    // Türkiye (UTC+3): 11 Mart 22:30 UTC kaydı 12 Mart'a kayar
    const tr = (await get('/entries/summary' + q({ ...range, tzOffsetMinutes: 180 }))).body.byDay;
    assert.deepEqual(tr.map((d) => [d.day, d.allowed, d.denied]), [
      ['2026-03-10', 3, 1],
      ['2026-03-11', 1, 0],
      ['2026-03-12', 1, 0],
    ]);
  });

  it('geçersiz parametreler 400 döner', async () => {
    assert.equal((await get('/entries' + q({ from: 'dun' }))).status, 400);
    assert.equal((await get('/entries' + q({ from: T('12T00:00:00.000'), to: T('10T00:00:00.000') }))).status, 400); // ters aralık
    assert.equal((await get('/entries' + q({ from: '2020-01-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' }))).status, 400); // çok uzun
    assert.equal((await get('/entries' + q({ result: 'hepsi' }))).status, 400);
    assert.equal((await get('/entries' + q({ limit: 9999 }))).status, 400);
    assert.equal((await get('/entries/summary' + q({ tzOffsetMinutes: 5000 }))).status, 400);
  });

  it('çalışan da okuyabilir; başka salonun sahibi erişemez; parametresiz çağrı son kayıtları döner', async () => {
    const range = q({ from: T('10T00:00:00.000'), to: T('12T00:00:00.000') });
    assert.equal((await get('/entries/summary' + range, staffToken)).status, 200);
    assert.equal((await get('/entries', staffToken)).status, 200);
    assert.equal((await get('/entries/summary')).status, 400); // aralık zorunlu
    assert.equal((await get('/entries', other.token)).status, 404); // bu salonun adresine, başka salonun anahtarıyla
    const all = await get('/entries?limit=3');
    assert.equal(all.body.length, 3);
  });
});
