import shutil
import sys
import unittest
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))
from desktop_adapter.operation import OperationError, OperationJournal

DIGEST = 'a' * 64


class OperationJournalTests(unittest.TestCase):
    def setUp(self):
        self.root = ROOT / 'runtime' / 'operation-tests' / uuid4().hex
        self.root.mkdir(parents=True)
        self.addCleanup(lambda: shutil.rmtree(self.root, ignore_errors=True))
        self.journal = OperationJournal(self.root)

    def test_in_progress_conflict_replayed_and_finalized(self):
        first = self.journal.begin(operation_id='op-1', request_id='req-1', digest=DIGEST)
        self.assertEqual(first['phase'], 'prepared')
        with self.assertRaises(OperationError) as caught:
            self.journal.begin(operation_id='op-1', request_id='req-2', digest=DIGEST)
        self.assertEqual(caught.exception.code, 'OPERATION_IN_PROGRESS')
        with self.assertRaises(OperationError) as caught:
            self.journal.begin(operation_id='op-1', request_id='req-1', digest='b' * 64)
        self.assertEqual(caught.exception.code, 'OPERATION_CONFLICT')
        self.journal.mark('op-1', 'input_started')
        self.journal.mark('op-1', 'finalized', outcome='input_delivered')
        with self.assertRaises(OperationError) as caught:
            self.journal.begin(operation_id='op-1', request_id='req-1', digest=DIGEST)
        self.assertEqual(caught.exception.code, 'OPERATION_REPLAYED')
        self.assertEqual(self.journal.get('op-1')['outcome'], 'input_delivered')

    def test_invalid_identity_digest_and_corruption_fail_closed(self):
        with self.assertRaisesRegex(OperationError, 'INVALID_OPERATION_ID'):
            self.journal.begin(operation_id='../escape', request_id='r', digest=DIGEST)
        with self.assertRaisesRegex(OperationError, 'INVALID_OPERATION_DIGEST'):
            self.journal.begin(operation_id='op-2', request_id='r', digest='not-a-digest')
        self.journal.begin(operation_id='op-3', request_id='r', digest=DIGEST)
        (self.root / 'runtime' / 'operations' / 'op-3.json').write_text('{bad', encoding='utf-8')
        with self.assertRaisesRegex(OperationError, 'OPERATION_JOURNAL_CORRUPT'):
            self.journal.get('op-3')


if __name__ == '__main__':
    unittest.main()
