"""Compatibility runner for the first stored Notepad program.

The reusable PreAct interface is scripts/preact_adapter.py + scripts/preact_replay.py.
This wrapper keeps the earlier evidence path for the first program.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
from datetime import datetime, timezone

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

from desktop_adapter.inventory import load_program
from preact_adapter import ProgramReplayAdapter

PROGRAM_ID = "notepad-open-file-menu"
PROGRAM_VERSION = 2


def main() -> int:
    program = load_program(ROOT, PROGRAM_ID, PROGRAM_VERSION)
    result = ProgramReplayAdapter(ROOT, program).run()
    output = {"checked_at": datetime.now(timezone.utc).isoformat(),
              "program_id": PROGRAM_ID, "program_version": PROGRAM_VERSION, "result": result}
    path = ROOT / "results/b02/single-click-20261025/replay-notepad-v2.json"
    path.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"status": result.get("status"), "reason": result.get("reason"),
                      "path": str(path), "receipts": len(result.get("receipts", []))},
                     ensure_ascii=True))
    return 0 if result.get("status") == "completed" else 2


if __name__ == "__main__":
    raise SystemExit(main())
