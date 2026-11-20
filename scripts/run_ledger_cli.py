"""Trusted local CLI for the desktop run ledger.

One JSON request per process, like the memory CLI. This is a host utility; it is
not registered as a model tool and does not send desktop input.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from desktop_adapter.runs import RunLedger, RunLedgerError  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=str(ROOT))
    args = parser.parse_args()
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict):
            raise ValueError("request must be an object")
        operation = request.get("op")
        payload = request.get("args") or {}
        ledger = RunLedger(args.root)
        if operation == "start":
            result = ledger.start(**payload)
        elif operation == "end":
            result = ledger.end(**payload)
        elif operation == "transition":
            result = ledger.transition(**payload)
        elif operation == "checkpoint_result":
            result = ledger.checkpoint_result(**payload)
        elif operation == "get":
            result = ledger.get(payload.get("run_id"))
        elif operation == "list":
            result = ledger.list()
        elif operation == "unfinished":
            result = ledger.unfinished()
        else:
            raise RunLedgerError("INVALID_OPERATION")
    except (ValueError, KeyError, TypeError, RunLedgerError, OSError) as error:
        code = getattr(error, "code", "RUN_LEDGER_ERROR")
        print(json.dumps({"ok": False, "error_code": code, "message": str(error)[:300]}, ensure_ascii=False))
        return 2
    print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
