"""GYM Enter kapı uygulaması.

Kullanım:
    python gate.py                  # ekranlı mod (Raspberry Pi'de tam ekran)
    python gate.py --headless       # ekransız mod, olaylar konsola yazılır
    python gate.py --config x.json  # farklı ayar dosyası
"""
import argparse
import asyncio
import json
import logging
import queue
import sys
import threading
import time
from pathlib import Path

from client import GateClient
from offline import OfflineGuard, StateStore
from relay import make_relay

log = logging.getLogger("gate")


def load_config(path):
    try:
        cfg = json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        sys.exit(f"{path} bulunamadı. config.example.json dosyasını config.json olarak kopyalayıp doldurun.")
    for key in ("server_url", "gate_id", "gate_key"):
        if not cfg.get(key):
            sys.exit(f"{path}: '{key}' ayarı eksik")
    return cfg


def main():
    parser = argparse.ArgumentParser(description="GYM Enter kapı uygulaması")
    parser.add_argument("--config", default=str(Path(__file__).with_name("config.json")))
    parser.add_argument("--headless", action="store_true", help="ekran açmadan çalış")
    args = parser.parse_args()

    sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # Windows'ta Türkçe karakterler bozulmasın
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    cfg = load_config(args.config)
    relay = make_relay(cfg.get("relay", {}))
    open_seconds = cfg.get("relay", {}).get("open_seconds", 3)

    ui_events = queue.Queue()

    def to_ui(kind, **data):
        if not args.headless:  # ekran yoksa kuyruğu boşaltacak kimse olmaz
            ui_events.put((kind, data))

    # İnternet yokken kapı davranışı. Ayar panelden gelir ve state.json'da saklanır; yapılandırmadaki
    # değerler yalnızca sunucuya hiç bağlanılmamışsa kullanılır.
    guard = OfflineGuard(
        relay,
        StateStore(Path(args.config).with_name("state.json")),
        default_policy=cfg.get("offline_policy", "closed"),
        default_grace=cfg.get("offline_grace_seconds", 30),
        on_hold_change=lambda active: to_ui("hold", active=active),
    )
    log.info("İnternet yokken: %s (bekleme %s sn)", "kapı SERBEST GEÇİŞE açılır" if guard.policy == "open" else "kapı kapalı kalır", guard.grace_seconds)

    def emit(kind, **data):
        if kind == "open":
            log.info("GİRİŞ İZNİ: %s", data["name"])
            relay.pulse(open_seconds)  # röle tetiklemesi ekrandan bağımsız çalışır
        elif kind == "deny":
            log.info("GİRİŞ REDDEDİLDİ: %s - %s", data["name"], data["message"])
        elif kind == "status":
            log.info("Durum: %s", data["text"])
            guard.on_status(data["state"])
        elif kind == "policy":
            guard.set_policy(data["policy"], data.get("grace"))
        elif kind == "report_ack":
            guard.ack(data["id"])
        elif kind == "qr" and args.headless:
            log.info("QR: %s", data["code"])
        to_ui(kind, **data)

    client = GateClient(cfg["server_url"], cfg["gate_id"], cfg["gate_key"], emit, get_reports=guard.pending_reports)
    network = threading.Thread(target=lambda: asyncio.run(client.run()), daemon=True, name="network")
    network.start()

    def watch():
        while True:
            guard.tick()
            time.sleep(0.5)

    threading.Thread(target=watch, daemon=True, name="offline-watch").start()

    try:
        if args.headless:
            network.join()
        else:
            from ui import GateWindow

            GateWindow(ui_events, cfg.get("fullscreen", False)).run()
    except KeyboardInterrupt:
        pass
    finally:
        guard.shutdown()  # serbest geçiş sürüyorsa dönemi kaydet ve rölenin sürekli çekilmesini bırak
        relay.close()


if __name__ == "__main__":
    main()
