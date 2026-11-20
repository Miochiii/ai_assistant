"""Verify an explored PreAct draft on fresh observations and mint a proof.

Does not save the program. Use inventory.save_program only after inspecting the
verified result. This command must run in the Medium base Python, not the Low
project venv.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / ".venv" / "Lib" / "site-packages"
for candidate in (ROOT / "src", ROOT / "scripts", SITE, SITE / "win32", SITE / "win32" / "lib", SITE / "Pythonwin"):
    if candidate.is_dir() and str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))
if os.name == "nt":
    dll = SITE / "pywin32_system32"
    if dll.is_dir():
        try:
            os.add_dll_directory(str(dll))
        except (AttributeError, OSError):
            pass

from desktop_adapter.inventory import ProgramRefused, parse_program
from preact_adapter import ProgramReplayAdapter


def jsonable(value):
    """Convert ProgramRecord/Path/dataclass values before json.dumps."""
    if hasattr(value, "to_dict") and callable(value.to_dict):
        return jsonable(value.to_dict())
    if is_dataclass(value) and not isinstance(value, type):
        return jsonable(asdict(value))
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(key): jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(item) for item in value]
    if isinstance(value, (set, frozenset)):
        return sorted(jsonable(item) for item in value)
    return value


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".")
    parser.add_argument("--draft", required=True,
                        help="runtime/program-drafts/<id>/v1.json")
    parser.add_argument("--grant-id", default=None)
    parser.add_argument("--harness-session", default=os.environ.get("DSH_SESSION_ID"))
    parser.add_argument("--no-authorization", action="store_true")
    parser.add_argument("--out", default=None,
                        help="optional result path; defaults to results/preact-draft/")
    args = parser.parse_args(argv)
    root = Path(args.root).resolve()
    draft_path = Path(args.draft)
    if not draft_path.is_absolute():
        draft_path = (root / draft_path).resolve()
    try:
        payload = json.loads(draft_path.read_text(encoding="utf-8-sig"))
        program = parse_program(payload)
        adapter = ProgramReplayAdapter(
            root, program,
            grant_id=args.grant_id,
            harness_session=args.harness_session,
            require_authorization=not args.no_authorization,
            allow_draft=True,
        )
        result = adapter.verify_draft()
        safe = jsonable(result)
        out = Path(args.out) if args.out else (
            root / "results" / "preact-draft"
            / f"{program.program_id}-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
        )
        if not out.is_absolute():
            out = (root / out).resolve()
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(safe, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"result: {out}", file=sys.stderr)
        print(json.dumps(safe, ensure_ascii=False, indent=2))
        return 0 if result.get("status") == "completed" else 1
    except (OSError, ValueError, ProgramRefused) as error:
        print(json.dumps({"status": "stopped", "reason": type(error).__name__,
                          "message": str(error)[:500]}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
