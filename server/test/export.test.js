import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, localParts, toCsv } from '../src/csv.js';
import { MEMBER_PASSWORD, OWNER, startServer } from './helpers.js';

const T = (s) => `2026-03-${s}Z`;

describe('CSV üretici', () => {
  it('ayırıcı, tırnak ve satır sonu içeren hücreleri tırnaklar', () => {
    assert.equal(csvCell('düz metin'), 'düz metin');
    assert.equal(csvCell('a;b'), '"a;b"');
    assert.equal(csvCell('Ahmet "Ali"'), '"Ahmet ""Ali"""');
    assert.equal(csvCell('iki\nsatır'), '"iki\nsatır"');
    assert.equal(csvCell(null), '');
    assert.equal(csvCell(undefined), '');
    assert.equal(csvCell(0), '0');
  });

  it('formül gibi başlayan hücreleri metne çevirir (CSV enjeksiyonu)', () => {
    for (const evil of ['=1+1', '+90555', '-2+3', '@SUM(A1)', '\t=cmd', '\r=cmd']) {
      assert.ok(csvCell(evil).replace(/^"/, '').startsWith("'"), `${JSON.stringify(evil)} etkisizleştirilmedi`);
    }
    assert.equal(csvCell('=HYPERLINK("http://x";"a")'), `"'=HYPERLINK(""http://x"";""a"")"`);
    assert.equal(csvCell('Ali = Veli'), 'Ali = Veli'); // ortadaki = zararsız
  });

  it('BOM ile başlar, satırlar CRLF ile ayrılır', () => {
    const csv = toCsv(['A', 'B'], [['1', 'x;y']]);
    assert.equal(csv, '﻿A;B\r\n1;"x;y"\r\n');
  });

  it('yerel tarih ve saati saat dilimine göre verir', () => {
    assert.deepEqual(localParts('2026-03-11T22:30:05.000Z', 180), { date: '12.03.2026', time: '01:30:05', key: '2026-03-12' });
    assert.deepEqual(localParts('2026-03-11T22:30:05.000Z', 0), { date: '11.03.2026', time: '22:30:05', key: '2026-03-11' });
    assert.deepEqual(localParts('2026-03-11T01:00:00.000Z', -300), { date: '10.03.2026', time: '20:00:00', key: '2026-03-10' });
  });
});

describe('Giriş kayıtlarını CSV olarak indirme', () => {
  let s, gymId, owner, staffToken, other;
  const exp = (params, token = owner, gym = gymId) =>
    s.request('GET', `/api/gyms/${gym}/entries/export?${new URLSearchParams(params)}`, null, token);
  const RANGE = { from: T('10T00:00:00.000'), to: T('12T00:00:00.000'), tzOffsetMinutes: '180' };

  before(async () => {
    s = await startServer({ maxExportRows: 8 });
    gymId = s.gymId;
    owner = await s.login(OWNER.email, OWNER.password);
    other = await s.signupGym('Baska Salon', 'baska@test.local');
    await s.request('POST', `/api/gyms/${gymId}/staff`, { email: 'calisan@test.local', name: 'Cal', password: MEMBER_PASSWORD }, owner);
    staffToken = await s.login('calisan@test.local', MEMBER_PASSWORD);

    const add = async (name, email) =>
      (await s.request('POST', `/api/gyms/${gymId}/members`, { name, email, password: MEMBER_PASSWORD }, owner)).body.id;
    const ali = await add('Ali', 'ali@test.local');
    const evil = await add('=HYPERLINK("http://kotu.example";"tikla")', 'evil@test.local');
    const tricky = await add('Ahmet "Ali"; Test', 'tricky@test.local');

    const ins = s.db.prepare('INSERT INTO entries (gym_id, user_id, gate_id, at, allowed, reason) VALUES (?, ?, ?, ?, ?, ?)');
    ins.run(gymId, evil, 'kapi-1', T('10T10:00:00.000'), 1, null); // en erken eklenen ama zaman olarak ortada
    ins.run(gymId, ali, 'kapi-1', T('10T09:00:00.000'), 1, null);
    ins.run(gymId, tricky, 'kapi-1', T('11T22:30:00.000'), 1, null); // Türkiye'de 12 Mart 01:30
    ins.run(gymId, ali, 'kapi-1', T('10T13:00:00.000'), 0, 'no_active_membership');
    ins.run(gymId, ali, 'kapi-1', T('12T00:00:00.000'), 1, null); // aralık dışı (bitiş hariç)
    const stranger = s.db.prepare("INSERT INTO users (name, email, password_hash) VALUES ('Yabanci', 'y@test.local', 'x')").run().lastInsertRowid;
    ins.run(other.gymId, stranger, 'baska', T('10T11:00:00.000'), 1, null); // başka salon
  });
  after(() => s.close());

  it('sahip Excel uyumlu CSV indirir: başlıklar, BOM, kronolojik sıra, saat dilimi', async () => {
    const res = await exp(RANGE);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/csv; charset=utf-8/);
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="giris-kayitlari_2026-03-10_2026-03-12.csv"');
    assert.equal(res.headers.get('x-row-count'), '4');

    assert.ok(res.text.startsWith('﻿'));
    const lines = res.text.slice(1).trimEnd().split('\r\n');
    assert.equal(lines[0], 'Tarih;Saat;Üye;E-posta;Kapı;Sonuç;Neden');
    assert.equal(lines.length, 5); // başlık + 4 kayıt (aralık dışı ve başka salon yok)
    // eskiden yeniye; UTC+3: 09:00Z -> 12:00
    assert.equal(lines[1], '10.03.2026;12:00:00;Ali;ali@test.local;Ana Giriş;Geçti;');
    assert.ok(lines[2].startsWith('10.03.2026;13:00:00;'));
    assert.equal(lines[3], '10.03.2026;16:00:00;Ali;ali@test.local;Ana Giriş;Reddedildi;Aktif üyelik yok');
    assert.ok(lines[4].startsWith('12.03.2026;01:30:00;')); // gece yarısını aşan kayıt ertesi güne düşer
  });

  it('formül gibi başlayan ve tırnak/ayırıcı içeren adlar güvenli yazılır', async () => {
    const { text } = await exp(RANGE);
    assert.ok(text.includes(`"'=HYPERLINK(""http://kotu.example"";""tikla"")";evil@test.local`), text);
    assert.ok(text.includes('"Ahmet ""Ali""; Test";tricky@test.local'));
    assert.ok(!/(^|;)=HYPERLINK/m.test(text)); // hiçbir hücre = ile başlamaz
  });

  it('sonuç filtresi uygulanır', async () => {
    const denied = await exp({ ...RANGE, result: 'denied' });
    assert.equal(denied.text.slice(1).trimEnd().split('\r\n').length, 2); // başlık + 1
    assert.equal(denied.headers.get('x-row-count'), '1');
    const allowed = await exp({ ...RANGE, result: 'allowed' });
    assert.equal(allowed.headers.get('x-row-count'), '3');
  });

  it('boş aralık yalnızca başlık satırını içerir', async () => {
    const res = await exp({ from: T('20T00:00:00.000'), to: T('21T00:00:00.000') });
    assert.equal(res.status, 200);
    assert.equal(res.text, '﻿Tarih;Saat;Üye;E-posta;Kapı;Sonuç;Neden\r\n');
  });

  it('yalnızca sahip indirebilir; başka salon ve oturumsuz erişemez', async () => {
    assert.equal((await exp(RANGE, staffToken)).status, 403);
    assert.equal((await exp(RANGE, other.token)).status, 404); // bu salonun adresine başka salonun anahtarıyla
    assert.equal((await exp(RANGE, null)).status, 401);
    const theirs = await exp(RANGE, other.token, other.gymId);
    assert.equal(theirs.headers.get('x-row-count'), '1'); // kendi salonunun kaydı, bu salonunkiler sızmaz
    assert.ok(!theirs.text.includes('ali@test.local'));
  });

  it('geçersiz parametreler ve çok büyük dökümler reddedilir', async () => {
    assert.equal((await exp({ from: T('10T00:00:00.000') })).status, 400); // bitiş zorunlu
    assert.equal((await exp({ from: T('12T00:00:00.000'), to: T('10T00:00:00.000') })).status, 400);
    assert.equal((await exp({ ...RANGE, result: 'hepsi' })).status, 400);
    assert.equal((await exp({ ...RANGE, tzOffsetMinutes: '9999' })).status, 400);

    // Üst sınır 8 kayıt: 9 kayıtlık bir aralık reddedilir, mesaj sayıyı söyler
    const ins = s.db.prepare('INSERT INTO entries (gym_id, user_id, gate_id, at, allowed) VALUES (?, ?, ?, ?, 1)');
    const ali = s.db.prepare("SELECT id FROM users WHERE email = 'ali@test.local'").get().id;
    for (let i = 0; i < 6; i++) ins.run(gymId, ali, 'kapi-1', T(`15T0${i}:00:00.000`));
    const big = await exp({ from: T('01T00:00:00.000'), to: T('30T00:00:00.000') });
    assert.equal(big.status, 400);
    assert.match(big.body.error, /en fazla 8 kayıt/);
  });

  it('her indirme denetim kaydına yazılır', async () => {
    const log = (await s.request('GET', `/api/gyms/${gymId}/audit?limit=200`, null, owner)).body;
    const exports = log.filter((e) => e.action === 'entries.export');
    assert.ok(exports.length >= 4);
    const first = exports[exports.length - 1]; // en eski = ilk başarılı indirme
    assert.deepEqual(first.details, { from: '2026-03-10', to: '2026-03-12', result: 'all', count: 4 });
    // Reddedilen (yetkisiz/hatalı) denemeler kayda düşmez
    assert.equal(exports.filter((e) => e.actorName === 'Cal').length, 0);
  });
});
