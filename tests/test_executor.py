import hashlib
import json
import os
import sys
import tempfile
import unittest
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from desktop_adapter.executor import DesktopExecutor
from desktop_adapter.authorization import create_grant, grant_dir
from desktop_adapter.vision import Rect
from test_action_contract import ContractFixture


class FakeDesktop:
    def __init__(self, window):
        self.window = dict(window)
        self.tick = 123
        self.cursor = [5, 5]
        self.foreground = window['hwnd']
        self.clicks = 0
        self.gui = SimpleNamespace(GetCursorPos=lambda: tuple(self.cursor),
                                   GetForegroundWindow=lambda: self.foreground)

    @contextmanager
    def physical_pixels(self):
        yield

    def identity(self, hwnd):
        return dict(self.window)

    def input_tick(self):
        return self.tick

    def check_window_point(self, binding, point):
        return None

    def click(self, display, point, *, trace=None, before_buttons=None):
        trace['button_events_accepted'] = 2
        if before_buttons:
            before_buttons()
        self.cursor = list(point)
        self.tick += 1
        self.clicks += 1
        return 3


class FakeScrollDesktop(FakeDesktop):
    def scroll(self, display, point, notches, *, trace=None, before_scroll=None):
        trace['wheel_events_accepted'] = 1
        if before_scroll:
            before_scroll()
        self.cursor = list(point)
        self.tick += 1
        return 2


class FakeKeyDesktop(FakeDesktop):
    def __init__(self, window):
        super().__init__(window)
        self.focus = {'available': True, 'active_hwnd': window['hwnd'],
                      'focus_hwnd': window['hwnd'], 'focus_root_hwnd': window['hwnd'],
                      'capture_hwnd': 0, 'menu_owner_hwnd': 0, 'caret_hwnd': 0}

    def focus_info(self, hwnd):
        return dict(self.focus)

    def press_key(self, key, *, trace=None, before_key=None):
        if before_key:
            before_key()
        trace['key_events_accepted'] = 2
        trace['key_release_accepted'] = 0  # paired key-up already included in the batch
        self.tick += 1
        return 2


class FakeTextDesktop(FakeKeyDesktop):
    def __init__(self, window):
        super().__init__(window)
        self.focus['text_receiver'] = {'supported': True, 'hwnd': window['hwnd'],
                                      'class_name': 'Edit', 'rect': [0, 0, 800, 600],
                                      'password': False, 'readonly': False, 'selection_collapsed': True}

    def insert_text(self, text, *, trace=None, before_batch=None):
        if before_batch:
            before_batch()
        trace['text_units'] = len(text)
        trace['text_events_accepted'] = len(text) * 2
        self.tick += 1
        return len(text) * 2


class FakeChordDesktop(FakeKeyDesktop):
    def press_chord(self, key, *, trace=None, before_chord=None):
        if before_chord:
            before_chord()
        trace['chord_events_accepted'] = 4
        self.tick += 1
        return 4


class FakeDragDesktop(FakeKeyDesktop):
    def check_drag_interference(self):
        pass

    def check_drag_path(self, binding, points):
        pass

    def drag(self, display, start, end, *, trace=None, before_drag=None, before_move=None):
        trace['move_events_accepted'] = 1
        trace['cursor_after_move'] = list(start)
        self.cursor = list(start)
        if before_drag:
            before_drag()
        trace.update(drag_down_accepted=1, drag_moves_accepted=12,
                     drag_release_attempted=True, drag_up_accepted=1)
        for index in range(1, 13):
            if before_move:
                before_move(index)
        self.tick += 1
        return 15


class UnconfirmedDesktop(FakeDesktop):
    def click(self, display, point, *, trace=None, before_buttons=None):
        trace['button_events_accepted'] = 2
        if before_buttons:
            before_buttons()
        self.clicks += 1
        return 3


class CancelBeforeButtonsDesktop(FakeDesktop):
    def __init__(self, window, cancel_path):
        super().__init__(window)
        self.cancel_path = cancel_path

    def click(self, display, point, *, trace=None, before_buttons=None):
        self.cancel_path.write_text('cancel', encoding='utf-8')
        if before_buttons:
            before_buttons()
        self.cursor = list(point)
        self.tick += 1
        self.clicks += 1
        return 3


class CancelAfterInputDesktop(FakeDesktop):
    def __init__(self, window, cancel_path):
        super().__init__(window)
        self.cancel_path = cancel_path

    def click(self, display, point, *, trace=None, before_buttons=None):
        trace['button_events_accepted'] = 2
        if before_buttons:
            before_buttons()
        self.cursor = list(point)
        self.tick += 1
        self.clicks += 1
        self.cancel_path.write_text('cancel', encoding='utf-8')
        return 3


