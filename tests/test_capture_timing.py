from pathlib import Path
import shutil
import sys
import types
import unittest
from unittest.mock import patch
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from desktop_adapter.vision import Rect, capture


class FakeShot:
    width = 4
    height = 3
    rgb = bytes([7]) * (4 * 3 * 3)


class FakeMSS:
    __version__ = "fake"

    def __init__(self):
        self.monitors = [
            {"left": 0, "top": 0, "width": 100, "height": 100},
            {"left": 10, "top": 10, "width": 100, "height": 100},
        ]

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def grab(self, bounds):
        assert bounds == {"left": 11, "top": 12, "width": 4, "height": 3}
        return FakeShot()


def fake_to_png(rgb, size):
    assert rgb == FakeShot.rgb and size == (4, 3)
    return b"fake-png"


class CaptureTimingTests(unittest.TestCase):
    def test_capture_records_split_timings_without_real_screen(self):
        folder = ROOT / "runtime" / "capture-tests" / str(uuid4())
        self.addCleanup(lambda: shutil.rmtree(folder, ignore_errors=True))
        mss_module = types.ModuleType("mss")
        mss_module.MSS = FakeMSS
        mss_module.__version__ = "fake"
        tools_module = types.ModuleType("mss.tools")
        tools_module.to_png = fake_to_png
        with patch.dict(sys.modules, {"mss": mss_module, "mss.tools": tools_module}):
            observation = capture(folder, monitor=1, region=Rect(11, 12, 4, 3), retain_rgb=True)
        timings = observation["timings"]
        for key in ("capture_ms", "encode_ms", "persist_ms", "total_ms"):
            self.assertIsInstance(timings[key], float)
            self.assertGreaterEqual(timings[key], 0)
        self.assertEqual(observation["elapsed_ms"], timings["total_ms"])
        self.assertTrue((folder / "screen.png").is_file())
        self.assertTrue((folder / "source.rgb").is_file())


if __name__ == "__main__":
    unittest.main()
