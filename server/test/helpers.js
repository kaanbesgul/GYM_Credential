import WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { seedDefaults } from '../src/seed.js';

export const OWNER = { email: 'sahip@test.local', password: 'sahip-sifre-123' };
export const GATE = { id: 'kapi-1', key: 'test-gate-key' };
export const MEMBER_PASSWORD = 'uye-sifresi-123';

/** Bellekte veritabanıyla gerçek bir sunucu başlatır. Varsayılan olarak hız sınırı kapalıdır. */
export async function startServer(configOverrides = {}) {
  const db = openDb(':memory:');
  const seeded = seedDefaults(db, {
    ownerEmail: OWNER.email,
    ownerPassword: OWNER.password,
    gymName: 'Salon Bir',
    gateId: GATE.id,
    gateKey: GATE.key,
  });
  const config = loadConfig({
    jwtSecret: 'test-secret',
    rateLimitEnabled: false,
    qrRotateMs: 60_000,
    antiPassbackMs: 60_000,
    ...configOverrides,
  });
  const app = await buildApp({ db, config });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address();
  const base = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws/gate`;

  async function request(method, path, body, token) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    // res.text() UTF-8 BOM'unu sessizce atar; CSV'nin BOM'unu görebilmek için elle çözülür
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer());
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* JSON olmayan yanıt (ör. CSV): ham metin `text` içinde */
    }
    return { status: res.status, body: json, text, headers: res.headers };
  }

  async function login(email, password) {
    const res = await request('POST', '/api/auth/login', { email, password });
    return res.body?.token;
  }

  /** Yeni salon + sahip hesabı açar; { gymId, token } döner. */
  async function signupGym(gymName, email, password = 'sahip-sifre-123') {
    const res = await request('POST', '/api/auth/signup-gym', { gymName, name: `${gymName} Sahibi`, email, password });
    return { gymId: res.body.gyms[0].id, token: res.body.token, email, password };
  }

  /** Kapı cihazını taklit eder: mesajları biriktirir, kapanış kodunu bildirir. */
  async function connectGate(gate) {
    const socket = new WebSocket(wsUrl);
    const messages = [];
    const waiters = [];
    const closed = new Promise((resolve) => socket.once('close', (code) => resolve(code)));
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
    return { socket, next, messages, ready, closed };
  }

  async function close() {
    await app.close();
    db.close();
  }

  return { app, db, config, gymId: seeded.gymId, request, login, signupGym, connectGate, close };
}
