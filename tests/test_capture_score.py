import unittest

from tools.coach_overlay.capture_once import score_frame


class CaptureScoreTests(unittest.TestCase):
    def test_first_frame_has_no_delta(self):
        current = bytes([0, 0, 0] * 16)
        score, ratio, bbox, first = score_frame(None, current, 4, 4)
        self.assertEqual(score, 0)
        self.assertEqual(ratio, 0.0)
        self.assertIsNone(bbox)
        self.assertTrue(first)

    def test_identical_frame_is_zero(self):
        current = bytes([20, 40, 60] * 16)
        score, ratio, bbox, first = score_frame(current, current, 4, 4)
        self.assertEqual(score, 0)
        self.assertEqual(ratio, 0.0)
        self.assertIsNone(bbox)
        self.assertFalse(first)

    def test_full_change_is_high_and_has_bbox(self):
        previous = bytes([0, 0, 0] * 64)
        current = bytes([255, 255, 255] * 64)
        score, ratio, bbox, first = score_frame(previous, current, 8, 8)
        self.assertEqual(score, 255)
        self.assertEqual(ratio, 1.0)
        self.assertIsNotNone(bbox)
        self.assertEqual(bbox["width"], 8)
        self.assertEqual(bbox["height"], 8)
        self.assertFalse(first)

    def test_dimension_mismatch_is_unknown_change(self):
        score, ratio, bbox, first = score_frame(b"short", bytes(4 * 4 * 3), 4, 4)
        self.assertEqual(score, 255)
        self.assertEqual(ratio, 1.0)
        self.assertIsNotNone(bbox)
        self.assertFalse(first)


if __name__ == "__main__":
    unittest.main()
