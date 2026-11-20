import binascii
import struct
import sys
import tempfile
import unittest
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from desktop_adapter.verify import compare_template, read_png


def chunk(kind, body):
    return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', binascii.crc32(kind + body) & 0xffffffff)


def png(width, height, rows):
    raw = b''.join(b'\x00' + bytes(row) for row in rows)
    header = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header)
            + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


def solid(width, height, color=(10, 20, 30)):
    return [list(color) * width for _ in range(height)]


class VerifyTests(unittest.TestCase):
    def test_identical_images_pass_and_dimensions_decode(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'a.png'
            path.write_bytes(png(5, 5, solid(5, 5)))
            image = read_png(path)
            self.assertEqual(image.shape, (5, 5, 3))
            result = compare_template(path, path, tolerance=0, min_similarity=0.99)
            self.assertEqual(result['status'], 'passed')
            self.assertEqual(result['similarity'], 1.0)

    def test_changed_image_fails_with_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            template = Path(tmp) / 'template.png'
            after = Path(tmp) / 'after.png'
            template.write_bytes(png(5, 5, solid(5, 5)))
            changed = solid(5, 5)
            changed[0][0] = 200
            after.write_bytes(png(5, 5, changed))
            result = compare_template(template, after, tolerance=0, min_similarity=0.99)
            self.assertEqual(result['status'], 'failed')
            self.assertLess(result['similarity'], 0.99)
            self.assertEqual(result['changed_bbox'], [0, 0, 1, 1])

    def test_region_outside_image_is_unknown(self):
        with tempfile.TemporaryDirectory() as tmp:
            template = Path(tmp) / 'template.png'
            template.write_bytes(png(5, 5, solid(5, 5)))
            result = compare_template(template, template, region=[0, 0, 6, 5])
            self.assertEqual(result['status'], 'unknown')

    def test_different_dimensions_are_unknown(self):
        with tempfile.TemporaryDirectory() as tmp:
            template = Path(tmp) / 'template.png'
            after = Path(tmp) / 'after.png'
            template.write_bytes(png(5, 5, solid(5, 5)))
            after.write_bytes(png(6, 5, solid(6, 5)))
            result = compare_template(template, after)
            self.assertEqual(result['status'], 'unknown')

    def test_different_canvases_same_crop_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            template = Path(tmp) / 'template.png'
            after = Path(tmp) / 'after.png'
            template.write_bytes(png(6, 6, solid(6, 6, (10, 20, 30))))
            after.write_bytes(png(8, 8, solid(8, 8, (10, 20, 30))))
            result = compare_template(template, after, tolerance=0,
                                      template_region=[1, 1, 4, 4], after_region=[2, 2, 4, 4])
            self.assertEqual(result['status'], 'passed')
            self.assertEqual(result['template_region'], [1, 1, 4, 4])
            self.assertEqual(result['after_region'], [2, 2, 4, 4])

    def test_different_canvases_different_crop_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            template = Path(tmp) / 'template.png'
            after = Path(tmp) / 'after.png'
            template.write_bytes(png(6, 6, solid(6, 6, (10, 20, 30))))
            changed = solid(8, 8, (10, 20, 30))
            changed[2][2 * 3:2 * 3 + 3] = [200, 10, 10]
            after.write_bytes(png(8, 8, changed))
            result = compare_template(template, after, tolerance=0,
                                      template_region=[1, 1, 4, 4], after_region=[2, 2, 4, 4])
            self.assertEqual(result['status'], 'failed')

    def test_critical_region_is_translated_per_canvas(self):
        with tempfile.TemporaryDirectory() as tmp:
            template = Path(tmp) / 'template.png'
            after = Path(tmp) / 'after.png'
            template.write_bytes(png(10, 10, solid(10, 10)))
            changed = solid(12, 12)
            changed[5][5 * 3:5 * 3 + 3] = [200, 10, 10]
            after.write_bytes(png(12, 12, changed))
            result = compare_template(template, after, tolerance=0, min_similarity=0.98,
                                      template_region=[2, 2, 6, 6], after_region=[4, 4, 6, 6],
                                      critical_region=[3, 3, 2, 2],
                                      template_critical_region=[3, 3, 2, 2],
                                      after_critical_region=[5, 5, 2, 2])
            self.assertEqual(result['status'], 'failed')
            self.assertGreater(result['critical_changed_ratio'], 0)
            self.assertEqual(result['critical_after_region'], [5, 5, 2, 2])

    def test_region_size_mismatch_is_unknown(self):
        with tempfile.TemporaryDirectory() as tmp:
            template = Path(tmp) / 'template.png'
            after = Path(tmp) / 'after.png'
            template.write_bytes(png(5, 5, solid(5, 5)))
            after.write_bytes(png(8, 8, solid(8, 8)))
            result = compare_template(template, after, template_region=[0, 0, 3, 3],
                                      after_region=[0, 0, 4, 4])
            self.assertEqual(result['status'], 'unknown')

    def test_occluded_region_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            template = Path(tmp) / 'template.png'
            after = Path(tmp) / 'after.png'
            template.write_bytes(png(10, 10, solid(10, 10)))
            changed = solid(10, 10)
            for y in range(2, 7):
                for x in range(2, 7):
                    changed[y][x * 3:(x + 1) * 3] = [200, 10, 10]
            after.write_bytes(png(10, 10, changed))
            result = compare_template(template, after, tolerance=0, min_similarity=0.98)
            self.assertEqual(result['status'], 'failed')

    def test_critical_region_catches_small_key_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            template = Path(tmp) / 'template.png'
            after = Path(tmp) / 'after.png'
            template.write_bytes(png(10, 10, solid(10, 10)))
            changed = solid(10, 10)
            changed[0][0] = 200
            after.write_bytes(png(10, 10, changed))
            result = compare_template(template, after, tolerance=0, min_similarity=0.98,
                                      critical_region=[0, 0, 2, 2])
            self.assertEqual(result['similarity'], 0.99)
            self.assertGreater(result['critical_changed_ratio'], 0)
            self.assertEqual(result['status'], 'failed')

    def test_critical_region_change_outside_does_not_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            template = Path(tmp) / 'template.png'
            after = Path(tmp) / 'after.png'
            template.write_bytes(png(10, 10, solid(10, 10)))
            changed = solid(10, 10)
            changed[9][9] = 200
            after.write_bytes(png(10, 10, changed))
            result = compare_template(template, after, tolerance=0, min_similarity=0.98,
                                      critical_region=[0, 0, 2, 2])
            self.assertEqual(result['status'], 'passed')
            self.assertEqual(result['critical_changed_ratio'], 0.0)

    def test_critical_region_outside_image_is_unknown(self):
        with tempfile.TemporaryDirectory() as tmp:
            template = Path(tmp) / 'template.png'
            template.write_bytes(png(10, 10, solid(10, 10)))
            result = compare_template(template, template, critical_region=[20, 20, 2, 2])
            self.assertEqual(result['status'], 'unknown')

    def test_invalid_png_is_unknown(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'bad.png'
            path.write_bytes(b'not-a-png')
            result = compare_template(path, path)
            self.assertEqual(result['status'], 'unknown')


if __name__ == '__main__':
    unittest.main()
