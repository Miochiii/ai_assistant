import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(ROOT / 'src'))
from preact_replay import checkpoint_facts, read_memory_context


class PreactMemoryContextTests(unittest.TestCase):
    def test_valid_context_is_session_bound(self):
        value = {'scope': {'user': 'u', 'project': 'p'},
                 'memory_context': {'session_id': 's', 'user_event_id': 'e',
                                    'request_id': 'r', 'consent_event_id': 'c',
                                    'depends_on': ['m1']}}
        parsed = read_memory_context(json.dumps(value), 's')
        self.assertEqual(parsed['scope']['project'], 'p')
        self.assertEqual(parsed['memory_context']['depends_on'], ['m1'])
        self.assertIsNone(read_memory_context(json.dumps(value), 'other'))
        self.assertIsNone(read_memory_context('{bad', 's'))
        self.assertIsNone(read_memory_context(None, 's'))

    def test_checkpoint_facts_separate_delivery_from_verification(self):
        result = {'steps': [{'step_id': '1'}, {'step_id': '2'}],
                  'receipts': [{'input_delivery_observed': True}, {'input_delivery_observed': False}]}
        self.assertEqual(checkpoint_facts(result), [
            {'step': 1, 'input_delivery': 'sent', 'verification': 'unknown'},
            {'step': 2, 'input_delivery': 'not_sent', 'verification': 'unknown'},
        ])


if __name__ == '__main__':
    unittest.main()
