import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { seedDefaults } from '../src/seed.js';

const OWNER1 = { email: 'sahip1@test.local', password: 'sahip1-sifre-123' };
const GATE1 = { id: 'kapi-1', key: 'test-gate-key' };
const MEMBER_PASSWORD = 'uye-sifresi-123';

describe('Çoklu salon: QR ile giriş akışı', () => {
  let app, db, base, wsUrl;
  let gym1, owner1Token; // seed ile gelen salon
  let gym2, owner2Token, gate2; // kayıt olarak açılan ikinci salon

  before(async () => {
    db = openDb(':memory:');
    const seeded = seedDefaults(db, {
      ownerEmail: OWNER1.email,
      ownerPassword: OWNER1.password,
      gymName: 'Salon Bir',
      gateId: GATE1.id,
      gateKey: GATE1.key,
    });
    gym1 = seeded.gymId;
    // Bu testler aynı IP'den çok sayıda giriş yapar; hız sınırı security.test.js'te ayrıca denenir
    const config = loadConfig({ jwtSecret: 'test-secret', rateLimitEnabled: false, qrRotateMs: 60_000, qrTtlMs: 700, antiPassbackMs: 60_000 });
    app = await buildApp({ db, config });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address();
    base = `http://127.0.0.1:${port}`;
    wsUrl = `ws://127.0.0.1:${port}/ws/gate`;

    owner1Token = (await api('POST', '/api/auth/login', OWNER1)).body.token;
    const signup = await api('POST', '/api/auth/signup-gym', {
      gymName: 'Salon İki',
      name: 'Sahip İki',
      email: 'sahip2@test.local',
      password: 'sahip2-sifre-123',
    });
    assert.equal(signup.status, 201);
    owner2Token = signup.body.token;
    gym2 = signup.body.gyms[0].id;
    gate2 = (await api('POST', `/api/gyms/${gym2}/gates`, { name: 'Giriş' }, owner2Token)).body;
  });

  after(async () => {
    await app.close();
    db.close();
  });

  async function api(method, path, body, token) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  /** Kapı cihazını taklit eder: gelen mesajları biriktirir. */
  async function connectGate(gate = GATE1) {
    const socket = new WebSocket(wsUrl);
    const messages = [];
    const waiters = [];
    socket.on('message', (raw) => {
      messages.push(JSON.parse(raw.toString()));
      waiters.splice(0).forEach((w) => w());
    });
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({ type: 'hello', gateId: gate.id, key: gate.key }));

    const next = async (type) => {
      for (;;) {
        const i = messages.findIndex((m) => m.type === type);
        if (i >= 0) return messages.splice(i, 1)[0];
        await Promise.race([
          new Promise((r) => waiters.push(r)),
          new Promise((_, rej) => setTimeout(() => rej(new Error(`"${type}" mesajı gelmedi`)), 2000)),
        ]);
      }
    };
    const ready = async () => {
      await next('hello_ok');
      return (await next('qr')).code;
    };
    return { socket, next, messages, ready };
  }

  /** Salona üye ekler (varsa bağlar) ve istenirse ilk paketi tanımlar. */
  async function addMember({ gym, token, name, withPlan = true }) {
    const email = `${name.toLowerCase()}@test.local`;
    const added = await api('POST', `/api/gyms/${gym}/members`, { name, email, password: MEMBER_PASSWORD }, token);
    assert.equal(added.status, 201, JSON.stringify(added.body));
    if (withPlan) {
      const plans = await api('GET', `/api/gyms/${gym}/plans`, null, token);
      const res = await api('POST', `/api/gyms/${gym}/members/${added.body.id}/memberships`, { planId: plans.body[0].id }, token);
      assert.equal(res.status, 201);
    }
    const login = await api('POST', '/api/auth/login', { email, password: MEMBER_PASSWORD });
    return { id: added.body.id, email, token: login.body.token };
  }

  describe('Kimlik ve yetki', () => {
    it('yanlış şifre ve oturumsuz erişim reddedilir', async () => {
      assert.equal((await api('POST', '/api/auth/login', { email: OWNER1.email, password: 'yanlis' })).status, 401);
      assert.equal((await api('GET', `/api/gyms/${gym1}/members`)).status, 401);
    });

    it('salon kaydı hesap, salon ve varsayılan paketleri oluşturur; aynı e-posta tekrar kaydolamaz', async () => {
      const plans = await api('GET', `/api/gyms/${gym2}/plans`, null, owner2Token);
      assert.equal(plans.body.length, 3);
      const again = await api('POST', '/api/auth/signup-gym', {
        gymName: 'Başka', name: 'X', email: 'SAHIP2@test.local', password: 'sahip2-sifre-123',
      });
      assert.equal(again.status, 409);
    });

    it('bir salonun çalışanı başka salonun verisine erişemez', async () => {
      assert.equal((await api('GET', `/api/gyms/${gym2}/members`, null, owner1Token)).status, 404);
      assert.equal((await api('GET', `/api/gyms/${gym1}/members`, null, owner2Token)).status, 404);
      assert.equal((await api('GET', `/api/gyms/${gym1}/entries`, null, owner2Token)).status, 404);
    });

    it('sıradan üye web paneli API\'sine erişemez', async () => {
      const ali = await addMember({ gym: gym1, token: owner1Token, name: 'Ali' });
      assert.equal((await api('GET', `/api/gyms/${gym1}/members`, null, ali.token)).status, 404);
    });
  });

  describe('Üye yönetimi', () => {
    it('var olan e-posta salona bağlanır, hesabı ve şifresi değişmez', async () => {
      const veli = await addMember({ gym: gym1, token: owner1Token, name: 'Veli' });
      const linked = await api(
        'POST',
        `/api/gyms/${gym2}/members`,
        { email: veli.email, name: 'Başka Ad', password: 'baska-sifre-999' },
        owner2Token,
      );
      assert.equal(linked.status, 201);
      assert.equal(linked.body.created, false);
      assert.equal(linked.body.name, 'Veli'); // kişinin kendi adı korunur
      // Eski şifre hâlâ geçerli, salon 2'nin verdiği şifre geçersiz
      assert.equal((await api('POST', '/api/auth/login', { email: veli.email, password: MEMBER_PASSWORD })).status, 200);
      assert.equal((await api('POST', '/api/auth/login', { email: veli.email, password: 'baska-sifre-999' })).status, 401);
    });

    it('aynı kişi aynı salona iki kez eklenemez; yeni üye için şifre şarttır', async () => {
      const can = await addMember({ gym: gym1, token: owner1Token, name: 'Can', withPlan: false });
      const dup = await api('POST', `/api/gyms/${gym1}/members`, { email: can.email }, owner1Token);
      assert.equal(dup.status, 409);
      const noPass = await api('POST', `/api/gyms/${gym1}/members`, { email: 'yeni@test.local', name: 'Yeni' }, owner1Token);
      assert.equal(noPass.status, 400);
    });

    it('başka salonun paketi üyeye tanımlanamaz', async () => {
      const ece = await addMember({ gym: gym1, token: owner1Token, name: 'Ece', withPlan: false });
      const gym2Plans = await api('GET', `/api/gyms/${gym2}/plans`, null, owner2Token);
      const res = await api('POST', `/api/gyms/${gym1}/members/${ece.id}/memberships`, { planId: gym2Plans.body[0].id }, owner1Token);
      assert.equal(res.status, 404);
    });
  });

  describe('QR ile giriş', () => {
    it('aktif üye QR okutunca kapı açılır, kod tek kullanımlıktır', async () => {
      const gate = await connectGate();
      const code = await gate.ready();
      const deniz = await addMember({ gym: gym1, token: owner1Token, name: 'Deniz' });

      const ok = await api('POST', '/api/scan', { code }, deniz.token);
      assert.equal(ok.status, 200);
      assert.equal(ok.body.gymName, 'Salon Bir');
      assert.equal((await gate.next('open')).name, 'Deniz');

      const reuse = await api('POST', '/api/scan', { code }, (await addMember({ gym: gym1, token: owner1Token, name: 'Efe' })).token);
      assert.equal(reuse.status, 400);
      assert.equal(reuse.body.reason, 'invalid_code');

      assert.notEqual((await gate.next('qr')).code, code); // kullanımdan sonra yeni kod
      gate.socket.close();
    });

    it('aynı kişi iki salonda ayrı üyelik sahibi olabilir; her kapı kendi salonunu açar', async () => {
      const gateA = await connectGate(GATE1);
      const gateB = await connectGate(gate2);
      const codeA = await gateA.ready();
      const codeB = await gateB.ready();

      const gul = await addMember({ gym: gym1, token: owner1Token, name: 'Gul' });
      // Aynı kişiyi ikinci salona da üye yap ve orada ayrı bir paket tanımla
      const link = await api('POST', `/api/gyms/${gym2}/members`, { email: gul.email }, owner2Token);
      assert.equal(link.status, 201);
      const plans2 = await api('GET', `/api/gyms/${gym2}/plans`, null, owner2Token);
      await api('POST', `/api/gyms/${gym2}/members/${gul.id}/memberships`, { planId: plans2.body[1].id }, owner2Token);

      // Profilde iki ayrı üyelik görünür
      const me = await api('GET', '/api/me', null, gul.token);
      assert.deepEqual(me.body.memberships.map((m) => m.gymName).sort(), ['Salon Bir', 'Salon İki']);
      const m1 = me.body.memberships.find((m) => m.gymId === gym1);
      const m2 = me.body.memberships.find((m) => m.gymId === gym2);
      assert.equal(m1.plan, 'Aylık');
      assert.equal(m2.plan, '3 Aylık');
      assert.ok(m1.active && m2.active);

      // Salon 1'in kapısı salon 1'i, salon 2'nin kapısı salon 2'yi açar (anti-passback salon bazlıdır)
      assert.equal((await api('POST', '/api/scan', { code: codeA }, gul.token)).body.gymName, 'Salon Bir');
      assert.equal((await api('POST', '/api/scan', { code: codeB }, gul.token)).body.gymName, 'Salon İki');
      assert.equal((await gateA.next('open')).name, 'Gul');
      assert.equal((await gateB.next('open')).name, 'Gul');

      // Giriş kayıtları salonlara göre ayrılır
      const e1 = await api('GET', `/api/gyms/${gym1}/entries`, null, owner1Token);
      const e2 = await api('GET', `/api/gyms/${gym2}/entries`, null, owner2Token);
      assert.equal(e1.body.filter((e) => e.memberName === 'Gul').length, 1);
      assert.equal(e2.body.filter((e) => e.memberName === 'Gul').length, 1);
      assert.ok(e2.body.every((e) => e.gateId === gate2.id));
      gateA.socket.close();
      gateB.socket.close();
    });

    it('aynı üye aynı salonda art arda geçemez (anti-passback)', async () => {
      const gate = await connectGate();
      const first = await gate.ready();
      const hakan = await addMember({ gym: gym1, token: owner1Token, name: 'Hakan' });
      assert.equal((await api('POST', '/api/scan', { code: first }, hakan.token)).status, 200);
      const second = (await gate.next('qr')).code;
      const again = await api('POST', '/api/scan', { code: second }, hakan.token);
      assert.equal(again.status, 429);
      assert.equal(again.body.reason, 'recent_entry');
      assert.equal((await gate.next('deny')).name, 'Hakan');
      gate.socket.close();
    });

    it('üye olmayan, pasif veya üyeliği olmayan kişi geçemez ve kapıya bildirilir', async () => {
      const gate = await connectGate();
      let code = await gate.ready();

      // Hiçbir salona bağlı olmayan biri: salon 2'de üye, salon 1'in kapısını okutuyor
      const ilker = await addMember({ gym: gym2, token: owner2Token, name: 'Ilker' });
      const stranger = await api('POST', '/api/scan', { code }, ilker.token);
      assert.equal(stranger.status, 403);
      assert.equal(stranger.body.reason, 'not_a_member');
      assert.equal((await gate.next('deny')).name, 'Ilker');
      code = (await gate.next('qr')).code;

      // Salona üye ama paketi yok
      const jale = await addMember({ gym: gym1, token: owner1Token, name: 'Jale', withPlan: false });
      const noPlan = await api('POST', '/api/scan', { code }, jale.token);
      assert.equal(noPlan.body.reason, 'no_active_membership');
      await gate.next('deny');
      code = (await gate.next('qr')).code;

      // Üyeliği var ama salon sahibi devre dışı bırakmış
      const kaan = await addMember({ gym: gym1, token: owner1Token, name: 'Kaan' });
      await api('PATCH', `/api/gyms/${gym1}/members/${kaan.id}`, { active: false }, owner1Token);
      const disabled = await api('POST', '/api/scan', { code }, kaan.token);
      assert.equal(disabled.body.reason, 'member_disabled');
      assert.equal(gate.messages.some((m) => m.type === 'open'), false);
      gate.socket.close();
    });

    it('süresi dolmuş veya uydurma kod geçersizdir', async () => {
      const gate = await connectGate();
      const code = await gate.ready();
      const lale = await addMember({ gym: gym1, token: owner1Token, name: 'Lale' });
      await new Promise((r) => setTimeout(r, 800)); // qrTtlMs = 700
      assert.equal((await api('POST', '/api/scan', { code }, lale.token)).status, 400);
      assert.equal((await api('POST', '/api/scan', { code: 'GYM1.kapi-1.uydurma' }, lale.token)).status, 400);
      assert.equal((await api('POST', '/api/scan', { code: 'bambaska' }, lale.token)).status, 400);
      gate.socket.close();
    });
  });

  describe('Kapılar', () => {
    it('yanlış anahtarlı cihaz bağlanamaz', async () => {
      const gate = await connectGate({ id: GATE1.id, key: 'yanlis-anahtar' });
      await new Promise((resolve) => gate.socket.once('close', resolve));
      assert.equal(app.hub.isOnline(GATE1.id), false);
    });

    it('salon sahibi kendi kapısını elle açabilir, başkasınınkini açamaz', async () => {
      const gate = await connectGate(gate2);
      await gate.ready();
      const gates = await api('GET', `/api/gyms/${gym2}/gates`, null, owner2Token);
      assert.equal(gates.body[0].online, true);

      assert.equal((await api('POST', `/api/gyms/${gym1}/gates/${gate2.id}/open`, null, owner1Token)).status, 404);
      assert.equal((await api('POST', `/api/gyms/${gym2}/gates/${gate2.id}/open`, null, owner2Token)).status, 200);
      assert.equal((await gate.next('open')).name, 'Resepsiyon');
      gate.socket.close();
    });

    it('panel özeti salona özel sayıları verir', async () => {
      const summary = await api('GET', `/api/gyms/${gym1}`, null, owner1Token);
      assert.equal(summary.body.name, 'Salon Bir');
      assert.equal(summary.body.role, 'owner');
      assert.ok(summary.body.stats.totalMembers >= summary.body.stats.activeMembers);
      assert.ok(summary.body.stats.entriesLast24h >= 1);
    });
  });
});