def fake_capture(folder, *, monitor, region, retain_rgb=False):
    folder.mkdir(parents=True, exist_ok=True)
    png = b'after-frame'
    (folder / 'screen.png').write_bytes(png)
    if retain_rgb:
        rgb = bytearray(b'\x00' * (region.width * region.height * 3))
        rgb[0] = 255
        (folder / 'source.rgb').write_bytes(rgb)
    return {'schema_version': 1, 'observation_id': 'after', 'captured_at': datetime.now(timezone.utc).isoformat(),
            'monitor_index': monitor,
            'capture_bounds': {'left': region.left, 'top': region.top,
                               'width': region.width, 'height': region.height},
            'image': {'path': str((folder / 'screen.png').resolve()), 'width': region.width,
                      'height': region.height, 'sha256': hashlib.sha256(png).hexdigest(), 'resized': False}}


def make(fixture, *, integrity=None, session=None, environment=None, grab=None, capture=None, desktop=None):
    desktop = desktop or FakeDesktop(fixture.binding['window'])
    executor = DesktopExecutor(
        fixture.root, desktop=desktop,
        integrity=integrity or (lambda pid: 8192),
        session=session or (lambda pid: 1),
        environment=environment or (lambda: {'session': 1, 'window_station': 'WinSta0', 'desktop': 'Default'}),
        capture_fn=capture or fake_capture,
        grab_fn=grab or (lambda bounds: fixture.rgb),
        display_fn=lambda: Rect(0, 0, 1920, 1080),
        sleep_fn=lambda _: None,
        clock=lambda: datetime.now(timezone.utc))
    return executor, desktop


