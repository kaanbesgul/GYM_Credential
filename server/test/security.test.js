import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GATE, MEMBER_PASSWORD, OWNER, startServer } from './helpers.js';

const LIMITS_OFF = { max: 100_000, timeWindow: '1 minute' };

describe('Hesap kilidi', () => {
  let s;
  before(async () => {
    s = await startServer({ lockoutMaxFailures: 3, lockoutMs: 400 });
  });
  after(() => s.close());

  it('art arda hatalı girişten sonra doğru şifre bile süre dolana kadar reddedilir', async () => {
    for (let i = 0; i < 3; i++) {
      assert.equal((await s.request('POST', '/api/auth/login', { email: OWNER.email, password: 'yanlis-sifre' })).status, 401);
    }
    const locked = await s.request('POST', '/api/auth/login', OWNER);
    assert.equal(locked.status, 429);
    assert.match(locked.body.error, /kilitlendi/);

    await new Promise((r) => setTimeout(r, 450));
    assert.equal((await s.request('POST', '/api/auth/login', OWNER)).status, 200);
  });

  it('başarılı giriş hatalı deneme sayacını sıfırlar', async () => {
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 2; i++) await s.request('POST', '/api/auth/login', { email: OWNER.email, password: 'yanlis-sifre' });
      assert.equal((await s.request('POST', '/api/auth/login', OWNER)).status, 200); // 2 hata + 1 başarı: kilit yok
    }
  });
});

describe('Hız sınırı', () => {
  let s;
  before(async () => {
    s = await startServer({
      rateLimitEnabled: true,
      lockoutMaxFailures: 1000,
      limits: {
        login: { max: 3, timeWindow: '1 minute' },
        signup: { max: 2, timeWindow: '1 minute' },
        password: LIMITS_OFF,
        scan: LIMITS_OFF,
        gate: LIMITS_OFF,
        api: { max: 5, timeWindow: '1 minute' },
      },
    });
  });
  after(() => s.close());

  it('girişte sınır aşılınca 429 ve Türkçe mesaj döner', async () => {
    const attempt = () => s.request('POST', '/api/auth/login', { email: 'yok@test.local', password: 'x' });
    for (let i = 0; i < 3; i++) assert.equal((await attempt()).status, 401);
    const limited = await attempt();
    assert.equal(limited.status, 429);
    assert.match(limited.body.error, /Çok fazla istek/);
    assert.equal(limited.body.code, 'RATE_LIMITED');
  });

  it('salon kaydı IP başına sınırlıdır', async () => {
    const signup = (n) =>
      s.request('POST', '/api/auth/signup-gym', { gymName: `S${n}`, name: 'X', email: `s${n}@test.local`, password: 'uzun-sifre-123' });
    assert.equal((await signup(1)).status, 201);
    assert.equal((await signup(2)).status, 201);
    assert.equal((await signup(3)).status, 429);
  });

});

describe('Panel API hız sınırı', () => {
  it('sınır aşılınca 429 döner, altında normal çalışır', async () => {
    const s = await startServer({
      rateLimitEnabled: true,
      limits: { login: LIMITS_OFF, signup: LIMITS_OFF, password: LIMITS_OFF, scan: LIMITS_OFF, gate: LIMITS_OFF, api: { max: 5, timeWindow: '1 minute' } },
    });
    const token = await s.login(OWNER.email, OWNER.password);
    assert.ok(token);
    const statuses = [];
    for (let i = 0; i < 7; i++) statuses.push((await s.request('GET', `/api/gyms/${s.gymId}`, null, token)).status);
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429]);
    await s.close();
  });
});

describe('Güvenlik başlıkları', () => {
  it('CSP, nosniff ve önbellek kapatma var; HSTS yalnızca açıkça istenirse', async () => {
    const s = await startServer();
    const res = await s.request('GET', '/api/me');
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.equal(res.headers.get('strict-transport-security'), null);
    await s.close();

    const https = await startServer({ hsts: true });
    assert.match((await https.request('GET', '/api/me')).headers.get('strict-transport-security'), /max-age=31536000/);
    await https.close();
  });
});

