"""Offline automatic-checkpoint acceptance; isolated data, no model or input."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests"))
from test_memory_automation import MemoryAutomationTests
from test_runs import RunLedgerTests
from check_memory_core import Results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "results/memory/auto-checkpoint-offline.json")
    args = parser.parse_args()
    suite = unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromTestCase(cls)
                               for cls in (MemoryAutomationTests, RunLedgerTests))
    result = unittest.TextTestRunner(verbosity=2, resultclass=Results).run(suite)
    paths = ["src/assistant_memory/automation.py", "src/assistant_memory/gateway.py",
             "src/assistant_memory/schema.sql", "src/desktop_adapter/runs.py", "scripts/memory_cli.py",
             "scripts/run_ledger_cli.py", "plugins/dsh-desktop-observe/memory.js",
             "plugins/dsh-desktop-observe/memory-client.js", "plugins/dsh-desktop-observe/memory-runtime.js",
             "plugins/dsh-desktop-observe/action.js", "plugins/dsh-desktop-observe/runs.js",
             "plugins/dsh-desktop-observe/index.js", "tests/test_memory_automation.py", "tests/test_runs.py"]
    report = {"component": "desktop-auto-checkpoint-v1", "policy_version": "desktop-run-checkpoint-v1",
        "created_at": datetime.now(timezone.utc).isoformat(), "ok": result.wasSuccessful(),
        "tests_run": result.testsRun, "passed": result.passed,
        "failed": [t.id() for t, _ in result.failures], "errors": [t.id() for t, _ in result.errors],
        "interface_implemented": True, "offline_tested": result.wasSuccessful(),
        "running_plugin_loaded": False, "live_two_session_tested": False,
        "production_automation_enabled": False, "model_calls": 0, "desktop_actions": 0,
        "files_sha256": {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in paths},
        "limitations": ["Only Harness desktop_click run boundaries connected; replay/ordinary chat not connected",
            "No automatic retrieval/injection", "No automatic physical deletion", "No live acceptance"]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": result.wasSuccessful(), "tests_run": result.testsRun, "report": str(args.output)}))
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
