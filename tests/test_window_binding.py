import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from desktop_adapter.windows import bind_content
from desktop_adapter import windows


class BindingTests(unittest.TestCase):
    catalog = {
        10: {"path": "C:/Windows/System32/ApplicationFrameHost.exe"},
        20: {"path": "C:/Program Files/WindowsApps/CalculatorApp.exe"},
        30: {"path": "C:/Windows/notepad.exe"},
    }

    def test_direct_window(self):
        self.assertEqual(bind_content(100, 30, "notepad", self.catalog, []), (100, 30))

    def test_hosted_window(self):
        self.assertEqual(bind_content(100, 10, "calculator", self.catalog,
                                     [(200, 20, "Windows.UI.Core.CoreWindow")]), (200, 20))

    def test_host_alone_is_not_authority(self):
        with self.assertRaises(ValueError):
            bind_content(100, 10, "calculator", self.catalog, [])

    def test_wrong_content_process_rejected(self):
        with self.assertRaises(ValueError):
            bind_content(100, 10, "calculator", self.catalog,
                         [(200, 30, "Windows.UI.Core.CoreWindow")])

    def test_ambiguous_content_rejected(self):
        with self.assertRaisesRegex(ValueError, "TARGET_AMBIGUOUS"):
            bind_content(100, 10, "calculator", self.catalog,
                         [(200, 20, "Windows.UI.Core.CoreWindow"), (201, 20, "Windows.UI.Core.CoreWindow")])

    def test_missing_process_metadata_is_not_reported_as_app_absence(self):
        fake_gui = SimpleNamespace(EnumWindows=lambda callback, data: None)
        with patch.dict(sys.modules, {"win32gui": fake_gui}), patch.object(windows, "process_catalog", return_value={}):
            result = windows.list_windows("calculator")
        self.assertEqual(result["windows"], [])
        self.assertEqual(result["diagnostics"], ["NO_ALLOWED_PROCESS_METADATA"])

    def test_visible_window_absence_distinct_from_missing_metadata(self):
        fake_gui = SimpleNamespace(EnumWindows=lambda callback, data: None)
        with patch.dict(sys.modules, {"win32gui": fake_gui}), patch.object(windows, "process_catalog", return_value=self.catalog):
            result = windows.list_windows("calculator")
        self.assertEqual(result["matching_process_count"], 1)
        self.assertEqual(result["diagnostics"], ["NO_MATCHING_VISIBLE_WINDOW"])
