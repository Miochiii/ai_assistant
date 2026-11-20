import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from desktop_adapter.retention import apply_plan, plan_cleanup


def touch_old(path: Path, hours: int):
    stamp = (datetime.now(timezone.utc) - timedelta(hours=hours)).timestamp()
    os.utime(path, (stamp, stamp))


def make_observation(root: Path, name: str, observation_id: str):
    folder = root / 'results' / 'vision' / name
    folder.mkdir(parents=True)
    (folder / 'observation.json').write_text(json.dumps({'observation_id': observation_id}), encoding='utf-8')
    (folder / 'screen.png').write_bytes(b'png')
    (folder / 'source.rgb').write_bytes(b'rgb')
    return folder


class RetentionTests(unittest.TestCase):
    def test_plan_keeps_program_basis_and_deletes_ordinary_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            home = root / 'home'
            old = make_observation(root, 'old', 'obs-old')
            new = make_observation(root, 'new', 'obs-new')
            kept = make_observation(root, 'kept', 'obs-keep')
            touch_old(old, 48)
            touch_old(new, 1)
            touch_old(kept, 48)
            touch_old(kept / 'source.rgb', 2)
            program = root / 'runtime' / 'programs' / 'p' / 'v1.json'
            program.parent.mkdir(parents=True)
            program.write_text(json.dumps({'steps': [{'visual_basis': {'observation_id': 'obs-keep'}}]}),
                               encoding='utf-8')
            digest = 'a' * 64
            attachment = home / '.dsh' / 'attachments' / 'v1' / 'objects' / 'aa' / digest
            attachment.parent.mkdir(parents=True)
            attachment.write_bytes(b'attachment')
            index = root / 'runtime' / 'attachments.jsonl'
            index.parent.mkdir(parents=True, exist_ok=True)
            index.write_text(json.dumps({'recorded_at': (datetime.now(timezone.utc) - timedelta(hours=48)).isoformat(),
                                         'observation_id': 'obs-old', 'attachment_id': f'sha256:{digest}'}) + '\n',
                             encoding='utf-8')
            now = datetime.now(timezone.utc)
            plan = plan_cleanup(root, now=now, home=home)
            deleted = {item['path'] for item in plan['delete']}
            self.assertIn(str(old), deleted)
            self.assertIn(str(kept / 'source.rgb'), deleted)
            self.assertIn(str(attachment), deleted)
            self.assertNotIn(str(new), deleted)
            self.assertNotIn(str(kept / 'screen.png'), deleted)
            self.assertTrue(any(item['path'] == str(kept) and item['reason'] == 'program_basis'
                                for item in plan['keep']))
            result = apply_plan(root, plan, home=home)
            self.assertFalse(old.exists())
            self.assertTrue((kept / 'screen.png').is_file())
            self.assertFalse((kept / 'source.rgb').exists())
            self.assertFalse(attachment.exists())
            self.assertEqual(result['errors'], [])


if __name__ == '__main__':
    unittest.main()
