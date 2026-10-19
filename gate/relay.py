"""Kapıyı/turnikeyi açan röle. Simülasyon (PC) ve Raspberry Pi GPIO sürümü."""
import logging
import threading
import time

log = logging.getLogger("relay")


class Relay:
    """Röle şu iki durumdan biri sürdükçe çekili ("açık") kalır:

    - `pulse(saniye)`: belirli süre (üye girişi, resepsiyondan elle açma). Süre dolmadan yeni
      istek gelirse süre uzar.
    - `hold(True)`: sürekli (internet yokken serbest geçiş). `hold(False)` ile bırakılır.

    İkisi birbirini ezmez: serbest geçiş sürerken bir darbe bitse bile röle çekili kalır.
    """

    TICK = 0.02  # röleyi kontrol sıklığı (saniye)

    def __init__(self):
        self._lock = threading.Lock()
        self._deadline = 0.0
        self._held = False
        self._on = False
        self._stop = threading.Event()
        self._worker = None

    @property
    def is_on(self):
        return self._on

    def pulse(self, seconds):
        with self._lock:
            self._deadline = max(self._deadline, time.monotonic() + seconds)
        self._ensure_worker()

    def hold(self, on):
        with self._lock:
            self._held = bool(on)
        self._ensure_worker()

    def _ensure_worker(self):
        with self._lock:
            if self._worker and self._worker.is_alive():
                return
            self._stop.clear()
            self._worker = threading.Thread(target=self._run, daemon=True, name="relay")
            self._worker.start()

    def _run(self):
        while not self._stop.wait(self.TICK):
            with self._lock:
                want = self._held or time.monotonic() < self._deadline
            if want != self._on:
                try:
                    self._set(want)
                    self._on = want
                except Exception:
                    # GPIO hatası: durum değişmedi sayılır, bir sonraki turda yeniden denenir
                    log.exception("Röle durumu değiştirilemedi (istenen=%s)", want)

    def _set(self, on):
        raise NotImplementedError

    def close(self):
        self._stop.set()
        if self._worker:
            self._worker.join(timeout=1)
        try:
            self._set(False)  # çıkarken kapı açık kalmasın (serbest geçiş kuralı ayrıca kapatılır)
        except Exception:
            log.exception("Röle kapatılamadı")
        self._on = False


class SimulatedRelay(Relay):
    def _set(self, on):
        log.info("RÖLE %s (simülasyon)", "AÇIK - kapı açıldı" if on else "KAPALI - kapı kilitlendi")


class GpioRelay(Relay):
    def __init__(self, pin, active_high=False):
        super().__init__()
        from gpiozero import OutputDevice  # yalnızca Raspberry Pi'de gerekir

        # Çoğu röle kartı "active low" çalışır: pin LOW olunca röle çeker
        self._device = OutputDevice(pin, active_high=active_high, initial_value=False)
        log.info("GPIO röle hazır: pin=%s active_high=%s", pin, active_high)

    def _set(self, on):
        if on:
            self._device.on()
        else:
            self._device.off()

    def close(self):
        super().close()
        self._device.close()


def make_relay(cfg):
    mode = cfg.get("mode", "sim")
    if mode == "gpio":
        return GpioRelay(cfg["pin"], cfg.get("active_high", False))
    if mode == "sim":
        return SimulatedRelay()
    raise ValueError(f"Bilinmeyen röle modu: {mode!r} (sim veya gpio olmalı)")
