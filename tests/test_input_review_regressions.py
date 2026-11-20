"""Regression fixtures never send input or capture the user's screen."""
import ctypes as C
import json
import os
from pathlib import Path
import shutil
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'src'), str(ROOT / 'tests')]
from desktop_adapter.action_contract import ActionRefused
from desktop_adapter.action_client import ActionClient
from desktop_adapter.authorization import create_grant
from desktop_adapter.executor import _focus_checked, _release_state
from desktop_adapter.single_click import Win32Desktop, text_receiver_kind
from test_action_contract import ContractFixture
from test_executor import FakeDragDesktop, FakeTextDesktop, FakeKeyDesktop, make


class InputReviewTests(unittest.TestCase):
    def setUp(self):
        self.root = ROOT / 'tmp' / ('input-review-' + uuid4().hex)
        self.root.mkdir(parents=True)
        self.addCleanup(lambda: shutil.rmtree(self.root))
        self.fixture = ContractFixture(self.root)

    def request(self, action, *, session=None):
        grant = create_grant(self.root, windows=[self.fixture.binding['window']],
                             actions=[action['type']], windows_session=1, harness_session=session)
        return self.fixture.request(action=action, authorization_grant=grant['grant_id'])

    def test_drag_maps_both_points_and_path_into_screen_space(self):
        seen = []
        class Drag(FakeDragDesktop):
            def check_window_point(self, binding, point):
                seen.append(point)
            def drag(self, display, start, end, **kwargs):
                self.actual_points = (start, end)
                return super().drag(display, start, end, **kwargs)
        desktop = Drag(self.fixture.binding['window'])
        result = make(self.fixture, desktop=desktop)[0].execute(self.request({'type': 'drag', 'end': [60, 80]}))
        self.assertTrue(result['ok'], result)
        self.assertEqual(desktop.actual_points, ((44, 71), (70, 100)))
        self.assertIn((70, 100), seen)

    def test_drag_without_monitor_refuses_before_any_input(self):
        desktop = FakeKeyDesktop(self.fixture.binding['window'])
        result = make(self.fixture, desktop=desktop)[0].execute(self.request({'type': 'drag', 'end': [60, 80]}))
        self.assertEqual(result['error_code'], 'DRAG_MONITOR_UNAVAILABLE')
        self.assertEqual(result['input_events_sent'], 0)

    def test_drag_failed_initial_move_does_not_invent_accepted_input(self):
        class Drag(FakeDragDesktop):
            def drag(self, display, start, end, *, trace, **kwargs):
                trace.update(move_events_accepted=0, drag_down_accepted=0,
                             drag_moves_accepted=0, drag_up_accepted=0)
                raise RuntimeError('initial move rejected')
        result = make(self.fixture, desktop=Drag(self.fixture.binding['window']))[0].execute(
            self.request({'type': 'drag', 'end': [60, 80]}))
        self.assertEqual(result['input_events_sent'], 0)
        self.assertEqual(result['outcome'], 'refused')

    def test_partial_drag_cancel_preserves_input_and_unknown_journal(self):
        class Drag(FakeDragDesktop):
            def drag(self, display, start, end, *, trace, **kwargs):
                trace.update(drag_down_accepted=1, drag_moves_accepted=3,
                             drag_up_accepted=1, drag_release_attempted=True)
                raise ActionRefused('CANCELLED_DURING_DRAG', 'fixture cancel')
        result = make(self.fixture, desktop=Drag(self.fixture.binding['window']))[0].execute(
            self.request({'type': 'drag', 'end': [60, 80]}))
        self.assertEqual(result['outcome'], 'unknown_after_input')
        self.assertEqual(result['input_events_sent'], 5)
        record = json.loads(next((self.root / 'runtime/operations').glob('*.json')).read_text())
        self.assertEqual(record['phase'], 'unknown')

    def test_partial_text_cancel_preserves_accepted_events(self):
        class Text(FakeTextDesktop):
            def insert_text(self, text, *, trace, before_batch):
                before_batch()
                trace['text_events_accepted'] = 16
                raise ActionRefused('CANCELLED_BEFORE_TEXT', 'fixture second batch cancelled')
        desktop = Text(self.fixture.binding['window'])
        self.fixture.binding['focus'] = desktop.focus
        self.fixture.write_binding()
        result = make(self.fixture, desktop=desktop)[0].execute(self.request({'type': 'text', 'text': '123456789'}))
        self.assertEqual(result['outcome'], 'unknown_after_input')
        self.assertEqual(result['input_events_sent'], 16)

    def test_keyboard_release_failures_stay_pending(self):
        for trace in ({'key_events_accepted': 1, 'key_release_accepted': 0},
                      {'chord_events_accepted': 2, 'chord_cleanup_accepted': 0},
                      {'text_events_accepted': 1, 'text_batch_incomplete': True,
                       'text_cleanup_expected': 8, 'text_cleanup_accepted': 0}):
            with self.subTest(trace=trace):
                receipt = {'input_trace': trace}
                _release_state(receipt)
                self.assertTrue(receipt['pending_or_possible_down'])
                self.assertEqual(receipt['release']['status'], 'attempted_unconfirmed')

    def test_release_ack_does_not_claim_observed_neutral(self):
        receipt = {'input_trace': {'key_events_accepted': 2}}
        _release_state(receipt)
        self.assertEqual(receipt['release']['status'], 'api_release_accepted')

    def test_menu_or_capture_changes_block_even_with_same_focus_hwnd(self):
        for key in ('menu_owner_hwnd', 'capture_hwnd'):
            desktop = FakeKeyDesktop(self.fixture.binding['window'])
            binding = {**self.fixture.binding, 'focus': dict(desktop.focus)}
            desktop.focus[key] = 999
            with self.assertRaises(ActionRefused):
                _focus_checked(desktop, binding)

    def test_text_rejects_unknown_password_readonly_and_selected_receivers(self):
        for field, value in [('supported', False), ('password', True), ('readonly', True),
                             ('selection_collapsed', False)]:
            desktop = FakeTextDesktop(self.fixture.binding['window'])
            desktop.focus['text_receiver'][field] = value
            with self.assertRaises(ActionRefused):
                _focus_checked(desktop, {**self.fixture.binding, 'focus': desktop.focus}, text=True)

    def test_harness_session_mismatch_and_missing_are_rejected(self):
        request = self.request({'type': 'click'}, session='session-A')
        for session in ('', 'session-B'):
            with patch.dict(os.environ, {'DSH_SESSION_ID': session}):
                result = make(self.fixture)[0].execute(request)
            self.assertEqual(result['error_code'], 'AUTHORIZATION_SESSION_MISMATCH')
            self.assertEqual(result['input_events_sent'], 0)
        with patch.dict(os.environ, {'DSH_SESSION_ID': 'session-A'}):
            result = make(self.fixture)[0].execute(request)
        self.assertTrue(result['ok'], result)

    def test_client_passes_trusted_session_to_child_environment(self):
        script = self.root / 'scripts' / 'desktop_executor.py'
        script.parent.mkdir()
        script.write_text('# fixture only', encoding='utf-8')
        client = ActionClient(self.root, harness_session='session-A')
        process = SimpleNamespace(communicate=lambda **kwargs: ('{"ok":true}', ''), returncode=0)
        with patch.object(client, '_client_integrity_refusal', return_value=None), \
             patch('desktop_adapter.action_client.resolve_base_python', return_value=Path(sys.executable)), \
             patch('desktop_adapter.action_client.subprocess.Popen', return_value=process) as launch:
            client.execute({'harness_session': 'untrusted-request-value'})
        self.assertEqual(launch.call_args.kwargs['env']['DSH_SESSION_ID'], 'session-A')

    def test_drag_window_change_mid_gesture_stops(self):
        class Drag(FakeDragDesktop):
            def drag(self, display, start, end, *, trace, before_move, **kwargs):
                trace['drag_down_accepted'] = 1
                self.window['rect'] = [100, 100, 900, 700]
                try:
                    before_move(1)
                finally:
                    trace.update(drag_up_accepted=1, drag_release_attempted=True)
        result = make(self.fixture, desktop=Drag(self.fixture.binding['window']))[0].execute(
            self.request({'type': 'drag', 'end': [60, 80]}))
        self.assertEqual(result['error_code'], 'WINDOW_CHANGED')
        self.assertEqual(result['outcome'], 'unknown_after_input')

    def test_text_receiver_kind_is_capability_based(self):
        self.assertEqual(text_receiver_kind('Edit'), 'win32.edit')
        self.assertEqual(text_receiver_kind('RichEdit20W'), 'win32.richedit')
        self.assertEqual(text_receiver_kind('RichEditD2DPT'), 'win32.richedit')
        self.assertIsNone(text_receiver_kind('Chrome_WidgetWin_1'))
        self.assertIsNone(text_receiver_kind(''))

    def test_observation_can_defer_selection_probe_to_medium_executor(self):
        desktop = FakeTextDesktop(self.fixture.binding['window'])
        prior = {**desktop.focus,
                 'text_receiver': {**desktop.focus['text_receiver'],
                                   'selection_collapsed': None,
                                   'selection_probe': 'unavailable'}}
        _focus_checked(desktop, {**self.fixture.binding, 'focus': prior}, text=True)
        desktop.focus['text_receiver']['selection_collapsed'] = None
        with self.assertRaises(ActionRefused):
            _focus_checked(desktop, {**self.fixture.binding, 'focus': prior}, text=True)

    def test_utf16_chunks_never_split_surrogate_pairs(self):
        batches = []
        desktop = object.__new__(Win32Desktop)
        def send(count, inputs, size):
            batches.append([inputs[i].ki.wScan for i in range(0, count, 2)])
            return count
        desktop.user = SimpleNamespace(SendInput=send, GetAsyncKeyState=lambda _: 0)
        desktop.insert_text('1234567\U0001f600x')
        self.assertEqual(batches[0], list(map(ord, '1234567')))
        self.assertEqual(batches[1], [0xD83D, 0xDE00, ord('x')])
        for chunk in batches:
            raw = b''.join(v.to_bytes(2, 'little') for v in chunk)
            raw.decode('utf-16-le', 'strict')


if __name__ == '__main__':
    unittest.main()
