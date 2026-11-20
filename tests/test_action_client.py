import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from desktop_adapter.action_client import ActionClient, ExecutorError, resolve_base_python
from test_action_contract import ContractFixture

PROJECT_ROOT = Path(__file__).resolve().parents[1]


class ActionClientTests(unittest.TestCase):
    def test_fake_runner_receives_the_same_contract_request(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            seen = []

            def runner(request):
                seen.append(request)
                return {'ok': True, 'outcome': 'input_delivered', 'fixture': True}

            client = ActionClient(fixture.root, runner=runner)
            result = client.click(fixture.folder / 'observation.json', '文件(F)', [34, 51], 'menu opens')
            self.assertTrue(result['ok'])
            self.assertEqual(seen[0]['observation']['observation_id'], 'obs-1')
            self.assertEqual(seen[0]['target']['center'], [34, 51])
            self.assertEqual(seen[0]['schema_version'], 1)
            self.assertEqual(len(seen), 1)

    @patch('desktop_adapter.action_client.token_integrity', return_value=4096)
    def test_low_client_refuses_before_launch(self, _integrity):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = ContractFixture(Path(tmp))
            client = ActionClient(fixture.root)
            check = client.self_check()
            self.assertFalse(check['ok'])
            self.assertEqual(check['error_code'], 'CLIENT_INTEGRITY_NOT_MEDIUM')
            with self.assertRaisesRegex(ExecutorError, 'Medium'):
                client.execute(fixture.request())

    def test_base_python_resolution_uses_pyvenv_cfg(self):
        base = resolve_base_python(PROJECT_ROOT)
        self.assertTrue(base.is_file())
        self.assertEqual(base.name.lower(), 'python.exe')


if __name__ == '__main__':
    unittest.main()
