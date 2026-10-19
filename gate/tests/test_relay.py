import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from relay import Relay  # noqa: E402


class RecordingRelay(Relay):
    def __init__(self):
        super().__init__()
        self.log = []

    def _set(self, on):
        self.log.append(on)


def wait_for(predicate, timeout=1.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return True
        time.sleep(0.01)
    return False


class RelayTest(unittest.TestCase):
    def setUp(self):
        self.relay = RecordingRelay()
        self.addCleanup(self.relay.close)

    def test_pulse_turns_on_then_off(self):
        self.relay.pulse(0.15)
        self.assertTrue(wait_for(lambda: self.relay.is_on))
        self.assertTrue(wait_for(lambda: not self.relay.is_on, 1.0))
        self.assertEqual(self.relay.log, [True, False])

    def test_second_pulse_extends_instead_of_cutting_short(self):
        self.relay.pulse(0.3)
        time.sleep(0.15)
        self.relay.pulse(0.3)  # toplam ~0.45 sn çekili kalmalı
        time.sleep(0.2)  # ilk darbenin bitiş zamanı geçti, ama röle hâlâ açık olmalı
        self.assertTrue(self.relay.is_on)
        self.assertTrue(wait_for(lambda: not self.relay.is_on, 1.0))
        self.assertEqual(self.relay.log, [True, False])  # tek açılış, tek kapanış

    def test_short_pulse_never_shortens_a_running_one(self):
        self.relay.pulse(0.4)
        self.relay.pulse(0.01)
        time.sleep(0.2)
        self.assertTrue(self.relay.is_on)

    def test_hold_keeps_relay_on_until_released(self):
        self.relay.hold(True)
        self.assertTrue(wait_for(lambda: self.relay.is_on))
        time.sleep(0.2)
        self.assertTrue(self.relay.is_on)
        self.relay.hold(False)
        self.assertTrue(wait_for(lambda: not self.relay.is_on))

    def test_pulse_ending_during_hold_does_not_lock_the_door(self):
        self.relay.hold(True)
        self.relay.pulse(0.05)
        time.sleep(0.3)  # darbe bitti, ama serbest geçiş sürüyor
        self.assertTrue(self.relay.is_on)
        self.assertEqual(self.relay.log, [True])

    def test_release_during_pulse_keeps_it_on_until_pulse_ends(self):
        self.relay.hold(True)
        self.relay.pulse(0.3)
        time.sleep(0.05)
        self.relay.hold(False)
        time.sleep(0.1)
        self.assertTrue(self.relay.is_on)  # darbe sürüyor
        self.assertTrue(wait_for(lambda: not self.relay.is_on, 1.0))

    def test_close_turns_relay_off(self):
        self.relay.hold(True)
        self.assertTrue(wait_for(lambda: self.relay.is_on))
        self.relay.close()
        self.assertFalse(self.relay.is_on)
        self.assertEqual(self.relay.log[-1], False)

    def test_gpio_error_is_retried_not_fatal(self):
        class Flaky(RecordingRelay):
            fail = 2

            def _set(self, on):
                if self.fail > 0:
                    self.fail -= 1
                    raise OSError("GPIO hatası")
                super()._set(on)

        relay = Flaky()
        self.addCleanup(relay.close)
        relay.hold(True)
        self.assertTrue(wait_for(lambda: relay.is_on, 1.0), "hata sonrası yeniden denemeli")


if __name__ == "__main__":
    unittest.main()
