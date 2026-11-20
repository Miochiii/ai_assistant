import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from desktop_adapter.locate import locate_patch
from test_verify import png


def pattern(width, height):
    return [[(x * 37 + y * 91) % 200, (x * 53 + y * 17) % 200, (x * 11 + y * 43) % 200]
            for y in range(height) for x in range(width)]


def canvas(width, height):
    return [[10, 20, 30] * width for _ in range(height)]


def put(rows, left, top, patch, width, height):
    block = pattern(width, height)
    for y in range(height):
        for x in range(width):
            start = (left + x) * 3
            rows[top + y][start:start + 3] = block[y * width + x]


class LocateTests(unittest.TestCase):
    def test_same_layout_finds_original_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows = canvas(120, 80)
            put(rows, 40, 30, None, 24, 16)
            basis = Path(tmp) / 'basis.png'
            fresh = Path(tmp) / 'fresh.png'
            basis.write_bytes(png(120, 80, rows))
            fresh.write_bytes(png(120, 80, rows))
            result = locate_patch(basis, fresh, target_center=[52, 38], patch_size=(24, 16),
                                  search_radius=32, stride=2, min_separation=24)
            self.assertEqual(result['status'], 'found')
            self.assertEqual(result['new_center'], [52, 38])

    def test_shifted_patch_returns_new_center(self):
        with tempfile.TemporaryDirectory() as tmp:
            basis_rows = canvas(120, 80)
            put(basis_rows, 40, 30, None, 24, 16)
            fresh_rows = canvas(120, 80)
            put(fresh_rows, 56, 34, None, 24, 16)
            basis = Path(tmp) / 'basis.png'
            fresh = Path(tmp) / 'fresh.png'
            basis.write_bytes(png(120, 80, basis_rows))
            fresh.write_bytes(png(120, 80, fresh_rows))
            result = locate_patch(basis, fresh, target_center=[52, 38], patch_size=(24, 16),
                                  search_radius=32, stride=2, min_separation=24)
            self.assertEqual(result['status'], 'found')
            self.assertEqual(result['new_center'], [68, 42])

    def test_two_identical_targets_are_ambiguous(self):
        with tempfile.TemporaryDirectory() as tmp:
            basis_rows = canvas(160, 80)
            put(basis_rows, 30, 30, None, 24, 16)
            fresh_rows = canvas(160, 80)
            put(fresh_rows, 30, 30, None, 24, 16)
            put(fresh_rows, 100, 30, None, 24, 16)
            basis = Path(tmp) / 'basis.png'
            fresh = Path(tmp) / 'fresh.png'
            basis.write_bytes(png(160, 80, basis_rows))
            fresh.write_bytes(png(160, 80, fresh_rows))
            result = locate_patch(basis, fresh, target_center=[42, 38], patch_size=(24, 16),
                                  search_radius=80, stride=2, min_separation=24)
            self.assertEqual(result['status'], 'ambiguous')

    def test_missing_target_is_not_found(self):
        with tempfile.TemporaryDirectory() as tmp:
            basis_rows = canvas(120, 80)
            put(basis_rows, 40, 30, None, 24, 16)
            fresh_rows = canvas(120, 80)
            basis = Path(tmp) / 'basis.png'
            fresh = Path(tmp) / 'fresh.png'
            basis.write_bytes(png(120, 80, basis_rows))
            fresh.write_bytes(png(120, 80, fresh_rows))
            result = locate_patch(basis, fresh, target_center=[52, 38], patch_size=(24, 16),
                                  search_radius=32, stride=2)
            self.assertEqual(result['status'], 'not_found')

    def test_hover_background_change_uses_edge_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            basis_rows = [[255, 255, 255] * 120 for _ in range(80)]
            fresh_rows = [[0, 0, 255] * 120 for _ in range(80)]
            for y in range(30, 46):
                for x in range(40, 64):
                    color = [0, 0, 0] if (x // 2) % 2 == 0 else [255, 255, 255]
                    basis_rows[y][x * 3:x * 3 + 3] = color
                    fresh_rows[y][x * 3:x * 3 + 3] = [255, 255, 255] if color == [0, 0, 0] else [0, 0, 255]
            basis = Path(tmp) / 'basis.png'
            fresh = Path(tmp) / 'fresh.png'
            basis.write_bytes(png(120, 80, basis_rows))
            fresh.write_bytes(png(120, 80, fresh_rows))
            result = locate_patch(basis, fresh, target_center=[52, 38], patch_size=(24, 16),
                                  search_radius=32, stride=2, min_separation=24)
            self.assertEqual(result['status'], 'found')
            self.assertEqual(result['method'], 'edge_iou')
            self.assertEqual(result['new_center'], [52, 38])

    def test_different_canvas_size_finds_shifted_patch(self):
        with tempfile.TemporaryDirectory() as tmp:
            basis_rows = canvas(120, 80)
            put(basis_rows, 40, 30, None, 24, 16)
            fresh_rows = canvas(160, 100)
            put(fresh_rows, 56, 44, None, 24, 16)
            basis = Path(tmp) / 'basis.png'
            fresh = Path(tmp) / 'fresh.png'
            basis.write_bytes(png(120, 80, basis_rows))
            fresh.write_bytes(png(160, 100, fresh_rows))
            result = locate_patch(basis, fresh, target_center=[52, 38], patch_size=(24, 16),
                                  search_radius=32, stride=2, min_separation=24)
            self.assertEqual(result['status'], 'found')
            self.assertEqual(result['new_center'], [68, 52])
            self.assertEqual(result['scale'], 1.0)

    def test_finite_scaled_patch(self):
        with tempfile.TemporaryDirectory() as tmp:
            basis_rows = canvas(120, 80)
            put(basis_rows, 40, 30, None, 24, 16)
            fresh_rows = canvas(160, 120)
            block = pattern(24, 16)
            for y in range(24):
                for x in range(36):
                    source = block[(y * 16 // 24) * 24 + (x * 24 // 36)]
                    start = (60 + x) * 3
                    fresh_rows[45 + y][start:start + 3] = source
            basis = Path(tmp) / 'basis.png'
            fresh = Path(tmp) / 'fresh.png'
            basis.write_bytes(png(120, 80, basis_rows))
            fresh.write_bytes(png(160, 120, fresh_rows))
            result = locate_patch(basis, fresh, target_center=[52, 38], patch_size=(24, 16),
                                  search_radius=8, stride=1, min_separation=24,
                                  scales=(1.0, 1.5))
            self.assertEqual(result['status'], 'found')
            self.assertEqual(result['scale'], 1.5)
            self.assertEqual(result['new_center'], [78, 57])

    def test_search_center_limits_the_search(self):
        with tempfile.TemporaryDirectory() as tmp:
            basis_rows = canvas(120, 80)
            put(basis_rows, 40, 30, None, 24, 16)
            fresh_rows = canvas(200, 120)
            put(fresh_rows, 88, 52, None, 24, 16)
            basis = Path(tmp) / 'basis.png'
            fresh = Path(tmp) / 'fresh.png'
            basis.write_bytes(png(120, 80, basis_rows))
            fresh.write_bytes(png(200, 120, fresh_rows))
            result = locate_patch(basis, fresh, target_center=[52, 38], patch_size=(24, 16),
                                  search_radius=8, stride=1, min_separation=24,
                                  search_center=[100, 60])
            self.assertEqual(result['status'], 'found')
            self.assertEqual(result['new_center'], [100, 60])

    def test_scale_and_candidate_inputs_are_bounded(self):
        with tempfile.TemporaryDirectory() as tmp:
            basis = Path(tmp) / 'basis.png'
            fresh = Path(tmp) / 'fresh.png'
            basis.write_bytes(png(120, 80, canvas(120, 80)))
            fresh.write_bytes(png(120, 80, canvas(120, 80)))
            too_many = locate_patch(basis, fresh, target_center=[50, 40],
                                     scales=(0.8, 1.0, 1.2, 1.25, 1.33, 1.5, 2.0, 2.5, 3.0))
            self.assertEqual(too_many['status'], 'unknown')
            bad_scale = locate_patch(basis, fresh, target_center=[50, 40], scales=(3.5,))
            self.assertEqual(bad_scale['status'], 'unknown')


if __name__ == '__main__':
    unittest.main()
