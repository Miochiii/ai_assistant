import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(ROOT / 'src'))
import desktop_executor


class _Utf8Stdin:
    def __init__(self, text: str):
        self.buffer = io.BytesIO(text.encode('utf-8'))


class ExecutorStdinTests(unittest.TestCase):
    def test_request_stdin_is_utf8_not_console_codepage(self):
        payload = {'request_id': 'r1', 'target': {'label': '缩放状态 100%'}}
        with patch.object(sys, 'stdin', _Utf8Stdin(json.dumps(payload, ensure_ascii=False))):
            decoded = desktop_executor._read_payload('-')
        self.assertEqual(decoded['target']['label'], '缩放状态 100%')


if __name__ == '__main__':
    unittest.main()