class ExecutorTests(unittest.TestCase):
    def test_scroll_is_one_bounded_wheel_and_does_not_claim_receiver_delivery(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            grant = create_grant(fixture.root, windows=[fixture.binding['window']],
                                 actions=['activate', 'observe', 'scroll'], ttl_seconds=600,
                                 task='scroll test', windows_session=1)
            request = fixture.request()
            request['authorization_grant'] = grant['grant_id']
            request['operation_id'] = 'scroll-op-1'
            request['action'] = {'type': 'scroll', 'axis': 'vertical', 'notches': -2}
            executor, desktop = make(fixture, desktop=FakeScrollDesktop(fixture.binding['window']))
            result = executor.execute(request)
            self.assertTrue(result['ok'], result)
            self.assertEqual(result['outcome'], 'input_api_accepted')
            self.assertEqual(result['scroll'], {'axis': 'vertical', 'notches': -2})
            self.assertEqual(result['input_events_sent'], 2)
            self.assertEqual(result['gui_clicks_attempted'], 0)
            self.assertEqual(result['release']['status'], 'not_attempted')
            self.assertFalse(result['input_delivery_observed'])

    def test_old_click_grant_does_not_authorize_scroll(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            request = fixture.request()
            request['operation_id'] = 'scroll-not-granted'
            request['action'] = {'type': 'scroll', 'axis': 'vertical', 'notches': -1}
            executor, desktop = make(fixture, desktop=FakeScrollDesktop(fixture.binding['window']))
            result = executor.execute(request)
            self.assertFalse(result['ok'])
            self.assertEqual(result['error_code'], 'AUTHORIZATION_ACTION_NOT_ALLOWED')
            self.assertEqual(result['input_events_sent'], 0)
            self.assertEqual(result['gui_clicks_attempted'], 0)

    def test_navigation_key_requires_focus_and_uses_explicit_key_grant(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            fixture.binding['focus'] = {'available': True, 'active_hwnd': 100,
                                        'focus_hwnd': 100, 'focus_root_hwnd': 100,
                                        'capture_hwnd': 0, 'menu_owner_hwnd': 0, 'caret_hwnd': 0}
            fixture.write_binding()
            grant = create_grant(fixture.root, windows=[fixture.binding['window']],
                                 actions=['activate', 'observe', 'key'], ttl_seconds=600,
                                 task='key test', windows_session=1)
            request = fixture.request()
            request['authorization_grant'] = grant['grant_id']
            request['operation_id'] = 'key-op-1'
            request['action'] = {'type': 'key', 'key': 'Left'}
            executor, desktop = make(fixture, desktop=FakeKeyDesktop(fixture.binding['window']))
            result = executor.execute(request)
            self.assertTrue(result['ok'], result)
            self.assertEqual(result['outcome'], 'input_api_accepted')
            self.assertEqual(result['key'], {'key': 'Left'})
            self.assertEqual(result['input_events_sent'], 2)
            self.assertEqual(result['gui_clicks_attempted'], 0)
            self.assertEqual(result['key_release']['status'], 'api_release_accepted')

    def test_short_text_requires_focus_and_does_not_store_the_body(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            fixture.binding['focus'] = {'available': True, 'active_hwnd': 100,
                                        'focus_hwnd': 100, 'focus_root_hwnd': 100,
                                        'capture_hwnd': 0, 'menu_owner_hwnd': 0, 'caret_hwnd': 0}
            fixture.binding['focus'] = FakeTextDesktop(fixture.binding['window']).focus
            fixture.write_binding()
            grant = create_grant(fixture.root, windows=[fixture.binding['window']],
                                 actions=['activate', 'observe', 'text'], ttl_seconds=600,
                                 task='text test', windows_session=1)
            request = fixture.request()
            request['authorization_grant'] = grant['grant_id']
            request['operation_id'] = 'text-op-1'
            request['action'] = {'type': 'text', 'text': 'abc'}
            executor, desktop = make(fixture, desktop=FakeTextDesktop(fixture.binding['window']))
            result = executor.execute(request)
            self.assertTrue(result['ok'], result)
            self.assertEqual(result['outcome'], 'input_api_accepted')
            self.assertEqual(result['text']['scalars'], 3)
            self.assertEqual(result['input_events_sent'], 6)
            self.assertNotIn('"abc"', json.dumps(result, ensure_ascii=True))
            self.assertEqual(result['gui_clicks_attempted'], 0)

    def test_chord_requires_focus_and_reports_release(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            fixture.binding['focus'] = {'available': True, 'active_hwnd': 100,
                                        'focus_hwnd': 100, 'focus_root_hwnd': 100,
                                        'capture_hwnd': 0, 'menu_owner_hwnd': 0, 'caret_hwnd': 0}
            fixture.write_binding()
            grant = create_grant(fixture.root, windows=[fixture.binding['window']],
                                 actions=['activate', 'observe', 'chord'], ttl_seconds=600,
                                 task='chord test', windows_session=1)
            request = fixture.request()
            request['authorization_grant'] = grant['grant_id']
            request['operation_id'] = 'chord-op-1'
            request['action'] = {'type': 'chord', 'modifiers': ['ctrl'], 'key': 'Right'}
            executor, desktop = make(fixture, desktop=FakeChordDesktop(fixture.binding['window']))
            result = executor.execute(request)
            self.assertTrue(result['ok'], result)
            self.assertEqual(result['outcome'], 'input_api_accepted')
            self.assertEqual(result['chord'], {'modifiers': ['ctrl'], 'key': 'Right'})
            self.assertEqual(result['input_events_sent'], 4)
            self.assertEqual(result['chord_release']['status'], 'api_release_accepted')
            self.assertEqual(result['gui_clicks_attempted'], 0)

    def test_drag_requires_window_preflight_and_reports_release(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            grant = create_grant(fixture.root, windows=[fixture.binding['window']],
                                 actions=['activate', 'observe', 'drag'], ttl_seconds=600,
                                 task='drag test', windows_session=1)
            request = fixture.request()
            request['authorization_grant'] = grant['grant_id']
            request['operation_id'] = 'drag-op-1'
            request['action'] = {'type': 'drag', 'end': [60, 80]}
            executor, desktop = make(fixture, desktop=FakeDragDesktop(fixture.binding['window']))
            result = executor.execute(request)
            self.assertTrue(result['ok'], result)
            self.assertEqual(result['outcome'], 'input_api_accepted')
            self.assertEqual(result['drag'], {'start': [34, 51], 'end': [60, 80]})
            self.assertEqual(result['gui_drags_attempted'], 1)
            self.assertEqual(result['input_events_sent'], 15)
            self.assertEqual(result['release']['status'], 'api_release_accepted')
            self.assertEqual(result['gui_clicks_attempted'], 0)

    def test_medium_executor_delivers_one_click_and_writes_after_observation(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            executor, desktop = make(fixture)
            result = executor.execute(fixture.request())
            self.assertTrue(result['ok'], result)
            self.assertEqual(result['outcome'], 'input_delivered')
            self.assertEqual(result['screen_point'], [44, 71])
            self.assertEqual(result['gui_clicks_attempted'], 1)
            self.assertEqual(result['input_events_sent'], 3)
            self.assertEqual(result['phase'], 'after_input')
            self.assertEqual(result['release']['status'], 'not_needed')
            self.assertFalse(result['pending_or_possible_down'])
            self.assertTrue(result['input_delivery_observed'])
            self.assertEqual(result['executor_integrity']['integrity'], 'medium')
            self.assertEqual(result['integrity']['target']['level'], 'medium')
            self.assertEqual(desktop.clicks, 1)
            self.assertTrue((fixture.folder / 'click.once').exists())
            self.assertFalse((fixture.folder / 'source.rgb').exists())
            self.assertTrue(result['temporary_rgb_removed'])
            self.assertTrue(Path(result['after_observation']).is_file())
            self.assertEqual(result['post_action_delta']['changed_pixel_ratio'], 0.0001)
            self.assertEqual(result['post_action_delta']['changed_bbox'], [0, 0, 1, 1])
            self.assertTrue(result['after_rgb_removed'])
            self.assertTrue((fixture.folder / 'action-req-1.json').is_file())

    def test_post_action_capture_failure_preserves_input_facts(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            executor, desktop = make(
                fixture, capture=lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError('capture failed')))
            result = executor.execute(fixture.request())
            self.assertFalse(result['ok'])
            self.assertEqual(result['error_code'], 'INTERNAL')
            self.assertEqual(result['outcome'], 'unknown_after_input')
            self.assertEqual(result['phase'], 'after_input')
            self.assertEqual(result['gui_clicks_attempted'], 1)
            self.assertEqual(result['input_events_sent'], 3)
            self.assertEqual(desktop.clicks, 1)

    def test_cancel_before_input_prevents_lock_and_click(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            cancel = fixture.root / 'cancel.signal'
            cancel.write_text('cancel', encoding='utf-8')
            executor, desktop = make(fixture)
            with patch.dict(os.environ, {'DSH_EXECUTOR_CANCEL_FILE': str(cancel)}):
                result = executor.execute(fixture.request())
            self.assertFalse(result['ok'])
            self.assertEqual(result['error_code'], 'CANCELLED_BEFORE_INPUT')
            self.assertEqual(result['gui_clicks_attempted'], 0)
            self.assertFalse((fixture.folder / 'click.once').exists())
            self.assertEqual(desktop.clicks, 0)

    def test_cancel_before_buttons_prevents_button_batch(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            cancel = fixture.root / 'cancel.signal'
            desktop = CancelBeforeButtonsDesktop(fixture.binding['window'], cancel)
            executor, _ = make(fixture, desktop=desktop)
            with patch.dict(os.environ, {'DSH_EXECUTOR_CANCEL_FILE': str(cancel)}):
                result = executor.execute(fixture.request())
            self.assertFalse(result['ok'])
            self.assertEqual(result['error_code'], 'CANCELLED_BEFORE_BUTTONS')
            self.assertEqual(result['gui_clicks_attempted'], 0)
            self.assertEqual(result['input_events_sent'], 0)
            self.assertEqual(desktop.clicks, 0)

    def test_cancel_after_input_is_reported_without_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            cancel = fixture.root / 'cancel.signal'
            desktop = CancelAfterInputDesktop(fixture.binding['window'], cancel)
            executor, _ = make(fixture, desktop=desktop)
            with patch.dict(os.environ, {'DSH_EXECUTOR_CANCEL_FILE': str(cancel)}):
                result = executor.execute(fixture.request())
            self.assertFalse(result['ok'])
            self.assertEqual(result['outcome'], 'cancelled_after_input')
            self.assertEqual(result['error_code'], 'CANCELLED_AFTER_INPUT')
            self.assertEqual(result['gui_clicks_attempted'], 1)
            self.assertEqual(result['input_events_sent'], 3)
            self.assertEqual(desktop.clicks, 1)

    def test_executor_requires_a_task_grant(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            executor, desktop = make(fixture)
            result = executor.execute(fixture.request(authorization_grant=None))
            self.assertFalse(result['ok'])
            self.assertEqual(result['error_code'], 'AUTHORIZATION_REQUIRED')
            self.assertEqual(desktop.clicks, 0)

    def test_executor_rejects_expired_window_and_action_grants(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            executor, desktop = make(fixture)
            expired = create_grant(fixture.root, windows=[fixture.binding['window']],
                                   actions=['click'], ttl_seconds=60, windows_session=1)
            path = grant_dir(fixture.root) / f"{expired['grant_id']}.json"
            payload = json.loads(path.read_text(encoding='utf-8'))
            payload['expires_at'] = '2000-01-01T00:00:00+00:00'
            path.write_text(json.dumps(payload), encoding='utf-8')
            result = executor.execute(fixture.request(authorization_grant=expired['grant_id']))
            self.assertEqual(result['error_code'], 'AUTHORIZATION_EXPIRED')
            self.assertEqual(desktop.clicks, 0)
            wrong_window = create_grant(fixture.root,
                                        windows=[{**fixture.binding['window'], 'hwnd': 999}],
                                        actions=['click'], windows_session=1)
            result = executor.execute(fixture.request(authorization_grant=wrong_window['grant_id']))
            self.assertEqual(result['error_code'], 'AUTHORIZATION_WINDOW_NOT_ALLOWED')
            no_click = create_grant(fixture.root, windows=[fixture.binding['window']],
                                    actions=['observe'], windows_session=1)
            result = executor.execute(fixture.request(authorization_grant=no_click['grant_id']))
            self.assertEqual(result['error_code'], 'AUTHORIZATION_ACTION_NOT_ALLOWED')
            self.assertEqual(desktop.clicks, 0)

    def test_low_integrity_executor_refuses_before_reading_the_observation(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            executor, desktop = make(fixture, integrity=lambda pid: 4096)
            result = executor.execute(fixture.request())
            self.assertFalse(result['ok'])
            self.assertEqual(result['error_code'], 'EXECUTOR_INTEGRITY_NOT_MEDIUM')
            self.assertEqual(desktop.clicks, 0)
            self.assertFalse((fixture.folder / 'click.once').exists())
            self.assertTrue((fixture.folder / 'source.rgb').exists())

    def test_high_integrity_target_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            executor, desktop = make(fixture, integrity=lambda pid: 12288 if pid == 200 else 8192)
            result = executor.execute(fixture.request())
            self.assertFalse(result['ok'])
            self.assertEqual(result['error_code'], 'TARGET_INTEGRITY_TOO_HIGH')
            self.assertEqual(desktop.clicks, 0)

    def test_changed_frame_is_refused_without_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            executor, desktop = make(fixture, grab=lambda bounds: bytes([255]) * len(fixture.rgb))
            result = executor.execute(fixture.request())
            self.assertFalse(result['ok'])
            self.assertEqual(result['error_code'], 'FRAME_CHANGED')
            self.assertEqual(result['frame_diagnostics']['changed_ratio'], 1.0)
            self.assertEqual(result['frame_diagnostics']['changed_pixels'],
                             result['frame_diagnostics']['total_pixels'])
            self.assertEqual(desktop.clicks, 0)
            self.assertFalse((fixture.folder / 'click.once').exists())
            self.assertTrue((fixture.folder / 'source.rgb').exists())

    def test_transient_changed_frames_settle_before_input(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            changed = bytes([255]) * len(fixture.rgb)
            frames = iter([changed, changed, fixture.rgb])
            executor, desktop = make(fixture, grab=lambda bounds: next(frames))
            result = executor.execute(fixture.request())
            self.assertTrue(result['ok'], result)
            self.assertEqual(result['outcome'], 'input_delivered')
            self.assertEqual(desktop.clicks, 1)

    def test_consumed_observation_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            (fixture.folder / 'click.once').touch()
            executor, desktop = make(fixture)
            result = executor.execute(fixture.request())
            self.assertFalse(result['ok'])
            self.assertEqual(result['error_code'], 'OBSERVATION_ALREADY_CONSUMED')
            self.assertEqual(desktop.clicks, 0)

    def test_unconfirmed_delivery_reports_failure_without_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            executor, desktop = make(fixture, desktop=UnconfirmedDesktop(fixture.binding['window']))
            result = executor.execute(fixture.request())
            self.assertFalse(result['ok'])
            self.assertEqual(result['error_code'], 'INPUT_DELIVERY_UNCONFIRMED')
            self.assertEqual(result['outcome'], 'input_unconfirmed')
            self.assertFalse(result['input_delivery_observed'])
            self.assertEqual(desktop.clicks, 1)
            self.assertTrue((fixture.folder / 'click.once').exists())

    def test_self_check_reports_medium_and_low(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            medium, _ = make(fixture)
            self.assertTrue(medium.self_check()['ok'])
            self.assertEqual(medium.self_check()['integrity'], 'medium')
            low, _ = make(fixture, integrity=lambda pid: 4096)
            self.assertFalse(low.self_check()['ok'])
            self.assertEqual(low.self_check()['error_code'], 'EXECUTOR_INTEGRITY_NOT_MEDIUM')


if __name__ == '__main__':
    unittest.main()