describe('Oturum iptali', () => {
  let s;
  before(async () => {
    s = await startServer();
  });
  after(() => s.close());

  it('şifre değişince eski oturumlar düşer, yeni anahtar çalışır', async () => {
    const old = await s.login(OWNER.email, OWNER.password);
    assert.equal((await s.request('GET', '/api/me', null, old)).status, 200);

    const wrong = await s.request('POST', '/api/auth/change-password', { currentPassword: 'yanlis', newPassword: 'yepyeni-sifre-1' }, old);
    assert.equal(wrong.status, 400);
    const same = await s.request('POST', '/api/auth/change-password', { currentPassword: OWNER.password, newPassword: OWNER.password }, old);
    assert.equal(same.status, 400);
    const short = await s.request('POST', '/api/auth/change-password', { currentPassword: OWNER.password, newPassword: 'kisa' }, old);
    assert.equal(short.status, 400);

    const changed = await s.request('POST', '/api/auth/change-password', { currentPassword: OWNER.password, newPassword: 'yepyeni-sifre-1' }, old);
    assert.equal(changed.status, 200);
    assert.equal((await s.request('GET', '/api/me', null, old)).status, 401); // eski anahtar iptal
    assert.equal((await s.request('GET', '/api/me', null, changed.body.token)).status, 200);
    assert.equal((await s.request('POST', '/api/auth/login', OWNER)).status, 401); // eski şifre geçersiz
    assert.equal((await s.request('POST', '/api/auth/login', { email: OWNER.email, password: 'yepyeni-sifre-1' })).status, 200);
  });

  it('"her yerden çıkış" hesabın tüm cihazlardaki oturumlarını kapatır', async () => {
    const password = 'yepyeni-sifre-1';
    const phone = await s.login(OWNER.email, password);
    const laptop = await s.login(OWNER.email, password);
    assert.equal((await s.request('POST', '/api/auth/logout-all', null, phone)).status, 200);
    assert.equal((await s.request('GET', '/api/me', null, phone)).status, 401);
    assert.equal((await s.request('GET', '/api/me', null, laptop)).status, 401);
    assert.ok(await s.login(OWNER.email, password)); // yeniden giriş yapılabilir

    // Hesap düzeyindeki işlemler denetim kaydına salona bağlı olmadan (gym_id boş) yazılır
    const rows = s.db.prepare("SELECT action, gym_id FROM audit_log WHERE action IN ('password.change', 'session.logout_all')").all();
    assert.deepEqual(rows.map((r) => r.action).sort(), ['password.change', 'session.logout_all']);
    assert.ok(rows.every((r) => r.gym_id === null));
  });

  it('sürüm bilgisi olmayan (eski/sahte) anahtar kabul edilmez', async () => {
    const forged = s.app.jwt.sign({ sub: 1 });
    assert.equal((await s.request('GET', '/api/me', null, forged)).status, 401);
  });
});

