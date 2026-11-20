"""Fixed desktop-action executor entry point.

Run this script with a Medium-integrity Python. The project .venv carries a
Low integrity label in a sandboxed workspace, so the Harness must launch the
base interpreter from the venv's pyvenv.cfg instead of .venv\\Scripts\\python.exe.
This bootstrap only adds read-only import paths; it does not change ACLs,
integrity labels, RAG, or security settings.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / ".venv" / "Lib" / "site-packages"
for candidate in (ROOT / "src", SITE, SITE / "win32", SITE / "win32" / "lib", SITE / "Pythonwin"):
    if candidate.is_dir() and str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))
if os.name == "nt":
    dll_directory = SITE / "pywin32_system32"
    if dll_directory.is_dir():
        try:
            os.add_dll_directory(str(dll_directory))
        except (AttributeError, OSError):
            pass

from desktop_adapter.action_contract import ActionRefused  # noqa: E402
from desktop_adapter.executor import EXECUTOR_VERSION, DesktopExecutor  # noqa: E402
from desktop_adapter.lease import DesktopLeaseError, desktop_input_lease  # noqa: E402


def _read_payload(path: str) -> dict:
    if path == "-":
        text = sys.stdin.buffer.read().decode("utf-8")
    else:
        text = Path(path).read_text(encoding="utf-8-sig")
    value = json.loads(text)
    if not isinstance(value, dict):
        raise ActionRefused("INVALID_REQUEST", "request must be a JSON object")
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--self-check", action="store_true",
                       help="report own integrity, session and dependencies; perform no action")
    group.add_argument("--request", metavar="PATH", help="execute one JSON request; '-' reads stdin")
    parser.add_argument("--version", action="store_true", help="print the executor version")
    args = parser.parse_args()

    if args.version:
        print(json.dumps({"executor_version": EXECUTOR_VERSION, "schema_version": 1}, ensure_ascii=False))
        return 0

    executor = DesktopExecutor(ROOT)
    if args.self_check:
        result = executor.self_check()
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["ok"] else 3

    if not args.request:
        print(json.dumps({"ok": False, "error_code": "INVALID_REQUEST",
                          "message": "choose --self-check or --request PATH"}, ensure_ascii=False))
        return 2

    try:
        payload = _read_payload(args.request)
    except (OSError, ValueError, ActionRefused) as error:
        print(json.dumps({"ok": False, "error_code": "INVALID_REQUEST",
                          "message": str(error)[:200]}, ensure_ascii=False))
        return 2

    try:
        with desktop_input_lease(ROOT) as lease:
            result = executor.execute(payload)
            if isinstance(result, dict):
                result["lease"] = lease
    except DesktopLeaseError as error:
        result = {"ok": False, "error_code": error.code, "message": error.message,
                  "phase": "pre_action", "stage": "lease", "input_delivered": False,
                  "input_events_sent": 0, "task_success_verified": False,
                  "other_action_may_be_active": True,
                  "notice": "Another desktop input lease is active; no input was sent by this request. Do not retry blindly."}
    print(json.dumps(result, ensure_ascii=True, indent=2))
    return 0 if result.get("ok") else 2


if __name__ == "__main__":
    raise SystemExit(main())
