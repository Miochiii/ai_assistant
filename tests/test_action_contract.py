import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from desktop_adapter.action_contract import (ActionRefused, build_action_request, load_observation,
                                             parse_action_request, target_screen_point)
from desktop_adapter.authorization import create_grant


class ContractFixture:
    def __init__(self, root: Path, width=100, height=100):
        self.root = root
        self.width, self.height = width, height
        self.folder = root / 'results' / 'vision' / 'obs-1'
        self.folder.mkdir(parents=True)
        self.png = b'not-a-real-png-but-hashed'
        (self.folder / 'screen.png').write_bytes(self.png)
        self.rgb = b'\x00' * (width * height * 3)
        (self.folder / 'source.rgb').write_bytes(self.rgb)
        sha = hashlib.sha256(self.png).hexdigest()
        self.manifest = {
            'schema_version': 1,
            'observation_id': 'obs-1',
            'captured_at': datetime.now(timezone.utc).isoformat(),
            'coordinate_space': 'physical_desktop_pixels',
            'monitor_index': 1,
            'capture_bounds': {'left': 10, 'top': 20, 'width': width, 'height': height},
            'image': {'path': str((self.folder / 'screen.png').resolve()), 'width': width,
                      'height': height, 'sha256': sha, 'resized': False},
        }
        self.write_manifest()
        self.binding = {
            'window': {'hwnd': 100, 'pid': 200, 'class_name': 'Notepad',
                       'title': 'test.txt - 记事本', 'rect': [0, 0, 800, 600]},
            'foreground': 100, 'last_input_tick': 123,
            'source_sha256': sha,
            'rgb_sha256': hashlib.sha256(self.rgb).hexdigest(),
        }
        self.write_binding()
        self.grant = create_grant(root, windows=[self.binding['window']], actions=['activate', 'observe', 'click'],
                                  ttl_seconds=600, task='contract test', windows_session=1)

    def write_manifest(self):
        (self.folder / 'observation.json').write_text(
            json.dumps(self.manifest, ensure_ascii=False), encoding='utf-8')

    def write_binding(self):
        (self.folder / 'click-binding.json').write_text(
            json.dumps(self.binding, ensure_ascii=False), encoding='utf-8')

    def request(self, **overrides):
        request = build_action_request(self.folder / 'observation.json', '文件(F)', [34, 51],
                                       'File menu expands', root=self.root, request_id='req-1',
                                       grant_id=self.grant['grant_id'])
        for key, value in overrides.items():
            if key == 'target':
                request['target'].update(value)
            elif key == 'observation':
                request['observation'].update(value)
            else:
                request[key] = value
        return request


