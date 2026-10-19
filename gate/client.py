"""Sunucuya WebSocket ile bağlanır; QR kodlarını ve "aç" komutlarını alır."""
import asyncio
import json
import logging

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, WebSocketException

log = logging.getLogger("client")

AUTH_FAILED_CODE = 4003  # anahtar/kapı kimliği hatalı
REVOKED_CODE = 4004  # anahtar yenilendi veya kapı silindi


class GateClient:
    """Olaylar `emit(kind, **data)` ile iletilir:
    status(state, text)  state: connecting | online | offline | unauthorized | revoked
    qr(code), open(name), deny(name, message)
    policy(policy, grace)   sunucudaki "internet yokken" ayarı
    report_ack(id)          çevrimdışı serbest geçiş raporu sunucuya ulaştı

    `get_reports()` bağlanınca sunucuya iletilecek bekleyen raporları verir.
    """

    def __init__(self, server_url, gate_id, gate_key, emit, get_reports=lambda: []):
        self.server_url = server_url
        self.gate_id = gate_id
        self.gate_key = gate_key
        self.emit = emit
        self.get_reports = get_reports

    async def run(self):
        backoff = 1
        while True:
            try:
                self.emit("status", state="connecting", text="Sunucuya bağlanılıyor…")
                async with connect(
                    self.server_url, open_timeout=10, ping_interval=20, ping_timeout=20, max_size=4096
                ) as ws:
                    await ws.send(json.dumps({"type": "hello", "gateId": self.gate_id, "key": self.gate_key}))
                    async for raw in ws:
                        if await self._handle(json.loads(raw), ws):
                            backoff = 1
            except ConnectionClosed as e:
                code = e.rcvd.code if e.rcvd else None
                if code == AUTH_FAILED_CODE:
                    log.error("Sunucu kapıyı reddetti: gate_id/gate_key hatalı")
                    self.emit("status", state="unauthorized", text="Kapı anahtarı hatalı")
                    backoff = 30
                elif code == REVOKED_CODE:
                    log.error("Kapı anahtarı iptal edildi veya kapı silindi")
                    self.emit("status", state="revoked", text="Kapı anahtarı iptal edildi")
                    backoff = 30
                else:
                    log.warning("Bağlantı kapandı (kod=%s)", code)
                    self.emit("status", state="offline", text="Bağlantı koptu, yeniden deneniyor…")
            except (OSError, WebSocketException, asyncio.TimeoutError) as e:
                log.warning("Bağlanılamadı: %s", e)
                self.emit("status", state="offline", text="Sunucuya ulaşılamıyor, yeniden deneniyor…")
            except json.JSONDecodeError:
                log.warning("Sunucudan bozuk mesaj geldi")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)

    async def _handle(self, msg, ws):
        """True dönerse bağlantı sağlıklı kabul edilir (yeniden deneme beklemesi sıfırlanır)."""
        kind = msg.get("type")
        if kind == "hello_ok":
            self._emit_policy(msg)
            # Önce "online": kapı serbest geçişteyse burada bırakılır ve dönemin raporu oluşur
            self.emit("status", state="online", text="Bağlı")
            for report in self.get_reports():
                await ws.send(json.dumps({"type": "offline_report", **report}))
            return True
        if kind == "config":
            self._emit_policy(msg)
        elif kind == "offline_report_ack":
            self.emit("report_ack", id=msg.get("id"))
        elif kind == "qr":
            self.emit("qr", code=msg["code"])
        elif kind == "open":
            self.emit("open", name=msg.get("name", ""))
        elif kind == "deny":
            self.emit("deny", name=msg.get("name", ""), message=msg.get("message", "Giriş reddedildi"))
        return False

    def _emit_policy(self, msg):
        if "offlinePolicy" in msg:
            self.emit("policy", policy=msg["offlinePolicy"], grace=msg.get("offlineGraceSeconds"))
