import { randomBytes } from 'node:crypto';

const CODE_PREFIX = 'GYM1';

/**
 * Bağlı kapı cihazlarını ve onların dönen QR kodlarını yönetir.
 * Kodlar sunucuda tutulur: kısa ömürlüdür ve tek kullanımlıktır.
 */
export class GateHub {
  constructor({ rotateMs, ttlMs }) {
    this.rotateMs = rotateMs;
    this.ttlMs = ttlMs;
    this.gates = new Map(); // gateId -> { socket, alive }
    this.codes = new Map(); // nonce -> { gateId, expiresAt }
    this.timer = setInterval(() => this.#tick(), rotateMs);
    this.timer.unref();
  }

  register(gateId, socket) {
    // Aynı kapı yeniden bağlanırsa eskisini kapat
    const previous = this.gates.get(gateId);
    if (previous && previous.socket !== socket) previous.socket.close(4000, 'replaced');

    const entry = { socket, alive: true };
    this.gates.set(gateId, entry);
    socket.on('pong', () => {
      entry.alive = true;
    });
    this.issueQr(gateId);
  }

  unregister(gateId, socket) {
    if (this.gates.get(gateId)?.socket !== socket) return;
    this.gates.delete(gateId);
    for (const [nonce, code] of this.codes) {
      if (code.gateId === gateId) this.codes.delete(nonce);
    }
  }

  /** Anahtar yenilenince veya kapı silinince bağlı cihazın bağlantısını keser. */
  disconnect(gateId, reason = 'revoked') {
    this.gates.get(gateId)?.socket.close(4004, reason);
  }

  isOnline(gateId) {
    return this.gates.has(gateId);
  }

  onlineGateIds() {
    return [...this.gates.keys()];
  }

  issueQr(gateId) {
    const gate = this.gates.get(gateId);
    if (!gate) return null;
    const nonce = randomBytes(16).toString('base64url');
    this.codes.set(nonce, { gateId, expiresAt: Date.now() + this.ttlMs });
    const code = `${CODE_PREFIX}.${gateId}.${nonce}`;
    this.send(gateId, { type: 'qr', code, rotateMs: this.rotateMs });
    return code;
  }

  /** Okutulan kodu doğrular ve tüketir. Başarılıysa { ok: true, gateId } döner. */
  consume(code) {
    const parts = typeof code === 'string' ? code.split('.') : [];
    if (parts.length !== 3 || parts[0] !== CODE_PREFIX) return { ok: false };
    const [, gateId, nonce] = parts;
    const entry = this.codes.get(nonce);
    if (!entry || entry.gateId !== gateId) return { ok: false };
    this.codes.delete(nonce);
    if (entry.expiresAt < Date.now() || !this.gates.has(gateId)) return { ok: false };
    // Kod kullanıldı, ekranda hemen yenisi görünsün
    this.issueQr(gateId);
    return { ok: true, gateId };
  }

  send(gateId, message) {
    const gate = this.gates.get(gateId);
    if (!gate || gate.socket.readyState !== 1) return false;
    gate.socket.send(JSON.stringify(message));
    return true;
  }

  #tick() {
    const now = Date.now();
    for (const [nonce, code] of this.codes) {
      if (code.expiresAt < now) this.codes.delete(nonce);
    }
    for (const [gateId, gate] of this.gates) {
      if (!gate.alive) {
        gate.socket.terminate(); // 'close' olayı kaydı temizler
        continue;
      }
      gate.alive = false;
      gate.socket.ping();
      this.issueQr(gateId);
    }
  }

  close() {
    clearInterval(this.timer);
  }
}
