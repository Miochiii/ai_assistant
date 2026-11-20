"""Convert a verified PreAct program into a reviewable draft.

This does NOT execute anything and does NOT save to the inventory. It is useful
for exercising preact_draft_verify.py against real captured assets.

The draft is written under runtime/program-drafts/, with verification.status
draft, current executor_version and no proof/runs.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / ".venv" / "Lib" / "site-packages"
for candidate in (ROOT / "src", ROOT / "scripts", SITE):
    if candidate.is_dir() and str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

from desktop_adapter.action_contract import EXECUTOR_VERSION
from desktop_adapter.inventory import parse_program


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".")
    parser.add_argument("--program", required=True,
                        help="runtime/programs/<id>/v<version>.json")
    parser.add_argument("--program-id", required=True)
    parser.add_argument("--version", type=int, default=1)
    args = parser.parse_args(argv)
    root = Path(args.root).resolve()
    source = Path(args.program)
    if not source.is_absolute():
        source = (root / source).resolve()
    try:
        payload = json.loads(source.read_text(encoding="utf-8-sig"))
        program = parse_program(payload, allow_verified=True)
        if program.verification.get("status") != "verified":
            raise ValueError("source program is not verified")
        for step in program.steps:
            template = step.expected.get("template")
            if not isinstance(template, str) or not template:
                raise ValueError(f"step {step.step_id} has no expected.template")
            template_path = Path(template)
            if not template_path.is_absolute():
                template_path = root / template_path
            if not template_path.is_file():
                raise ValueError(f"template missing: {template_path}")
        draft = program.to_dict()
        draft["program_id"] = args.program_id
        draft["program_version"] = args.version
        draft["executor_version"] = EXECUTOR_VERSION
        draft["verification"] = {
            "status": "draft",
            "note": "Review draft generated from a verified program; replay and proof are required before inventory save.",
        }
        draft["created_at"] = datetime.now(timezone.utc).isoformat()
        out = root / "runtime" / "program-drafts" / args.program_id / f"v{args.version}.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        with out.open("x", encoding="utf-8") as handle:
            json.dump(draft, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        print(json.dumps({"ok": True, "draft": str(out), "steps": len(draft["steps"])},
                         ensure_ascii=False))
        return 0
    except (OSError, ValueError, TypeError) as error:
        print(json.dumps({"ok": False, "error": str(error)[:500]}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
