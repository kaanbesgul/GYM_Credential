import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from offline import OfflineGuard, StateStore  # noqa: E402


class FakeRelay:
    def __init__(self):
        self.held = False
        self.calls = []

    def hold(self, on):
        self.held = on
        self.calls.append(on)


class Clock:
    """Hem monotonic hem duvar saati yerine geçer; testler zamanı elle ilerletir."""

    def __init__(self):
        self.t = 1000.0
        self.start = datetime(2026, 3, 10, 12, 0, 0, tzinfo=timezone.utc)

    def now(self):
        return self.t

    def wall(self):
        return self.start + timedelta(seconds=self.t - 1000.0)

    def advance(self, seconds):
        self.t += seconds


class GuardTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "state.json"
        self.relay = FakeRelay()
        self.clock = Clock()
        self.hold_events = []

    def make(self, policy="open", grace=30):
        return OfflineGuard(
            self.relay, StateStore(self.path), default_policy=policy, default_grace=grace,
            on_hold_change=self.hold_events.append, clock=self.clock.now, wall=self.clock.wall,
        )

    def test_open_policy_waits_for_grace_period(self):
        g = self.make()
        g.on_status("offline")
        self.clock.advance(29)
        g.tick()
        self.assertFalse(self.relay.held, "bekleme süresi dolmadan açılmamalı")
        self.clock.advance(2)
        g.tick()
        self.assertTrue(self.relay.held)
        self.assertEqual(self.hold_events, [True])

    def test_boot_without_connection_counts_from_start(self):
        g = self.make(grace=30)  # sunucuya hiç bağlanmadan açıldı
        self.clock.advance(31)
        g.tick()
        self.assertTrue(self.relay.held)

    def test_closed_policy_never_holds(self):
        g = self.make(policy="closed")
        g.on_status("offline")
        self.clock.advance(10_000)
        g.tick()
        self.assertFalse(self.relay.held)
        self.assertEqual(self.relay.calls, [])

    def test_brief_outage_does_not_open_and_leaves_no_report(self):
        g = self.make()
        g.on_status("online")
        self.clock.advance(100)
        g.on_status("offline")
        self.clock.advance(10)
        g.tick()
        g.on_status("online")
        self.assertFalse(self.relay.held)
        self.assertEqual(g.pending_reports(), [])

    def test_reconnect_attempts_do_not_reset_the_grace_timer(self):
        g = self.make()
        g.on_status("online")
        g.on_status("offline")
        for _ in range(4):  # her deneme: connecting -> offline
            self.clock.advance(9)
            g.on_status("connecting")
            g.on_status("offline")
            g.tick()
        self.assertTrue(self.relay.held, "36 sn kesintiden sonra açılmış olmalı")

    def test_release_on_reconnect_creates_report_until_acked(self):
        g = self.make()
        g.on_status("offline")
        self.clock.advance(31)
        g.tick()
        self.clock.advance(600)
        g.on_status("online")
        self.assertFalse(self.relay.held)
        self.assertEqual(self.hold_events, [True, False])

        reports = g.pending_reports()
        self.assertEqual(len(reports), 1)
        self.assertEqual(reports[0]["from"], "2026-03-10T12:00:31.000Z")
        self.assertEqual(reports[0]["to"], "2026-03-10T12:10:31.000Z")

        # Rapor dosyada saklanır; yeniden başlasa da kaybolmaz, onaylanınca silinir
        again = self.make()
        self.assertEqual(again.pending_reports(), reports)
        again.ack(reports[0]["id"])
        self.assertEqual(self.make().pending_reports(), [])

    def test_revoked_or_unauthorized_device_is_never_released(self):
        for state in ("unauthorized", "revoked"):
            with self.subTest(state=state):
                self.relay = FakeRelay()
                self.path.unlink(missing_ok=True)
                g = self.make()
                g.on_status(state)
                self.clock.advance(10_000)
                g.on_status("connecting")  # yeniden deneme bayrağı silmemeli
                g.on_status("offline")
                g.tick()
                self.assertFalse(self.relay.held)

    def test_revocation_while_holding_locks_the_door_immediately(self):
        g = self.make()
        g.on_status("offline")
        self.clock.advance(31)
        g.tick()
        self.assertTrue(self.relay.held)
        g.on_status("revoked")  # örn. anahtar iptal edildi, sunucu bağlantıyı 4004 ile kesti
        self.assertFalse(self.relay.held)
        self.assertEqual(len(g.pending_reports()), 1)

    def test_blocked_state_is_cleared_only_by_a_successful_login(self):
        g = self.make()
        g.on_status("unauthorized")
        g.on_status("online")
        g.on_status("offline")
        self.clock.advance(31)
        g.tick()
        self.assertTrue(self.relay.held)

    def test_switching_policy_to_closed_releases_the_door(self):
        g = self.make()
        g.on_status("offline")
        self.clock.advance(31)
        g.tick()
        g.set_policy("closed")
        self.assertFalse(self.relay.held)

    def test_policy_and_grace_from_server_are_saved_and_override_config(self):
        g = self.make(policy="closed", grace=30)
        g.set_policy("open", 5)
        again = self.make(policy="closed", grace=30)  # config "closed" diyor ama sunucudan öğrenilen kazanır
        self.assertEqual((again.policy, again.grace_seconds), ("open", 5))

    def test_invalid_policy_values_are_ignored(self):
        g = self.make(policy="open", grace=30)
        g.set_policy("hep-ac", 10)
        g.set_policy("closed", -5)  # geçersiz süre: politika değişir, süre korunur
        self.assertEqual((g.policy, g.grace_seconds), ("closed", 30))
        g.set_policy("open", True)
        self.assertEqual(g.grace_seconds, 30)

    def test_crash_while_holding_is_reported_on_next_boot(self):
        g = self.make()
        g.on_status("offline")
        self.clock.advance(31)
        g.tick()
        self.assertTrue(g.holding)
        # Elektrik gitti: shutdown çağrılmadı, durum dosyasında holding_since kaldı
        self.clock.advance(120)
        rebooted = self.make()
        self.assertFalse(rebooted.holding)
        reports = rebooted.pending_reports()
        self.assertEqual(len(reports), 1)
        self.assertEqual(reports[0]["from"], "2026-03-10T12:00:31.000Z")
        self.assertEqual(reports[0]["to"], "2026-03-10T12:02:31.000Z")

    def test_shutdown_records_the_period(self):
        g = self.make()
        g.on_status("offline")
        self.clock.advance(31)
        g.tick()
        g.shutdown()
        self.assertFalse(self.relay.held)
        self.assertEqual(len(g.pending_reports()), 1)

    def test_corrupt_state_file_does_not_break_startup(self):
        self.path.write_text("{ bozuk json", encoding="utf-8")
        g = self.make(policy="open", grace=7)
        self.assertEqual((g.policy, g.grace_seconds), ("open", 7))


if __name__ == "__main__":
    unittest.main()
