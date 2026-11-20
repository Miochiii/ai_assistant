import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from desktop_adapter.inventory import (EXECUTOR_VERSION, ProgramRecord, ProgramRefused, ProgramStep,
                                       load_program, parse_program, replay, save_program, verify_program)
from desktop_adapter.proof import make_proof


def ensure_template(root: Path):
    template = root / 'runtime' / 'templates' / 'template.png'
    template.parent.mkdir(parents=True, exist_ok=True)
    template.write_bytes(b'template')


def make_program(verification=None, action=None):
    step = ProgramStep(
        '1', '文件(F)',
        {'observation_id': 'obs-1', 'image_sha256': 'a' * 64,
         'capture_bounds': {'left': 0, 'top': 0, 'width': 100, 'height': 100},
         'target_center': [34, 51]},
        {'window': {'class_name': 'Notepad', 'title': 'test.txt - 记事本'}},
        action or {'type': 'click', 'target_label': '文件(F)'},
        {'description': 'File menu is open', 'template': 'runtime/templates/template.png'})
    return ProgramRecord('notepad-open-file', 1, 'Open the Notepad File menu', EXECUTOR_VERSION, (step,),
                         verification or {'status': 'draft', 'executor_version': EXECUTOR_VERSION, 'runs': []},
                         '2026-10-25T00:00:00+00:00')


def verified(program, root: Path | None = None, observation_ids=('obs-2',)):
    verification = {'status': 'verified', 'executor_version': program.executor_version,
                    'runs': [{'run_id': 'r1', 'ok': True, 'expected_matched': True,
                              'fresh_observation': True,
                              'executor_version': program.executor_version,
                              'observation_ids': list(observation_ids), 'receipts': [{'ok': True}]}]}
    candidate = ProgramRecord(program.program_id, program.program_version, program.task,
                              program.executor_version, program.steps, verification, program.created_at)
    if root is not None:
        proof = make_proof(Path(root), candidate)
        candidate = ProgramRecord(candidate.program_id, candidate.program_version, candidate.task,
                                  candidate.executor_version, candidate.steps,
                                  {**verification, 'proof': proof}, candidate.created_at)
    return candidate


class FakeClient:
    def __init__(self, result):
        self.result = result
        self.calls = []

    def build(self, manifest, label, center, expected):
        self.calls.append(('build', manifest, label, center, expected))
        return {'manifest': manifest, 'label': label, 'center': center}

    def execute(self, request):
        self.calls.append(('execute', request))
        return self.result


