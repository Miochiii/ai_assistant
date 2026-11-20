from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from desktop_adapter.window_context import (WindowContextError, _intersection,
                                            geometry_revision, read_window_context,
                                            region_from_context)


class FakeGui:
    def IsWindow(self, hwnd): return True
    def GetWindowThreadProcessId(self, hwnd): return (1, 123)
    def GetClassName(self, hwnd): return "TestWindow"
    def GetWindowText(self, hwnd): return "Test title"
    def GetWindowRect(self, hwnd): return (100, 50, 300, 150)
    def GetWindow(self, hwnd, flag): return 0
    def GetAncestor(self, hwnd, flag): return hwnd
    def GetForegroundWindow(self): return 7
    def IsWindowVisible(self, hwnd): return True
    def IsIconic(self, hwnd): return False
    def GetClientRect(self, hwnd): return (0, 0, 200, 100)
    def ClientToScreen(self, hwnd, point): return (point[0] + 100, point[1] + 50)


class FakeApi:
    def EnumDisplayMonitors(self): return [(1, None, (0, 0, 500, 500))]
    def GetMonitorInfo(self, hmonitor):
        return {"Monitor": (0, 0, 500, 500), "Work": (0, 0, 500, 500),
                "Flags": 1, "Device": "\\\\.\\DISPLAY1"}


class FakeProcess:
    def GetWindowThreadProcessId(self, hwnd): return (1, 123)


class WindowContextTests(unittest.TestCase):
    def test_geometry_revision_is_stable_and_sensitive(self):
        first = {"window_rect_screen_px": {"left": 10}, "target_window_dpi": 96}
        same = {"target_window_dpi": 96, "window_rect_screen_px": {"left": 10}}
        changed = {"window_rect_screen_px": {"left": 11}, "target_window_dpi": 96}
        self.assertEqual(geometry_revision(first), geometry_revision(same))
        self.assertNotEqual(geometry_revision(first), geometry_revision(changed))

    def test_monitor_intersection_handles_negative_coordinates(self):
        self.assertTrue(_intersection({"left": -100, "top": 0, "width": 200, "height": 100},
                                      {"left": 0, "top": 0, "width": 500, "height": 500}))
        self.assertFalse(_intersection({"left": 600, "top": 0, "width": 100, "height": 100},
                                       {"left": 0, "top": 0, "width": 500, "height": 500}))

    def test_invalid_hwnd_is_explicit(self):
        with self.assertRaisesRegex(WindowContextError, "INVALID_HWND"):
            read_window_context(0)

    def test_region_uses_client_or_window_origin_without_margin(self):
        context = {"geometry": {
            "client_rect_screen_px": {"left": 120, "top": 80, "width": 300, "height": 200},
            "window_rect_screen_px": {"left": 100, "top": 50, "width": 340, "height": 260},
            "visible_frame_rect_screen_px": {"left": 110, "top": 50, "width": 320, "height": 250},
        }}
        self.assertEqual(region_from_context(context, "client", 200, 100), (120, 80, 200, 100))
        self.assertEqual(region_from_context(context, "window", 200, 100), (110, 50, 200, 100))
        with self.assertRaisesRegex(WindowContextError, "WINDOW_TOO_SMALL"):
            region_from_context(context, "client", 301, 100)

    def test_client_rect_is_mapped_to_screen_and_unknowns_are_explicit(self):
        context = read_window_context(7, gui=FakeGui(), win32api=FakeApi(), win32process=FakeProcess())
        self.assertEqual(context["geometry"]["window_rect_screen_px"],
                         {"left": 100, "top": 50, "width": 200, "height": 100})
        self.assertEqual(context["geometry"]["client_rect_screen_px"],
                         {"left": 100, "top": 50, "width": 200, "height": 100})
        self.assertTrue(context["geometry"]["geometry_revision"])
        self.assertEqual(context["capability"]["read_only_available"], True)
        self.assertEqual(context["capability"]["action_context_available"], False)
        self.assertIn("errors", context)


if __name__ == "__main__":
    unittest.main()
