"""Plan or apply evidence retention.

Default is a dry run. --apply deletes only paths under results/vision or the
Harness attachment object store; program visual-basis images and templates are
kept by observation id.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / ".venv" / "Lib" / "site-packages"
for candidate in (ROOT / "src", SITE, SITE / "win32", SITE / "win32" / "lib"):
    if candidate.is_dir() and str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))
if os.name == "nt":
    dll = SITE / "pywin32_system32"
    if dll.is_dir():
        try:
            os.add_dll_directory(str(dll))
        except (AttributeError, OSError):
            pass

from desktop_adapter.retention import apply_plan, plan_cleanup


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Delete the planned paths; default is dry-run")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    plan = plan_cleanup(ROOT)
    output = {"dry_run": not args.apply, "plan": plan}
    if args.apply:
        output["result"] = apply_plan(ROOT, plan)
    if args.json:
        print(json.dumps(output, ensure_ascii=True, indent=2))
    else:
        print(f"plan: delete={len(plan['delete'])} keep={len(plan['keep'])} errors={len(plan['errors'])} dry_run={not args.apply}")
        for item in plan["delete"]:
            print(f"  DELETE {item['kind']} {item['path']} ({item['reason']})")
        if args.apply:
            print(f"removed={len(output['result']['removed'])} errors={len(output['result']['errors'])}")
    return 0 if not (args.apply and output.get("result", {}).get("errors")) else 2


if __name__ == "__main__":
    raise SystemExit(main())