class ActionContractTests(unittest.TestCase):
    def test_build_and_load_contract(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            request = parse_action_request(fixture.request(), fixture.root)
            loaded = load_observation(request, fixture.root)
            self.assertEqual((loaded.capture_bounds.left, loaded.capture_bounds.top), (10, 20))
            self.assertEqual(target_screen_point(loaded, request.target), (44, 71))

    def test_wrong_origin_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            request = fixture.request(observation={'desktop_origin': {'left': 11, 'top': 20}})
            parsed = parse_action_request(request, fixture.root)
            with self.assertRaisesRegex(ActionRefused, 'capture_bounds'):
                load_observation(parsed, fixture.root)
            self.assertEqual(parsed.observation.desktop_origin, (11, 20))

    def test_wrong_observation_id_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            request = fixture.request(observation={'observation_id': 'other'})
            parsed = parse_action_request(request, fixture.root)
            with self.assertRaisesRegex(ActionRefused, 'Observation ID'):
                load_observation(parsed, fixture.root)

    def test_wrong_image_hash_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            request = fixture.request(observation={'image_sha256': 'a' * 64})
            parsed = parse_action_request(request, fixture.root)
            with self.assertRaisesRegex(ActionRefused, 'image bytes'):
                load_observation(parsed, fixture.root)

    def test_target_outside_image_is_refused_at_parse(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            with self.assertRaisesRegex(ActionRefused, 'outside'):
                parse_action_request(fixture.request(target={'center': [100, 51]}), fixture.root)

    def test_missing_binding_and_baseline_are_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            (fixture.folder / 'click-binding.json').unlink()
            parsed = parse_action_request(fixture.request(), fixture.root)
            with self.assertRaisesRegex(ActionRefused, 'window binding'):
                load_observation(parsed, fixture.root)
            fixture.write_binding()
            (fixture.folder / 'source.rgb').unlink()
            with self.assertRaisesRegex(ActionRefused, 'pixel baseline'):
                load_observation(parsed, fixture.root)

    def test_resized_image_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            fixture.manifest['image']['resized'] = True
            fixture.write_manifest()
            parsed = parse_action_request(fixture.request(), fixture.root)
            with self.assertRaisesRegex(ActionRefused, 'Resized'):
                load_observation(parsed, fixture.root)

    def test_expired_observation_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            fixture.manifest['captured_at'] = '2020-01-01T00:00:00+00:00'
            fixture.write_manifest()
            parsed = parse_action_request(fixture.request(), fixture.root)
            with self.assertRaisesRegex(ActionRefused, 'stale'):
                load_observation(parsed, fixture.root)

    def test_request_id_cannot_escape_folder(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            with self.assertRaisesRegex(ActionRefused, 'request_id'):
                parse_action_request(fixture.request(request_id='../escape'), fixture.root)

    def test_scroll_is_vertical_bounded_and_separate_from_click_buttons(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            request = fixture.request()
            request['action'] = {'type': 'scroll', 'axis': 'vertical', 'notches': -2}
            parsed = parse_action_request(request, fixture.root)
            self.assertEqual((parsed.action, parsed.scroll.axis, parsed.scroll.notches),
                             ('scroll', 'vertical', -2))
            for bad in ({'type': 'scroll', 'axis': 'horizontal', 'notches': -1},
                        {'type': 'scroll', 'axis': 'vertical', 'notches': 0},
                        {'type': 'scroll', 'axis': 'vertical', 'notches': 4},
                        {'type': 'scroll', 'axis': 'vertical', 'notches': -1, 'button': 'left'}):
                request = fixture.request()
                request['action'] = bad
                with self.assertRaises(ActionRefused):
                    parse_action_request(request, fixture.root)

    def test_navigation_key_is_whitelisted_and_has_no_button_or_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            request = fixture.request()
            request['action'] = {'type': 'key', 'key': 'Left'}
            parsed = parse_action_request(request, fixture.root)
            self.assertEqual((parsed.action, parsed.key.key), ('key', 'Left'))
            for bad in ({'type': 'key', 'key': 'A'},
                        {'type': 'key', 'key': 'Enter'},
                        {'type': 'key', 'key': 'Left', 'button': 'left'}):
                request = fixture.request()
                request['action'] = bad
                with self.assertRaises(ActionRefused):
                    parse_action_request(request, fixture.root)

    def test_text_insert_is_short_single_line_and_rejects_controls(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            request = fixture.request()
            request['action'] = {'type': 'text', 'text': 'abc'}
            parsed = parse_action_request(request, fixture.root)
            self.assertEqual((parsed.action, parsed.text.text), ('text', 'abc'))
            for bad in ({'type': 'text', 'text': 'a\nb'},
                        {'type': 'text', 'text': 'a\tb'},
                        {'type': 'text', 'text': 'x' * 17},
                        {'type': 'text', 'text': 'abc', 'button': 'left'}):
                request = fixture.request()
                request['action'] = bad
                with self.assertRaises(ActionRefused):
                    parse_action_request(request, fixture.root)

    def test_chord_is_limited_to_ctrl_left_right(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            request = fixture.request()
            request['action'] = {'type': 'chord', 'modifiers': ['ctrl'], 'key': 'Left'}
            parsed = parse_action_request(request, fixture.root)
            self.assertEqual((parsed.action, parsed.chord.modifiers, parsed.chord.key),
                             ('chord', ('ctrl',), 'Left'))
            for bad in ({'type': 'chord', 'modifiers': ['ctrl'], 'key': 'A'},
                        {'type': 'chord', 'modifiers': ['alt'], 'key': 'Left'},
                        {'type': 'chord', 'modifiers': ['ctrl', 'shift'], 'key': 'Left'},
                        {'type': 'chord', 'modifiers': ['ctrl'], 'key': 'Left', 'text': 'x'},
                        {'type': 'chord', 'modifiers': ['ctrl'], 'key': 'Left', 'button': 'left'}):
                request = fixture.request()
                request['action'] = bad
                with self.assertRaises(ActionRefused):
                    parse_action_request(request, fixture.root)

    def test_drag_requires_two_in_image_points_with_some_distance(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            request = fixture.request()
            request['action'] = {'type': 'drag', 'end': [60, 80]}
            parsed = parse_action_request(request, fixture.root)
            self.assertEqual((parsed.action, parsed.drag.start, parsed.drag.end),
                             ('drag', (34, 51), (60, 80)))
            for bad in ({'type': 'drag', 'end': [34, 51]},
                        {'type': 'drag', 'end': [9999, 20]},
                        {'type': 'drag', 'end': [60, 80], 'modifiers': ['shift']},
                        {'type': 'drag', 'end': [60, 80], 'button': 'left'}):
                request = fixture.request()
                request['action'] = bad
                with self.assertRaises(ActionRefused):
                    parse_action_request(request, fixture.root)


if __name__ == '__main__':
    unittest.main()


