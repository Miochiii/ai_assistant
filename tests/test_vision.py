"""Coordinate regressions that could otherwise misdirect a later input backend."""
import math
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from desktop_adapter.vision import Rect, screen_point


class GeometryTests(unittest.TestCase):
    def test_negative_monitor_origin_and_crop_offset(self):
        rect = Rect(-1800, 120, 600, 400)
        self.assertEqual(screen_point(rect, (600, 400), 30, 70), (-1770, 190))

    def test_resized_image_uses_physical_capture_dimensions(self):
        self.assertEqual(screen_point(Rect(100, 200, 1500, 900), (1000, 600), 300, 200), (550, 500))

    def test_last_fractional_pixel_stays_inside_capture(self):
        self.assertEqual(screen_point(Rect(0, 0, 1920, 1080), (960, 540), 959.9, 539.9), (1919, 1079))

    def test_invalid_points_fail_instead_of_clamping(self):
        for x, y in [(-1, 0), (100, 0), (0, 100), (math.nan, 5), (5, math.inf), (True, 0)]:
            with self.subTest(x=x, y=y), self.assertRaises(ValueError):
                screen_point(Rect(0, 0, 100, 100), (100, 100), x, y)

    def test_crop_cannot_cross_selected_display(self):
        monitor = Rect(-1920, 0, 1920, 1080)
        self.assertFalse(monitor.contains(Rect(-10, 0, 20, 20)))
        self.assertTrue(monitor.contains(Rect(-100, 0, 100, 100)))

    def test_invalid_rectangles(self):
        for values in [(0, 0, 0, 5), (0, 0, 5, -1), (0, 0, 10000, 10000), (0.5, 0, 5, 5)]:
            with self.subTest(values=values), self.assertRaises(ValueError):
                Rect(*values)


if __name__ == '__main__':
    unittest.main()