describe('Çalışan rolleri, kapı anahtarı ve denetim kaydı', () => {
  let s, gym, owner, staffToken, staffId, other;

  before(async () => {
    s = await startServer();
    owner = await s.signupGym('Rol Salonu', 'rol-sahip@test.local');
    gym = owner.gymId;
    other = await s.signupGym('Baska Salon', 'baska-sahip@test.local');
  });
  after(() => s.close());

  const api = (method, path, body, token = owner.token) => s.request(method, `/api/gyms/${gym}${path}`, body, token);

  it('sahip çalışan ekler; çalışan günlük işleri yapar ama yönetim işlerine giremez', async () => {
    const added = await api('POST', '/staff', { email: 'calisan@test.local', name: 'Sevgi', password: MEMBER_PASSWORD });
    assert.equal(added.status, 201);
    assert.equal(added.body.role, 'staff');
    staffId = added.body.userId;
    staffToken = await s.login('calisan@test.local', MEMBER_PASSWORD);

    // Günlük işler serbest
    assert.equal((await api('GET', '/members', null, staffToken)).status, 200);
    assert.equal((await api('POST', '/members', { email: 'uye1@test.local', name: 'Uye Bir', password: MEMBER_PASSWORD }, staffToken)).status, 201);
    assert.equal((await api('GET', '/entries', null, staffToken)).status, 200);
    // Yönetim işleri yalnızca sahipte
    assert.equal((await api('POST', '/plans', { name: 'X', days: 7 }, staffToken)).status, 403);
    assert.equal((await api('POST', '/gates', { name: 'X' }, staffToken)).status, 403);
    assert.equal((await api('GET', '/staff', null, staffToken)).status, 403);
    assert.equal((await api('POST', '/staff', { email: 'x@test.local', name: 'X', password: MEMBER_PASSWORD }, staffToken)).status, 403);
    assert.equal((await api('GET', '/audit', null, staffToken)).status, 403);
  });

  it('var olan hesap çalışan yapılınca şifresi ve adı değişmez; aynı kişi iki kez eklenemez', async () => {
    const dup = await api('POST', '/staff', { email: 'calisan@test.local' });
    assert.equal(dup.status, 409);
    const linked = await api('POST', '/staff', { email: 'uye1@test.local', name: 'Baska Ad' });
    assert.equal(linked.status, 201);
    assert.equal(linked.body.created, false);
    assert.equal(linked.body.name, 'Uye Bir');
    assert.ok(await s.login('uye1@test.local', MEMBER_PASSWORD));
    assert.equal((await api('POST', '/staff', { email: 'yeni-hesap@test.local' })).status, 400); // yeni hesapta ad/şifre şart
  });

  it('başka salonun sahibi bu salona erişemez', async () => {
    assert.equal((await s.request('GET', `/api/gyms/${gym}/staff`, null, other.token)).status, 404);
    assert.equal((await s.request('GET', `/api/gyms/${gym}/audit`, null, other.token)).status, 404);
    assert.equal((await s.request('DELETE', `/api/gyms/${gym}/staff/${staffId}`, null, other.token)).status, 404);
  });

  it('salonun en az bir sahibi kalır; yetki devri sorunsuz yapılır', async () => {
    const ownerId = (await api('GET', '/staff')).body.find((m) => m.role === 'owner').userId;
    // Tek sahip: ne rolünü düşürebilir ne kendini silebilir
    assert.equal((await api('PATCH', `/staff/${ownerId}`, { role: 'staff' })).status, 400);
    assert.equal((await api('DELETE', `/staff/${ownerId}`)).status, 400);

    // Sevgi sahip yapılır, artık yönetim ekranlarına girebilir
    assert.equal((await api('PATCH', `/staff/${staffId}`, { role: 'owner' })).status, 200);
    assert.equal((await api('GET', '/staff', null, staffToken)).status, 200);

    // İlk sahip kendini sahiplikten düşürür, sonra Sevgi onu çıkarır
    assert.equal((await api('PATCH', `/staff/${ownerId}`, { role: 'staff' })).status, 200);
    assert.equal((await api('GET', '/staff')).status, 403);
    assert.equal((await api('DELETE', `/staff/${ownerId}`, null, staffToken)).status, 200);
    assert.equal((await api('GET', '/members')).status, 404); // artık salonun çalışanı değil

    // Kalan tek sahip (Sevgi) kendini silemez
    assert.equal((await api('DELETE', `/staff/${staffId}`, null, staffToken)).status, 400);
  });

  it('kapı anahtarı yenilenince bağlı cihaz düşer, eski anahtar geçmez, yenisi geçer', async () => {
    const created = await api('POST', '/gates', { name: 'Yan Kapı' }, staffToken);
    assert.equal(created.status, 201);
    const gate = { id: created.body.id, key: created.body.key };

    const device = await s.connectGate(gate);
    await device.ready();

    const rotated = await api('POST', `/gates/${gate.id}/rotate-key`, null, staffToken);
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.body.key, gate.key);
    assert.equal(await device.closed, 4004); // bağlı cihaz hemen düşürüldü

    const oldKey = await s.connectGate(gate);
    assert.equal(await oldKey.closed, 4003); // eski anahtar reddedildi

    const fresh = await s.connectGate({ id: gate.id, key: rotated.body.key });
    await fresh.ready();
    fresh.socket.close();

    // Başka salonun sahibi bu kapıya dokunamaz
    assert.equal((await s.request('POST', `/api/gyms/${other.gymId}/gates/${gate.id}/rotate-key`, null, other.token)).status, 404);
    assert.equal((await s.request('DELETE', `/api/gyms/${other.gymId}/gates/${gate.id}`, null, other.token)).status, 404);
  });

  it('kapı silinince bağlantı kesilir ve cihaz bir daha bağlanamaz', async () => {
    const created = await api('POST', '/gates', { name: 'Eski Kapı' }, staffToken);
    const gate = { id: created.body.id, key: created.body.key };
    const device = await s.connectGate(gate);
    await device.ready();

    assert.equal((await api('DELETE', `/gates/${gate.id}`, null, staffToken)).status, 200);
    assert.equal(await device.closed, 4004);
    assert.equal(await (await s.connectGate(gate)).closed, 4003);
    assert.equal((await api('GET', '/gates', null, staffToken)).body.some((g) => g.id === gate.id), false);
  });

  it('hassas işlemler denetim kaydına yazılır; başka salon bunları görmez', async () => {
    const log = await api('GET', '/audit?limit=200', null, staffToken);
    assert.equal(log.status, 200);
    const actions = log.body.map((e) => e.action);
    for (const expected of ['staff.add', 'member.add', 'staff.role', 'staff.remove', 'gate.create', 'gate.rotate_key', 'gate.delete']) {
      assert.ok(actions.includes(expected), `${expected} kaydı yok`);
    }
    const rotate = log.body.find((e) => e.action === 'gate.rotate_key');
    assert.equal(rotate.actorName, 'Sevgi');
    assert.equal(rotate.details.name, 'Yan Kapı');
    assert.ok(log.body.every((e) => e.targetId !== null || e.action.startsWith('gym.')));

    const foreign = await s.request('GET', `/api/gyms/${other.gymId}/audit`, null, other.token);
    assert.equal(foreign.body.length, 0); // diğer salonda hiçbir işlem yapılmadı, bu salonunkiler sızmaz
  });

  it('ana salonun kapısı hâlâ çalışır (regresyon)', async () => {
    const device = await s.connectGate(GATE);
    await device.ready();
    device.socket.close();
  });
});
