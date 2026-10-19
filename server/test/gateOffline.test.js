import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { GATE, MEMBER_PASSWORD, OWNER, startServer } from './helpers.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();

describe('Kapı: internet yokken davranış (politika, rapor)', () => {
  let s, gymId, token, staffToken, other;
  const api = (method, path, body, tok = token, gym = gymId) => s.request(method, `/api/gyms/${gym}${path}`, body, tok);

  before(async () => {
    s = await startServer();
    gymId = s.gymId;
    token = await s.login(OWNER.email, OWNER.password);
    other = await s.signupGym('Baska Salon', 'baska@test.local');
    await api('POST', '/staff', { email: 'calisan@test.local', name: 'Cal', password: MEMBER_PASSWORD });
    staffToken = await s.login('calisan@test.local', MEMBER_PASSWORD);
  });
  after(() => s.close());

  /** Kapıya bağlanır; hello_ok içeriğini döndürür. */
  async function connect(gate) {
    const device = await s.connectGate(gate);
    const hello = await device.next('hello_ok');
    return { ...device, hello };
  }

  it('kapı bağlanınca "internet yokken" ayarını öğrenir (varsayılan: açık, 30 sn)', async () => {
    const device = await connect(GATE);
    assert.equal(device.hello.offlinePolicy, 'open');
    assert.equal(device.hello.offlineGraceSeconds, 30);
    device.socket.close();
  });

  it('kapı eklenirken politika seçilebilir; geçersiz değerler reddedilir', async () => {
    const closed = await api('POST', '/gates', { name: 'Kapali Kapi', offlinePolicy: 'closed', offlineGraceSeconds: 5 });
    assert.equal(closed.status, 201);
    assert.equal(closed.body.offlinePolicy, 'closed');
    assert.equal(closed.body.offlineGraceSeconds, 5);

    const device = await connect({ id: closed.body.id, key: closed.body.key });
    assert.equal(device.hello.offlinePolicy, 'closed');
    assert.equal(device.hello.offlineGraceSeconds, 5);
    device.socket.close();

    const plain = await api('POST', '/gates', { name: 'Varsayilan Kapi' });
    assert.equal(plain.body.offlinePolicy, 'open');
    assert.equal(plain.body.offlineGraceSeconds, 30);

    const list = (await api('GET', '/gates')).body;
    assert.deepEqual(list.find((g) => g.id === closed.body.id).offlinePolicy, 'closed');

    assert.equal((await api('POST', '/gates', { name: 'X', offlinePolicy: 'hep-ac' })).status, 400);
    assert.equal((await api('POST', '/gates', { name: 'X', offlineGraceSeconds: -1 })).status, 400);
    assert.equal((await api('POST', '/gates', { name: 'X', offlineGraceSeconds: 4000 })).status, 400);
  });

  it('sahip ayarı değiştirince bağlı kapıya hemen iletilir ve yeni bağlanışta da geçerli olur', async () => {
    const device = await connect(GATE);
    await device.next('qr');

    const res = await api('PATCH', `/gates/${GATE.id}`, { offlinePolicy: 'closed', offlineGraceSeconds: 120 });
    assert.equal(res.status, 200);
    assert.deepEqual(await device.next('config'), { type: 'config', offlinePolicy: 'closed', offlineGraceSeconds: 120 });
    device.socket.close();

    const again = await connect(GATE);
    assert.equal(again.hello.offlinePolicy, 'closed');
    assert.equal(again.hello.offlineGraceSeconds, 120);
    again.socket.close();

    // Tek alanı değiştirmek diğerini korur
    const partial = await api('PATCH', `/gates/${GATE.id}`, { offlinePolicy: 'open' });
    assert.deepEqual([partial.body.offlinePolicy, partial.body.offlineGraceSeconds], ['open', 120]);
    await api('PATCH', `/gates/${GATE.id}`, { offlineGraceSeconds: 30 }); // sonraki testler için varsayılana dön
  });

  it('ayar değişikliği yalnızca sahipte; geçersiz istekler ve başka salon reddedilir; denetime yazılır', async () => {
    assert.equal((await api('PATCH', `/gates/${GATE.id}`, { offlinePolicy: 'closed' }, staffToken)).status, 403);
    assert.equal((await api('PATCH', `/gates/${GATE.id}`, {})).status, 400); // boş istek
    assert.equal((await api('PATCH', `/gates/${GATE.id}`, { name: 'Yeni Ad' })).status, 400); // izin verilmeyen alan
    assert.equal((await api('PATCH', `/gates/${GATE.id}`, { offlinePolicy: 'x' })).status, 400);
    assert.equal((await api('PATCH', `/gates/${GATE.id}`, { offlineGraceSeconds: 99999 })).status, 400);
    assert.equal((await api('PATCH', '/gates/yok-boyle-kapi', { offlinePolicy: 'open' })).status, 404);
    assert.equal((await api('PATCH', `/gates/${GATE.id}`, { offlinePolicy: 'open' }, other.token, other.gymId)).status, 404);

    await api('PATCH', `/gates/${GATE.id}`, { offlinePolicy: 'closed' });
    const log = (await api('GET', '/audit?limit=50')).body;
    const entry = log.find((e) => e.action === 'gate.update');
    assert.equal(entry.details.offlinePolicy, 'closed');
    assert.equal(entry.details.before.offlinePolicy, 'open');
    await api('PATCH', `/gates/${GATE.id}`, { offlinePolicy: 'open' });
  });

  describe('çevrimdışı serbest geçiş raporları', () => {
    const report = (id, from, to) => ({ type: 'offline_report', id, from, to });

    it('geçerli rapor kaydedilir, onaylanır; aynı rapor tekrar gelince çoğalmaz', async () => {
      const device = await connect(GATE);
      const r = report('aaaaaaaa-0001', iso(-10 * MIN), iso(-2 * MIN));
      device.socket.send(JSON.stringify(r));
      assert.deepEqual(await device.next('offline_report_ack'), { type: 'offline_report_ack', id: 'aaaaaaaa-0001', rejected: false });

      device.socket.send(JSON.stringify(r)); // Pi onayı almadan yeniden bağlanıp tekrar yollamış olabilir
      assert.equal((await device.next('offline_report_ack')).rejected, false);

      const events = (await api('GET', '/gates/events')).body;
      assert.equal(events.length, 1);
      assert.equal(events[0].gateId, GATE.id);
      assert.equal(events[0].gateName, 'Ana Giriş');
      assert.equal(events[0].kind, 'offline_open');
      assert.equal(events[0].durationSeconds, 480);
      assert.equal(events[0].clockSuspect, false);
      device.socket.close();
    });

    it('bozuk raporlar reddedilir ama onaylanır (Pi sonsuza dek yeniden denemesin)', async () => {
      const device = await connect(GATE);
      const bad = [
        report('bbbbbbbb-0001', iso(-1 * MIN), iso(-10 * MIN)), // bitiş başlangıçtan önce
        report('bbbbbbbb-0002', 'dun aksam', iso(-1 * MIN)), // tarih değil
        report('bbbbbbbb-0003', iso(-500 * DAY), iso(-1 * MIN)), // 400 günden uzun
      ];
      for (const r of bad) {
        device.socket.send(JSON.stringify(r));
        const ack = await device.next('offline_report_ack');
        assert.equal(ack.id, r.id);
        assert.equal(ack.rejected, true);
      }
      // Kimliği bozuk rapor onaylanamaz (neye onay verileceği bilinmez) ve kaydedilmez
      device.socket.send(JSON.stringify(report('x', iso(-10 * MIN), iso(-1 * MIN))));
      device.socket.send(JSON.stringify(report('cccccccc-0001', iso(-10 * MIN), iso(-1 * MIN))));
      assert.equal((await device.next('offline_report_ack')).id, 'cccccccc-0001'); // ilk onay geçerli olana ait
      assert.equal((await api('GET', '/gates/events')).body.length, 2); // önceki test + bu geçerli rapor
      device.socket.close();
    });

    it('kapının saati saçma ise rapor "saat doğrulanamadı" işaretiyle saklanır', async () => {
      const device = await connect(GATE);
      device.socket.send(JSON.stringify(report('dddddddd-0001', iso(1 * DAY), iso(1 * DAY + 5 * MIN)))); // gelecekte
      device.socket.send(JSON.stringify(report('dddddddd-0002', iso(-200 * DAY), iso(-199 * DAY)))); // çok eski
      assert.equal((await device.next('offline_report_ack')).rejected, false);
      assert.equal((await device.next('offline_report_ack')).rejected, false);
      const events = (await api('GET', '/gates/events')).body;
      assert.equal(events.filter((e) => e.clockSuspect).length, 2);
      assert.equal(events.filter((e) => !e.clockSuspect).length, 2);
      device.socket.close();
    });

    it('kimlik doğrulamadan gelen rapor kaydedilmez, bağlantı kapanır', async () => {
      const before = (await api('GET', '/gates/events')).body.length;
      const wsUrl = s.app.server.address();
      const socket = new WebSocket(`ws://127.0.0.1:${wsUrl.port}/ws/gate`);
      await new Promise((resolve) => socket.once('open', resolve));
      const closed = new Promise((resolve) => socket.once('close', (code) => resolve(code)));
      socket.send(JSON.stringify(report('eeeeeeee-0001', iso(-10 * MIN), iso(-1 * MIN))));
      assert.equal(await closed, 4003);
      assert.equal((await api('GET', '/gates/events')).body.length, before);
    });

    it('olaylar salona özel; çalışan okuyabilir, oturumsuz ve başka salon göremez', async () => {
      assert.equal((await api('GET', '/gates/events', null, staffToken)).status, 200);
      assert.equal((await api('GET', '/gates/events', null, null)).status, 401);
      assert.equal((await api('GET', '/gates/events', null, other.token)).status, 404); // bu salonun adresine başka salonun anahtarıyla
      const theirs = await api('GET', '/gates/events', null, other.token, other.gymId);
      assert.deepEqual(theirs.body, []);
      assert.equal((await api('GET', '/gates/events?limit=0')).status, 400);
      assert.equal((await api('GET', '/gates/events?limit=2')).body.length, 2);
    });

    it('başka salonun kapısı olarak kaydedilen rapor o salona yazılır', async () => {
      const g = (await s.request('POST', `/api/gyms/${other.gymId}/gates`, { name: 'Onun Kapisi' }, other.token)).body;
      const device = await connect({ id: g.id, key: g.key });
      device.socket.send(JSON.stringify(report('ffffffff-0001', iso(-10 * MIN), iso(-1 * MIN))));
      await device.next('offline_report_ack');
      device.socket.close();
      const theirs = (await api('GET', '/gates/events', null, other.token, other.gymId)).body;
      assert.equal(theirs.length, 1);
      assert.equal(theirs[0].gateName, 'Onun Kapisi');
      // Bizim salonumuz bu raporu görmez
      assert.ok((await api('GET', '/gates/events?limit=50')).body.every((e) => e.gateId === GATE.id));
    });
  });
});
