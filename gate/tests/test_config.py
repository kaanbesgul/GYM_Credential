import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from gate import load_config  # noqa: E402

EXAMPLE = Path(__file__).resolve().parent.parent / "config.example.json"


class ConfigTest(unittest.TestCase):
    def test_example_config_is_clearly_dummy_and_refused(self):
        text = EXAMPLE.read_text(encoding="utf-8")
        self.assertIn("DUMMY", text)
        with self.assertRaises(SystemExit) as ctx:
            load_config(EXAMPLE)
        self.assertIn("DUMMY", str(ctx.exception))

    def test_real_looking_config_is_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.json"
            path.write_text(json.dumps({"server_url": "ws://x/ws/gate", "gate_id": "g_1", "gate_key": "rastgele-anahtar"}), encoding="utf-8")
            self.assertEqual(load_config(path)["gate_id"], "g_1")

    def test_missing_fields_are_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.json"
            path.write_text(json.dumps({"server_url": "ws://x", "gate_id": "g_1"}), encoding="utf-8")
            with self.assertRaises(SystemExit) as ctx:
                load_config(path)
            self.assertIn("gate_key", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
