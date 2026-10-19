"""İnternet/sunucu erişimi yokken kapının davranışı.

Politika (panelden kapı başına seçilir, sunucu Pi'ye iletir, Pi dosyada saklar):
  - "open":   Sunucuya `grace` saniyeden uzun süre ulaşılamazsa röle sürekli çekili kalır
              (herkes geçebilir). Bağlantı gelince röle bırakılır.
  - "closed": Röle yalnızca sunucu onayıyla açılır; internet yoksa kimse giremez.

Serbest geçişe YALNIZCA gerçekten ağ/sunucu erişimi yokken geçilir. Sunucu bu cihazı bilerek
reddettiyse (anahtar iptal/yenilendi, kapı silindi) kapı asla serbest bırakılmaz: çalınan bir
cihaz bu yolla kullanılamamalı.

Serbest geçiş sırasında kimin girdiği bilinemez; bu yüzden her dönem "şu saatler arası kapı
serbestti" raporu olarak saklanır ve bağlantı gelince sunucuya iletilir.
"""
import json
import logging
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger("offline")

POLICIES = ("open", "closed")
# Sunucunun bu cihazı bilerek geri çevirdiği durumlar: serbest geçiş asla açılmaz
BLOCKED_STATES = ("unauthorized", "revoked")


class StateStore:
    """Küçük bir JSON durum dosyası (atomik yazılır; elektrik kesilse bozulmaz)."""

    def __init__(self, path):
        self.path = Path(path)

    def load(self):
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def save(self, data):
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, self.path)


def _valid_policy(value):
    return value if value in POLICIES else None


def _valid_grace(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 3600 else None


class OfflineGuard:
    def __init__(self, relay, store, default_policy="closed", default_grace=30, on_hold_change=None,
                 clock=time.monotonic, wall=None):
        self._relay = relay
        self._store = store
        self._on_hold_change = on_hold_change or (lambda active: None)
        self._clock = clock
        self._wall = wall or (lambda: datetime.now(timezone.utc))
        self._lock = threading.RLock()

        state = store.load()
        # Sunucudan öğrenilen son değer, yapılandırma dosyasındakinden önceliklidir
        self._policy = _valid_policy(state.get("offline_policy")) or _valid_policy(default_policy) or "closed"
        grace = _valid_grace(state.get("offline_grace_seconds"))
        self._grace = grace if grace is not None else (_valid_grace(default_grace) or 30)
        self._pending = [r for r in state.get("pending_reports", []) if isinstance(r, dict) and r.get("id")]

        # Önceki çalışma serbest geçişteyken kapandıysa (çökme, elektrik): röle açılışta zaten
        # kapalıdır; dönemi şimdi bitir ve rapora ekle.
        self._holding_since = None
        self._holding = False
        stale = state.get("holding_since")
        if stale:
            self._pending.append({"id": uuid.uuid4().hex, "from": stale, "to": self._now_iso()})
            log.warning("Önceki serbest geçiş dönemi kapanmadan sona ermiş, rapora eklendi (%s)", stale)

        self._online = False
        self._blocked = False
        self._down_since = self._clock()  # açılışta sunucuya henüz bağlı değiliz
        self._persist()

    # ---- bilgi ----

    @property
    def policy(self):
        return self._policy

    @property
    def grace_seconds(self):
        return self._grace

    @property
    def holding(self):
        return self._holding

    def pending_reports(self):
        with self._lock:
            return [dict(r) for r in self._pending]

    def ack(self, report_id):
        with self._lock:
            self._pending = [r for r in self._pending if r["id"] != report_id]
            self._persist()

    # ---- olaylar ----

    def set_policy(self, policy, grace_seconds=None):
        """Sunucudan gelen (ya da yapılandırmadaki) politikayı uygular ve saklar."""
        with self._lock:
            policy = _valid_policy(policy)
            if policy is None:
                return
            self._policy = policy
            grace = _valid_grace(grace_seconds)
            if grace is not None:
                self._grace = grace
            self._persist()
            if self._policy != "open":
                self._release("politika 'kapalı' yapıldı")

    def on_status(self, state):
        """Bağlantı durumu: online | connecting | offline | unauthorized | revoked."""
        with self._lock:
            if state == "online":
                self._online = True
                self._blocked = False
                self._down_since = None
                self._release("sunucuya yeniden bağlanıldı")
            elif state in BLOCKED_STATES:
                self._online = False
                self._blocked = True
                self._down_since = None
                self._release(f"sunucu cihazı reddetti ({state})")
            elif state in ("connecting", "offline"):
                self._online = False
                # Reddedilmiş cihaz bağlanamıyorsa bile süre saymaz; "online" olana dek kilitli kalır
                if self._down_since is None and not self._blocked:
                    self._down_since = self._clock()

    def tick(self):
        """Saniyede birkaç kez çağrılır: bekleme süresi dolduysa serbest geçişi başlatır."""
        with self._lock:
            if self._holding:
                if self._policy != "open" or self._online or self._blocked:
                    self._release("koşul kalmadı")  # güvenlik ağı: normalde olaylar zaten bırakır
                return
            if (
                self._policy == "open"
                and not self._online
                and not self._blocked
                and self._down_since is not None
                and self._clock() - self._down_since >= self._grace
            ):
                self._start_hold()

    def shutdown(self):
        """Uygulama kapanırken serbest geçiş dönemi kaydedilsin."""
        with self._lock:
            self._release("uygulama kapanıyor")

    # ---- iç işler ----

    def _start_hold(self):
        self._relay.hold(True)
        self._holding = True
        self._holding_since = self._now_iso()
        self._persist()
        log.warning("İnternet yok (%s sn'den uzun): kapı SERBEST GEÇİŞE açıldı", self._grace)
        self._on_hold_change(True)

    def _release(self, reason):
        if not self._holding:
            return
        self._relay.hold(False)
        self._holding = False
        report = {"id": uuid.uuid4().hex, "from": self._holding_since, "to": self._now_iso()}
        self._pending.append(report)
        self._holding_since = None
        self._persist()
        log.warning("Serbest geçiş sona erdi (%s): %s -> %s", reason, report["from"], report["to"])
        self._on_hold_change(False)

    def _now_iso(self):
        return self._wall().astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

    def _persist(self):
        state = self._store.load()
        state.update(
            offline_policy=self._policy,
            offline_grace_seconds=self._grace,
            holding_since=self._holding_since,
            pending_reports=self._pending,
        )
        try:
            self._store.save(state)
        except OSError:
            log.exception("Durum dosyası yazılamadı")
