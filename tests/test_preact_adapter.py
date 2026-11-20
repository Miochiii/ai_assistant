import hashlib
import json
import sys
import tempfile
import unittest
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from desktop_adapter.action_contract import EXECUTOR_VERSION
from desktop_adapter.authorization import create_grant
from desktop_adapter.inventory import ProgramRecord, ProgramStep
from preact_adapter import ProgramReplayAdapter

WINDOW = {'hwnd': 42, 'pid': 7, 'class_name': 'Notepad', 'title': 'test.txt - 记事本',
          'rect': [0, 0, 800, 600]}
BASIS_SHA = hashlib.sha256(b'basis').hexdigest()


def make_program(root: Path):
    step = ProgramStep(
        '1', '文件(F)',
        {'observation_id': 'basis-1', 'image_sha256': BASIS_SHA,
         'capture_bounds': {'left': 5, 'top': 5, 'width': 400, 'height': 300},
         'target_center': [22, 47]},
        {'window': {'class_name': 'Notepad', 'title': 'test.txt - 记事本'}},
        {'type': 'click', 'target_label': '文件(F)'},
        {'description': 'File menu is open', 'template': 'runtime/templates/template.png',
         'region': [0, 35, 300, 260], 'tolerance': 16, 'min_similarity': 0.98})
    return ProgramRecord('notepad-test', 1, 'test replay', EXECUTOR_VERSION, (step,),
                         {'status': 'verified', 'executor_version': EXECUTOR_VERSION,
                          'runs': [{'run_id': 'r', 'ok': True, 'expected_matched': True,
                                    'fresh_observation': True, 'executor_version': EXECUTOR_VERSION,
                                    'observation_ids': ['old'], 'receipts': [{'ok': True}]}]},
                         '2026-10-25T00:00:00+00:00')


class FakeClient:
    def __init__(self, after_path):
        self.after_path = after_path
        self.requests = []

    def build(self, manifest, label, center, expected):
        self.requests.append((manifest, label, center, expected))
        return {'manifest': manifest, 'center': center}

    def execute(self, request):
        return {'ok': True, 'observation_id': 'fresh-1', 'after_observation': str(self.after_path),
                'task_success_verified': False}


