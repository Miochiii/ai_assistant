from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from desktop_adapter.observation_policy import (ObservationPolicyError, ShadowTracker,
                                                analyze_rgb, check_context, compare_observations)


def frame(width, height, changes=None):
    data = bytearray([0]) * (width * height * 3)
    for x, y, rgb in changes or []:
        index = (y * width + x) * 3
        data[index:index + 3] = bytes(rgb)
    return bytes(data)


def manifest(width=8, height=8, **extra):
    value = {"monitor_index": 1,
             "monitor_bounds": {"left": 0, "top": 0, "width": 100, "height": 100},
             "capture_bounds": {"left": 10, "top": 10, "width": width, "height": height},
             "coordinate_space": "physical_desktop_pixels",
             "image": {"width": width, "height": height, "resized": False}}
    value.update(extra)
    return value


class ObservationPolicyTests(unittest.TestCase):
    def test_identical_pixels_are_unchanged_not_success(self):
        result = analyze_rgb(frame(8, 8), frame(8, 8), 8, 8)
        self.assertEqual(result["status"], "unchanged")
        self.assertEqual(result["changed_pixels"], 0)
        self.assertIn("do not prove", result["limitations"][0])

    def test_tiny_color_change_is_detected_and_blocked(self):
        before = frame(8, 8)
        after = frame(8, 8, [(7, 7, (0, 0, 255))])
        result = analyze_rgb(before, after, 8, 8, block_size=4)
        self.assertEqual(result["status"], "changed")
        self.assertEqual(result["changed_pixels"], 1)
        self.assertEqual(result["changed_blocks"][0]["x"], 4)
        self.assertEqual(result["changed_blocks"][0]["y"], 4)

    def test_equal_luminance_different_colour_is_detected(self):
        before = frame(4, 4, [(1, 1, (10, 20, 30))])
        after = frame(4, 4, [(1, 1, (30, 20, 10))])
        result = analyze_rgb(before, after, 4, 4)
        self.assertEqual(result["changed_pixels"], 1)

    def test_geometry_change_invalidates_baseline(self):
        result = check_context(manifest(), manifest(capture_bounds={"left": 11, "top": 10, "width": 8, "height": 8}))
        self.assertEqual(result["status"], "context_changed")
        self.assertIn("capture_bounds", result["reasons"])
        compared = compare_observations(manifest(), manifest(width=9), frame(8, 8), frame(9, 8), block_size=4)
        self.assertEqual(compared["status"], "context_changed")

    def test_window_identity_change_invalidates_baseline(self):
        first = manifest(window={"hwnd": 1, "pid": 2, "class_name": "Notepad"})
        second = manifest(window={"hwnd": 3, "pid": 2, "class_name": "Notepad"})
        result = check_context(first, second)
        self.assertEqual(result["status"], "context_changed")
        self.assertIn("window_identity", result["reasons"])

    def test_critical_region_is_reported_even_when_top_k_omits_it(self):
        before = frame(16, 16)
        after = frame(16, 16, [(0, 0, (1, 1, 1)), (15, 15, (2, 2, 2))])
        result = analyze_rgb(before, after, 16, 16, block_size=8, max_regions=1,
                             critical_regions=[(12, 12, 4, 4)])
        self.assertEqual(result["status"], "changed")
        self.assertEqual(len(result["changed_blocks"]), 1)
        self.assertEqual(result["omitted_regions"], 1)
        self.assertEqual(result["critical_regions"][0]["changed_pixels"], 1)

    def test_invalid_rgb_length_and_critical_bounds_are_rejected(self):
        with self.assertRaisesRegex(ObservationPolicyError, "INVALID_RGB_LENGTH"):
            analyze_rgb(b"", b"", 2, 2)
        with self.assertRaisesRegex(ObservationPolicyError, "CRITICAL_REGION_OUTSIDE_IMAGE"):
            analyze_rgb(frame(2, 2), frame(2, 2), 2, 2, critical_regions=[(1, 1, 2, 2)])

    def test_omitted_regions_are_counted(self):
        before = frame(16, 16)
        after = frame(16, 16, [(0, 0, (1, 1, 1)), (1, 1, (2, 2, 2)), (15, 15, (3, 3, 3))])
        result = analyze_rgb(before, after, 16, 16, block_size=8, max_regions=1)
        self.assertEqual(result["changed_blocks"][0]["changed_pixels"], 2)
        self.assertEqual(result["omitted_regions"], 1)
        self.assertEqual(result["omitted_changed_pixels"], 1)


    def test_shadow_tracker_reports_baseline_change_and_geometry(self):
        tracker = ShadowTracker(block_size=4)
        before = manifest()
        first = tracker.observe(before, frame(8, 8))
        self.assertEqual(first["status"], "baseline")
        same = tracker.observe(before, frame(8, 8))
        self.assertEqual(same["status"], "unchanged")
        changed = tracker.observe(before, frame(8, 8, [(7, 7, (1, 2, 3))]))
        self.assertEqual(changed["status"], "changed")
        moved = tracker.observe(manifest(capture_bounds={"left": 11, "top": 10, "width": 8, "height": 8}),
                                frame(8, 8))
        self.assertEqual(moved["status"], "context_changed")
        self.assertIn("capture_bounds", moved["reasons"])


if __name__ == "__main__":
    unittest.main()
