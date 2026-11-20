import shutil
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))
from desktop_adapter.action_client import ActionClient, ExecutorError


class ActionClientCancellationTests(unittest.TestCase):
    def test_timeout_writes_cancel_and_waits_for_exit(self):
        folder = ROOT / 'runtime' / 'lease-tests' / ('action-client-' + uuid4().hex)
        folder.mkdir(parents=True)
        self.addCleanup(lambda: shutil.rmtree(folder, ignore_errors=True))
        script = folder / 'scripts' / 'desktop_executor.py'
        script.parent.mkdir()
        script.write_text(
            "import os, pathlib, sys, time\n"
            "p = pathlib.Path(os.environ['DSH_EXECUTOR_CANCEL_FILE'])\n"
            "p.write_text('seen', encoding='utf-8')\n"
            "time.sleep(5)\n", encoding='utf-8')
        client = ActionClient(folder, timeout=0.2)
        with patch.object(client, '_client_integrity_refusal', return_value=None), \
             patch('desktop_adapter.action_client.resolve_base_python', return_value=Path(sys.executable)):
            with self.assertRaises(ExecutorError) as caught:
                client.execute({})
        self.assertEqual(caught.exception.code, 'EXECUTOR_TIMEOUT')
        leftovers = list((folder / 'runtime' / 'cancellations').glob('*.cancel'))
        self.assertEqual(leftovers, [])


if __name__ == '__main__':
    unittest.main()