class InventoryTests(unittest.TestCase):
    def test_external_verified_json_is_rejected(self):
        program = verified(make_program())
        with self.assertRaisesRegex(ProgramRefused, 'External input'):
            parse_program(program.to_dict())

    def test_proof_binds_program_content_template_and_runs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ensure_template(root)
            program = verified(make_program(), root)
            self.assertTrue(save_program(root, program).is_file())
            loaded = load_program(root, program.program_id, program.program_version)
            (root / 'runtime' / 'templates' / 'template.png').write_bytes(b'changed')
            with self.assertRaisesRegex(ProgramRefused, 'Template files changed'):
                load_program(root, program.program_id, program.program_version)
            # restore for the next tamper; build a new root avoids the written v1 collision
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ensure_template(root)
            program = verified(make_program(), root)
            tampered_step = ProgramStep(
                '1', '文件(F)', program.steps[0].visual_basis, program.steps[0].preconditions,
                program.steps[0].action, {**program.steps[0].expected, 'region': [1, 1, 10, 10]})
            tampered = ProgramRecord(program.program_id, program.program_version, program.task,
                                     program.executor_version, (tampered_step,), program.verification,
                                     program.created_at)
            with self.assertRaisesRegex(ProgramRefused, 'Program content changed'):
                save_program(root, tampered)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ensure_template(root)
            program = verified(make_program(), root)
            verification = dict(program.verification)
            verification['runs'] = [dict(verification['runs'][0], ok=False)]
            tampered = ProgramRecord(program.program_id, program.program_version, program.task,
                                     program.executor_version, program.steps, verification, program.created_at)
            with self.assertRaisesRegex(ProgramRefused, 'Verification runs changed'):
                save_program(root, tampered)

    def test_draft_cannot_be_stored(self):
        with tempfile.TemporaryDirectory() as tmp:
            ensure_template(Path(tmp))
            with self.assertRaisesRegex(ProgramRefused, 'verified'):
                save_program(Path(tmp), make_program())
            self.assertEqual(list((Path(tmp) / 'runtime').rglob('*.json')), [])

    def test_verified_program_round_trips(self):
        with tempfile.TemporaryDirectory() as tmp:
            ensure_template(Path(tmp))
            program = verified(make_program(), Path(tmp))
            path = save_program(Path(tmp), program)
            self.assertTrue(path.is_file())
            loaded = load_program(Path(tmp), program.program_id, program.program_version)
            self.assertEqual(loaded.program_id, program.program_id)
            self.assertEqual(loaded.steps[0].target_label, '文件(F)')
            self.assertEqual(loaded.verification['status'], 'verified')

    def test_executor_version_mismatch_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            ensure_template(Path(tmp))
            base = ProgramRecord('notepad-open-file', 1, 'Open the Notepad File menu', '0.4.0',
                                 make_program().steps, make_program().verification, make_program().created_at)
            program = verified(base, Path(tmp))
            with self.assertRaisesRegex(ProgramRefused, 'executor version'):
                save_program(Path(tmp), program)

    def test_verification_must_use_a_fresh_observation(self):
        with tempfile.TemporaryDirectory() as tmp:
            ensure_template(Path(tmp))
            program = verified(make_program(), Path(tmp), observation_ids=['obs-1'])
            with self.assertRaisesRegex(ProgramRefused, 'fresh'):
                save_program(Path(tmp), program)

    def test_stored_action_cannot_contain_coordinates(self):
        with tempfile.TemporaryDirectory() as tmp:
            program = make_program(action={'type': 'click', 'target_label': '文件(F)', 'center': [1, 1]})
            with self.assertRaisesRegex(ProgramRefused, 'coordinates'):
                parse_program(program.to_dict())

    def test_replay_stops_on_state_mismatch_before_any_action(self):
        program = verified(make_program())
        client = FakeClient({'ok': True, 'observation_id': 'obs-2'})
        result = replay(program,
                        observe=lambda step: {'observation_id': 'obs-2', 'manifest': 'fresh.json',
                                              'window': {'class_name': 'Notepad', 'title': 'other.txt'}},
                        locate=lambda step, obs: [34, 51], client=client, verify=lambda s, r, o: {'status': 'passed'})
        self.assertEqual(result['status'], 'replan_required')
        self.assertEqual(result['reason'], 'STATE_MISMATCH')
        self.assertEqual(client.calls, [])

    def test_replay_stops_on_missing_target(self):
        program = verified(make_program())
        client = FakeClient({'ok': True, 'observation_id': 'obs-2'})
        result = replay(program,
                        observe=lambda step: {'observation_id': 'obs-2', 'manifest': 'fresh.json',
                                              'window': {'class_name': 'Notepad', 'title': 'test.txt - 记事本'}},
                        locate=lambda step, obs: None, client=client, verify=lambda s, r, o: {'status': 'passed'})
        self.assertEqual(result['status'], 'replan_required')
        self.assertEqual(result['reason'], 'TARGET_NOT_FOUND')
        self.assertEqual(client.calls, [])

    def test_later_step_failure_keeps_prior_receipts(self):
        first = make_program().steps[0]
        second = ProgramStep('2', '文件(F)', first.visual_basis, first.preconditions,
                             first.action, first.expected)
        program = ProgramRecord('multi-failure', 1, 'two steps', EXECUTOR_VERSION,
                                (first, second), verified(make_program()).verification,
                                '2026-10-25T00:00:00+00:00')
        client = FakeClient({'ok': True, 'observation_id': 'obs-2'})
        observations = iter(['obs-2', 'obs-3'])
        locations = iter([[34, 51], None])
        result = replay(program,
                        observe=lambda step: {'observation_id': next(observations),
                                              'manifest': 'fresh.json',
                                              'window': {'class_name': 'Notepad', 'title': 'test.txt - 记事本'}},
                        locate=lambda step, obs: next(locations),
                        client=client,
                        verify=lambda s, r, o: {'status': 'passed'})
        self.assertEqual(result['status'], 'replan_required')
        self.assertEqual(result['step_id'], '2')
        self.assertEqual(result['reason'], 'TARGET_NOT_FOUND')
        self.assertEqual(result['observation_ids'], ['obs-2'])
        self.assertEqual(len(result['receipts']), 1)
        self.assertEqual(len([call for call in client.calls if call[0] == 'execute']), 1)

    def test_replay_stops_on_executor_refusal_without_retry(self):
        program = verified(make_program())
        client = FakeClient({'ok': False, 'error_code': 'FRAME_CHANGED'})
        result = replay(program,
                        observe=lambda step: {'observation_id': 'obs-2', 'manifest': 'fresh.json',
                                              'window': {'class_name': 'Notepad', 'title': 'test.txt - 记事本'}},
                        locate=lambda step, obs: [34, 51], client=client, verify=lambda s, r, o: {'status': 'passed'})
        self.assertEqual(result['status'], 'stopped')
        self.assertEqual(result['reason'], 'FRAME_CHANGED')
        self.assertEqual(len([call for call in client.calls if call[0] == 'execute']), 1)

    def test_replay_stops_when_expected_result_is_not_verified(self):
        program = verified(make_program())
        client = FakeClient({'ok': True, 'observation_id': 'obs-2'})
        result = replay(program,
                        observe=lambda step: {'observation_id': 'obs-2', 'manifest': 'fresh.json',
                                              'window': {'class_name': 'Notepad', 'title': 'test.txt - 记事本'}},
                        locate=lambda step, obs: [34, 51], client=client, verify=lambda s, r, o: {'status': 'failed'})
        self.assertEqual(result['status'], 'stopped')
        self.assertEqual(result['reason'], 'EXPECTED_NOT_VERIFIED')

    def test_unknown_verification_never_completes(self):
        program = verified(make_program())
        client = FakeClient({'ok': True, 'observation_id': 'obs-2'})
        result = replay(program,
                        observe=lambda step: {'observation_id': 'obs-2', 'manifest': 'fresh.json',
                                              'window': {'class_name': 'Notepad', 'title': 'test.txt - 记事本'}},
                        locate=lambda step, obs: [34, 51], client=client,
                        verify=lambda s, r, o: {'status': 'unknown', 'reason': 'INSUFFICIENT'})
        self.assertEqual(result['status'], 'stopped')
        self.assertEqual(result['reason'], 'EXPECTED_UNKNOWN')

    def test_boolean_or_malformed_verifier_is_rejected(self):
        program = verified(make_program())
        client = FakeClient({'ok': True, 'observation_id': 'obs-2'})
        for verdict in (True, False, {}, {'status': 'passed-ish'}):
            result = replay(program,
                            observe=lambda step: {'observation_id': 'obs-2', 'manifest': 'fresh.json',
                                                  'window': {'class_name': 'Notepad',
                                                             'title': 'test.txt - 记事本'}},
                            locate=lambda step, obs: [34, 51], client=client,
                            verify=lambda s, r, o, value=verdict: value)
            self.assertEqual(result['status'], 'stopped')
            self.assertEqual(result['reason'], 'VERIFIER_PROTOCOL_INVALID')

    def test_draft_replay_is_refused(self):
        program = make_program()
        client = FakeClient({'ok': True, 'observation_id': 'obs-2'})
        result = replay(program,
                        observe=lambda step: {'observation_id': 'obs-2', 'manifest': 'fresh.json',
                                              'window': {'class_name': 'Notepad', 'title': 'test.txt - 记事本'}},
                        locate=lambda step, obs: [34, 51], client=client, verify=lambda s, r, o: {'status': 'passed'})
        self.assertEqual(result['status'], 'refused')
        self.assertEqual(client.calls, [])

    def test_draft_can_be_verified_then_stored(self):
        with tempfile.TemporaryDirectory() as tmp:
            ensure_template(Path(tmp))
            program = make_program()
            client = FakeClient({'ok': True, 'observation_id': 'obs-2'})
            result = verify_program(program,
                                    observe=lambda step: {'observation_id': 'obs-2', 'manifest': 'fresh.json',
                                                          'window': {'class_name': 'Notepad',
                                                                     'title': 'test.txt - 记事本'}},
                                    locate=lambda step, obs: [34, 51], client=client,
                                    verify=lambda s, r, o: {'status': 'passed'}, root=Path(tmp))
            self.assertEqual(result['status'], 'completed')
            path = save_program(Path(tmp), result['program'])
            self.assertTrue(path.is_file())

    def test_successful_replay_can_be_verified_and_stored(self):
        with tempfile.TemporaryDirectory() as tmp:
            ensure_template(Path(tmp))
            program = make_program()
            client = FakeClient({'ok': True, 'observation_id': 'obs-2', 'after_observation': 'after.json'})
            result = verify_program(program,
                                    observe=lambda step: {'observation_id': 'obs-2', 'manifest': 'fresh.json',
                                                          'window': {'class_name': 'Notepad',
                                                                     'title': 'test.txt - 记事本'}},
                                    locate=lambda step, obs: [34, 51], client=client,
                                    verify=lambda s, r, o: {'status': 'passed'}, root=Path(tmp))
            self.assertEqual(result['status'], 'completed')
            self.assertEqual(result['program'].verification['status'], 'verified')
            path = save_program(Path(tmp), result['program'])
            self.assertTrue(path.is_file())
            self.assertEqual(json.loads(path.read_text(encoding='utf-8'))['program_id'], program.program_id)


if __name__ == '__main__':
    unittest.main()
