"""Run offline memory acceptance and optionally save a content-free report."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import platform
import sqlite3
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests"))
from test_memory import MemoryTests


class Results(unittest.TextTestResult):
    def __init__(self, *args):
        super().__init__(*args)
        self.passed = []

    def addSuccess(self, test):
        super().addSuccess(test)
        self.passed.append(test.id())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(MemoryTests)
    result = unittest.TextTestRunner(verbosity=2, resultclass=Results).run(suite)
    paths = ["src/assistant_memory/gateway.py", "src/assistant_memory/schema.sql", "src/assistant_memory/__init__.py",
             "scripts/memory_cli.py", "tests/test_memory.py", "scripts/check_memory_core.py"]
    report = {
        "schema_version": 1, "component": "memory-core-v1", "created_at": datetime.now(timezone.utc).isoformat(),
        "python": platform.python_version(), "sqlite": sqlite3.sqlite_version,
        "ok": result.wasSuccessful(), "tests_run": result.testsRun, "passed": result.passed,
        "failed": [t.id() for t, _ in result.failures], "errors": [t.id() for t, _ in result.errors],
        "network_requests": 0, "model_calls": 0, "desktop_actions": 0,
        "suite_type": "local_development_regression", "harness_integrated": False,
        "files_sha256": {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in paths},
        "limitations": ["No semantic extraction or end-to-end answer evaluation", "Not official LongMemEval results"],
    }
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": report["ok"], "tests_run": result.testsRun,
                      "report": str(args.output.resolve()) if args.output else None}))
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
