import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from desktop_adapter.authorization import (GrantError, check_grant, create_grant, grant_dir, list_grants,
                                           load_grant, revoke_grant, select_grant)

WINDOW = {'hwnd': 42, 'pid': 7, 'class_name': 'Notepad', 'title': 'test.txt - 记事本'}


class AuthorizationTests(unittest.TestCase):
    def test_grant_round_trip_and_window_action_checks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            grant = create_grant(root, windows=[WINDOW], actions=['activate', 'observe', 'click', 'replay'],
                                 ttl_seconds=600, task='test', harness_session='session-1', windows_session=1)
            loaded = load_grant(root, grant['grant_id'])
            self.assertEqual(loaded['task'], 'test')
            check_grant(loaded, window=WINDOW, action='click')
            self.assertEqual(select_grant(root, window=WINDOW, action='click',
                                          harness_session='session-1')['grant_id'], grant['grant_id'])
            with self.assertRaisesRegex(GrantError, 'Window is outside'):
                check_grant(loaded, window={**WINDOW, 'title': 'other'}, action='click')
            with self.assertRaisesRegex(GrantError, 'outside the grant'):
                check_grant({**loaded, 'actions': ['click']}, window=WINDOW, action='observe')

    def test_expired_and_foreign_session_grants_are_ignored(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            grant = create_grant(root, windows=[WINDOW], actions=['click'], ttl_seconds=60,
                                 harness_session='session-1')
            path = grant_dir(root) / f"{grant['grant_id']}.json"
            payload = json.loads(path.read_text(encoding='utf-8'))
            payload['expires_at'] = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
            path.write_text(json.dumps(payload), encoding='utf-8')
            with self.assertRaisesRegex(GrantError, 'expired'):
                load_grant(root, grant['grant_id'])
            self.assertEqual(list_grants(root, harness_session='session-1'), [])
            other = create_grant(root, windows=[WINDOW], actions=['click'], harness_session='session-1')
            self.assertEqual(list_grants(root, harness_session='session-2'), [])
            with self.assertRaisesRegex(GrantError, 'No active task grant'):
                select_grant(root, window=WINDOW, action='click', harness_session='session-2')
            self.assertTrue(revoke_grant(root, other['grant_id']))
            self.assertFalse(revoke_grant(root, other['grant_id']))


if __name__ == '__main__':
    unittest.main()
