from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from desktop_adapter.single_click import (FrameChanged, absolute_point, input_delivery_observed,
                                          validate_age, validate_pixels)
from desktop_adapter.single_click import Win32Desktop
from types import SimpleNamespace
from desktop_adapter.vision import Rect


class ClickGuardTests(unittest.TestCase):
    def test_verified_move_precedes_one_button_pair(self):
        events = []
        cursor = [5,5]
        desktop = object.__new__(Win32Desktop)
        def send(count, inputs, size):
            flags = [inputs[i].mi.dwFlags for i in range(count)]
            events.extend(flags)
            if flags == [0xC001]:
                cursor[:] = [50,50]
            return count
        desktop.user = SimpleNamespace(SendInput=send)
        desktop.gui = SimpleNamespace(GetCursorPos=lambda: tuple(cursor))
        def recheck():
            self.assertEqual(events, [0xC001])
        self.assertEqual(desktop.click(Rect(0,0,100,100), (50,50), before_buttons=recheck), 3)
        self.assertEqual(events, [0xC001, 2, 4])

    def test_move_ack_without_effect_never_sends_buttons(self):
        events = []
        desktop = object.__new__(Win32Desktop)
        def send(count, inputs, size):
            events.extend(inputs[i].mi.dwFlags for i in range(count))
            return count
        desktop.user = SimpleNamespace(SendInput=send)
        desktop.gui = SimpleNamespace(GetCursorPos=lambda: (5, 5))
        with self.assertRaisesRegex(RuntimeError, 'POINTER_MOVE_UNCONFIRMED'):
            desktop.click(Rect(0,0,100,100), (50,50))
        self.assertEqual(events, [0xC001])

    def test_window_change_after_move_blocks_buttons(self):
        events = []
        desktop = object.__new__(Win32Desktop)
        def send(count, inputs, size):
            events.extend(inputs[i].mi.dwFlags for i in range(count))
            return count
        desktop.user = SimpleNamespace(SendInput=send)
        desktop.gui = SimpleNamespace(GetCursorPos=lambda: (50,50))
        def changed():
            raise ValueError('Window changed')
        with self.assertRaisesRegex(ValueError, 'Window changed'):
            desktop.click(Rect(0,0,100,100), (50,50), before_buttons=changed)
        self.assertEqual(events, [0xC001])

    def test_api_ack_without_cursor_and_input_change_is_not_delivery(self):
        self.assertFalse(input_delivery_observed((484,145), (2547,579), 100, 100))
        self.assertFalse(input_delivery_observed((484,145), (484,145), 100, 100))
        self.assertFalse(input_delivery_observed((484,145), (2547,579), 100, 101))
        self.assertTrue(input_delivery_observed((484,145), (484,145), 100, 101))

    def test_expired_or_future_observation_rejected(self):
        now = datetime.now(timezone.utc)
        for seconds in (-1, 181):
            with self.assertRaises(ValueError):
                validate_age((now - timedelta(seconds=seconds)).isoformat(), now)
        validate_age(now.isoformat(), now)

    def test_negative_monitor_mapping_and_bounds(self):
        rect = Rect(-1920, 0, 3840, 1080)
        self.assertEqual(absolute_point(rect, (-1920, 0)), (8, 30))
        x, y = absolute_point(rect, (1919, 1079))
        self.assertLess(x, 65536); self.assertLess(y, 65536)
        with self.assertRaises(ValueError):
            absolute_point(rect, (1920, 0))

    def test_target_change_rejected_even_when_global_change_tiny(self):
        source = bytes(100*100*3)
        changed = bytearray(source); changed[(50*100+50)*3] = 255
        with self.assertRaisesRegex(ValueError, 'Target pixels'):
            validate_pixels(source, changed, (100, 100), (50, 50))

    def test_caret_change_away_from_target_allowed_but_large_change_rejected(self):
        source = bytes(100*100*3)
        changed = bytearray(source); changed[0] = 255
        validate_pixels(source, changed, (100, 100), (80, 80))
        with self.assertRaises(ValueError):
            validate_pixels(source, bytes([255])*len(source), (100, 100), (80, 80))

    def test_frame_refusal_carries_local_diagnostics(self):
        source = bytes(100*100*3)
        changed = bytearray(source); changed[(50*100+50)*3] = 255
        with self.assertRaises(FrameChanged) as context:
            validate_pixels(source, changed, (100, 100), (50, 50))
        diagnostics = context.exception.diagnostics
        self.assertEqual(diagnostics["changed_pixels"], 1)
        self.assertTrue(diagnostics["target_changed"])
        self.assertEqual(diagnostics["target_box"], {"left": 18, "top": 34, "width": 65, "height": 33})
        self.assertIsNotNone(diagnostics["changed_bbox"])


if __name__ == '__main__':
    unittest.main()