class FakeVerifier:
    def __init__(self, locate=True, verify=True):
        self.locate = locate
        self.verify = verify

    def __call__(self, template, after, **kwargs):
        if 'basis.png' in str(template):
            wanted = self.locate
        elif 'after' in str(after):
            wanted = self.verify
        else:
            wanted = False
        return {'status': 'passed' if wanted else 'failed', 'similarity': 1.0 if wanted else 0.5}


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.observation_folder = self.root / 'observation'
        self.observation_folder.mkdir()
        self.after_folder = self.root / 'after'
        self.after_folder.mkdir()
        (self.root / 'basis.png').write_bytes(b'basis')
        (self.root / 'runtime' / 'templates').mkdir(parents=True)
        (self.root / 'runtime' / 'templates' / 'template.png').write_bytes(b'template')
        self.observation_path = self.observation_folder / 'observation.json'
        self.observation_path.write_text(json.dumps({
            'observation_id': 'fresh-1', 'image': {'path': str(self.observation_folder / 'screen.png'),
                                                    'width': 400, 'height': 300, 'sha256': 'a' * 64}}))
        (self.observation_folder / 'click-binding.json').write_text(json.dumps({'window': WINDOW}))
        self.after_path = self.after_folder / 'observation.json'
        self.after_path.write_text(json.dumps({'image': {'path': str(self.after_folder / 'screen.png')}}))
        self.client = FakeClient(self.after_path)
        self.program = make_program(self.root)
        self.seen = {}

    def adapter(self, *, windows=None, activation=None, verifier=None, observer=None, locator=None):
        def default_observer(desktop, hwnd, region):
            self.seen['region'] = region
            return {'observation': str(self.observation_path)}
        def found(*args, **kwargs):
            return {'status': 'found', 'new_center': [22, 47], 'similarity': 1.0}
        return ProgramReplayAdapter(
            self.root, self.program, desktop=object(),
            window_source=lambda: [WINDOW] if windows is None else windows,
            activator=lambda hwnd: {'ok': True, 'outcome': 'foreground_confirmed'}
            if activation is None else activation,
            observer=observer or default_observer,
            client=self.client,
            verifier=verifier or FakeVerifier(),
            basis_image=self.root / 'basis.png', require_proof=False, require_authorization=False,
            locator=locator or found)

    def tearDown(self):
        self.tmp.cleanup()

    def test_completed_replay_uses_fresh_observation_and_target(self):
        adapter = self.adapter()
        result = adapter.run()
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(adapter.window['hwnd'], 42)
        self.assertEqual(adapter.region, (5, 5, 400, 300))
        self.assertEqual(self.client.requests[0][2], [22, 47])
        self.assertEqual(result['run']['observation_ids'], ['fresh-1'])

    def test_missing_window_requires_replan_without_observation(self):
        adapter = self.adapter(windows=[])
        result = adapter.run()
        self.assertEqual(result['status'], 'replan_required')
        self.assertEqual(result['reason'], 'WINDOW_NOT_FOUND')
        self.assertEqual(self.client.requests, [])

    def test_failed_activation_stops_without_observation(self):
        adapter = self.adapter(activation={'ok': False, 'error_code': 'FOREGROUND_UNCONFIRMED'})
        result = adapter.run()
        self.assertEqual(result['status'], 'stopped')
        self.assertEqual(result['reason'], 'FOREGROUND_UNCONFIRMED')
        self.assertEqual(self.client.requests, [])

    def test_target_mismatch_requires_replan_without_executor(self):
        adapter = self.adapter(verifier=FakeVerifier(locate=False),
                               locator=lambda *args, **kwargs: {'status': 'not_found'})
        result = adapter.run()
        self.assertEqual(result['status'], 'replan_required')
        self.assertEqual(result['reason'], 'TARGET_NOT_FOUND')
        self.assertEqual(self.client.requests, [])

    def test_expected_mismatch_stops_after_one_execution(self):
        adapter = self.adapter(verifier=FakeVerifier(locate=True, verify=False))
        result = adapter.run()
        self.assertEqual(result['status'], 'stopped')
        self.assertEqual(result['reason'], 'EXPECTED_NOT_VERIFIED')
        self.assertEqual(len(self.client.requests), 1)

    def test_target_already_satisfied_is_unknown(self):
        adapter = self.adapter(verifier=lambda template, after, **kwargs: {'status': 'passed'})
        result = adapter.run()
        self.assertEqual(result['status'], 'stopped')
        self.assertEqual(result['reason'], 'EXPECTED_UNKNOWN')
        self.assertEqual(len(self.client.requests), 1)

    def test_basis_hash_mismatch_requires_replan(self):
        (self.root / 'basis.png').write_bytes(b'changed')
        adapter = self.adapter()
        result = adapter.run()
        self.assertEqual(result['status'], 'replan_required')
        self.assertEqual(result['reason'], 'BASIS_IMAGE_HASH_MISMATCH')
        self.assertEqual(self.client.requests, [])

    def test_missing_task_grant_stops_before_activation(self):
        adapter = ProgramReplayAdapter(self.root, self.program, desktop=object(),
                                       window_source=lambda: [WINDOW],
                                       activator=lambda hwnd: self.fail('must not activate'),
                                       observer=lambda *args: self.fail('must not observe'),
                                       client=self.client, verifier=FakeVerifier(),
                                       basis_image=self.root / 'basis.png', require_proof=False,
                                       require_authorization=True)
        result = adapter.run()
        self.assertEqual(result['status'], 'stopped')
        self.assertEqual(result['reason'], 'AUTHORIZATION_REQUIRED')
        self.assertEqual(self.client.requests, [])

    def test_explicit_task_grant_allows_replay(self):
        grant = create_grant(self.root, windows=[WINDOW], actions=['replay', 'click'],
                             ttl_seconds=600, task='adapter test')

        def observer(desktop, hwnd, region):
            return {'observation': str(self.observation_path)}

        adapter = ProgramReplayAdapter(self.root, self.program, desktop=object(),
                                       window_source=lambda: [WINDOW],
                                       activator=lambda hwnd: {'ok': True},
                                       observer=observer,
                                       client=self.client, verifier=FakeVerifier(),
                                       basis_image=self.root / 'basis.png', require_proof=False,
                                       grant_id=grant['grant_id'], require_authorization=True,
                                       locator=lambda *args, **kwargs: {'status': 'found',
                                                                        'new_center': [22, 47]})
        result = adapter.run()
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['grant']['grant_id'], grant['grant_id'])

    def test_multi_step_program_runs_both_steps(self):
        manifest = self.root / 'results' / 'vision' / 'basis-1' / 'observation.json'
        manifest.parent.mkdir(parents=True)
        manifest.write_text(json.dumps({'observation_id': 'basis-1',
                                        'image': {'path': str(self.root / 'basis.png')}}),
                            encoding='utf-8')
        first = self.program.steps[0]
        second = ProgramStep('2', '编辑(E)', first.visual_basis, first.preconditions,
                             {'type': 'click', 'target_label': '编辑(E)'}, first.expected)
        program = ProgramRecord('notepad-test', 2, 'two steps', EXECUTOR_VERSION, (first, second),
                                self.program.verification, self.program.created_at)

        def observer(desktop, hwnd, region):
            return {'observation': str(self.observation_path)}

        adapter = ProgramReplayAdapter(self.root, program, desktop=object(),
                                       window_source=lambda: [WINDOW],
                                       activator=lambda hwnd: {'ok': True},
                                       observer=observer, client=self.client,
                                       verifier=FakeVerifier(), basis_image=self.root / 'basis.png',
                                       require_proof=False, require_authorization=False,
                                       locator=lambda *args, **kwargs: {'status': 'found',
                                                                        'new_center': [22, 47]})
        result = adapter.run()
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(len(self.client.requests), 2)
        self.assertEqual([step['step_id'] for step in result['steps']], ['1', '2'])
        self.assertEqual(len(result['receipts']), 2)

    def test_multi_step_preflight_fails_before_any_action(self):
        manifest = self.root / 'results' / 'vision' / 'basis-1' / 'observation.json'
        manifest.parent.mkdir(parents=True)
        manifest.write_text(json.dumps({'observation_id': 'basis-1',
                                        'image': {'path': str(self.root / 'basis.png')}}),
                            encoding='utf-8')
        first = self.program.steps[0]
        second = ProgramStep('2', '编辑(E)', first.visual_basis,
                             {'window': {'class_name': 'Other', 'title': 'other'}},
                             {'type': 'click', 'target_label': '编辑(E)'}, first.expected)
        program = ProgramRecord('notepad-test', 2, 'two steps', EXECUTOR_VERSION, (first, second),
                                self.program.verification, self.program.created_at)

        def observer(desktop, hwnd, region):
            return {'observation': str(self.observation_path)}

        adapter = ProgramReplayAdapter(self.root, program, desktop=object(),
                                       window_source=lambda: [WINDOW],
                                       activator=lambda hwnd: {'ok': True},
                                       observer=observer, client=self.client,
                                       verifier=FakeVerifier(), basis_image=self.root / 'basis.png',
                                       require_proof=False, require_authorization=False,
                                       locator=lambda *args, **kwargs: {'status': 'found',
                                                                        'new_center': [22, 47]})
        result = adapter.run()
        self.assertEqual(result['status'], 'replan_required')
        self.assertEqual(result['reason'], 'WINDOW_NOT_FOUND')
        self.assertEqual(result['step_id'], '2')
        self.assertEqual(self.client.requests, [])

    def test_w3_smaller_window_clips_to_current_visible_frame(self):
        context = {'geometry': {
            'visible_frame_rect_screen_px': {'left': 100, 'top': 200, 'width': 300, 'height': 200},
            'client_rect_screen_px': {'left': 110, 'top': 210, 'width': 280, 'height': 180},
            'window_rect_screen_px': {'left': 90, 'top': 195, 'width': 320, 'height': 220},
            'target_window_dpi': 144}}

        class FakeDesktop:
            def physical_pixels(self):
                return nullcontext()

            def window_context(self, hwnd):
                return context

        basis = {'observation_id': 'basis-1', 'image_sha256': BASIS_SHA,
                 'capture_bounds': {'left': 5, 'top': 5, 'width': 400, 'height': 300},
                 'target_center': [22, 47], 'region_space': 'window'}
        step = ProgramStep('1', 'small target', basis,
                           {'window': {'class_name': WINDOW['class_name'], 'title': WINDOW['title']}},
                           {'type': 'click', 'target_label': 'small target'},
                           {'description': 'small', 'template': 'runtime/templates/template.png'})
        program = ProgramRecord('w3-small', 1, 'small window', EXECUTOR_VERSION, (step,),
                                self.program.verification, self.program.created_at)
        adapter = ProgramReplayAdapter(
            self.root, program, desktop=FakeDesktop(), window_source=lambda: [WINDOW],
            activator=lambda hwnd: {'ok': True}, observer=lambda *a, **k: None,
            client=self.client, verifier=FakeVerifier(), basis_image=self.root / 'basis.png',
            require_proof=False, require_authorization=False,
            locator=lambda *a, **k: {'status': 'found', 'new_center': [22, 47]})
        prepared = adapter._preflight(step, 0)
        self.assertEqual(prepared['status'], 'ready')
        state = adapter.states['1']
        self.assertEqual(state['region'], (100, 200, 300, 200))
        self.assertTrue(state['clipped_to_current_window'])

    def test_w3_client_region_scales_and_regions_reach_collaborators(self):
        context = {'schema_version': 1,
                   'identity': {'hwnd': 42, 'pid': 7, 'process_started_at': '2026-01-01T00:00:00+00:00',
                                'class_name': 'Notepad'},
                   'geometry': {'client_rect_screen_px': {'left': 100, 'top': 200,
                                                          'width': 800, 'height': 600},
                                'window_rect_screen_px': {'left': 90, 'top': 150,
                                                          'width': 820, 'height': 660},
                                'target_window_dpi': 144,
                                'geometry_revision': 'g1'}}

        class FakeDesktop:
            def physical_pixels(self):
                return nullcontext()

            def window_context(self, hwnd):
                return context

        basis = {'observation_id': 'basis-1', 'image_sha256': BASIS_SHA,
                 'capture_bounds': {'left': 5, 'top': 5, 'width': 400, 'height': 300},
                 'target_center': [22, 47], 'region_space': 'client',
                 'scale_candidates': [1.0, 1.5], 'search_center': [30, 60]}
        expected = {'description': 'client area changed', 'template': 'runtime/templates/template.png',
                    'template_region': [0, 0, 300, 260],
                    'after_region': [10, 20, 300, 260],
                    'critical_region': [0, 35, 100, 80]}
        step = ProgramStep('1', 'client target', basis,
                           {'window': {'class_name': WINDOW['class_name'], 'title': WINDOW['title']}},
                           {'type': 'click', 'target_label': 'client target'}, expected)
        program = ProgramRecord('w3-test', 1, 'w3', EXECUTOR_VERSION, (step,),
                                self.program.verification, self.program.created_at)
        seen = {'observer': None, 'locator': None, 'verify': []}

        def observer(desktop, hwnd, region, region_space=None):
            seen['observer'] = {'hwnd': hwnd, 'region': region, 'region_space': region_space}
            return {'observation': str(self.observation_path)}

        def locator(*args, **kwargs):
            seen['locator'] = kwargs
            return {'status': 'found', 'new_center': [22, 47], 'scale': 1.0}

        def verifier(template, after, **kwargs):
            seen['verify'].append((str(after), kwargs))
            return {'status': 'failed' if 'observation' in str(after) else 'passed'}

        adapter = ProgramReplayAdapter(
            self.root, program, desktop=FakeDesktop(), window_source=lambda: [WINDOW],
            activator=lambda hwnd: {'ok': True}, observer=observer, client=self.client,
            verifier=verifier, basis_image=self.root / 'basis.png',
            require_proof=False, require_authorization=False, locator=locator)
        result = adapter.run()
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(seen['observer']['region'], (100, 200, 400, 300))
        self.assertEqual(seen['observer']['region_space'], 'client')
        self.assertEqual(seen['locator']['scales'], (1.0, 1.5))
        self.assertEqual(seen['locator']['search_center'], [30, 60])
        self.assertEqual(seen['verify'][0][1]['template_region'], [0, 0, 300, 260])
        self.assertEqual(seen['verify'][0][1]['after_region'], [10, 20, 300, 260])
        self.assertEqual(result['steps'][0]['scales'], [1.0, 1.5])
        self.assertEqual(len(self.client.requests), 1)


if __name__ == '__main__':
    unittest.main()
