"""One JSON request on stdin; one JSON reply. Trusted local host/admin entry.

Identity and database are command-line configuration, not model input fields.
Do not expose event/remember/confirm/forget directly to an untrusted model.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sqlite3
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from assistant_memory import MemoryError, MemoryGateway, Scope
from assistant_memory.v2 import OPS as V2_OPS, dispatch as dispatch_v2
from assistant_memory.automation import automation_status, configure_automation, auto_checkpoint, expiry_preview
from desktop_adapter.runs import RunLedger, RunLedgerError

OPERATIONS = {
    "remember_panel_note": "remember_panel_note",
    "set_panel_guidance": "set_panel_guidance",
    "panel_guidance": "panel_guidance",
    "event": "record_event", "propose": "propose", "remember": "remember", "confirm": "confirm",
    "recall": "recall", "revoke": "revoke", "deletion_plan": "deletion_plan", "forget": "forget",
    "checkpoint": "save_checkpoint", "resume": "resume", "rebuild_index": "rebuild_index",
    "export": "export", "audit": "audit",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=ROOT / "runtime" / "memory" / "memory.sqlite3")
    parser.add_argument("--user", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args()
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        raw = sys.stdin.read(131073)
        if len(raw) > 131072:
            raise MemoryError("REQUEST_TOO_LARGE")
        request = json.loads(raw)
        if not isinstance(request, dict) or set(request) - {"op", "args"}:
            raise MemoryError("INVALID_REQUEST")
        op, payload = request.get("op"), request.get("args", {})
        if not isinstance(op, str) or op not in {*V2_OPS, *OPERATIONS, "automation_status", "configure_automation", "auto_checkpoint", "expiry_preview", "exposure_register", "exposure_promote", "context_state", "context_generation", "context_refresh"} or not isinstance(payload, dict):
            raise MemoryError("INVALID_REQUEST")
        with MemoryGateway(args.db, Scope(args.user, args.project)) as memory:
            if op in V2_OPS:
                result = dispatch_v2(memory, args.root, op, payload)
            elif op == "automation_status":
                result = automation_status(memory)
            elif op == "configure_automation":
                result = configure_automation(memory, **payload)
            elif op == "auto_checkpoint":
                result = auto_checkpoint(memory, args.root, **payload)
            elif op == "expiry_preview":
                result = expiry_preview(memory)
            elif op == "exposure_register":
                result = memory.register_exposure(**payload)
            elif op == "exposure_promote":
                result = memory.promote_exposures(**payload)
            elif op == "context_state":
                result = memory.context_state(**payload)
            elif op == "context_generation":
                result = memory.context_generation(**payload)
            elif op == "context_refresh":
                result = memory.refresh_context(**payload)
            else:
                result = getattr(memory, OPERATIONS[op])(**payload)
                if op == "resume":
                    for item in result["items"]:
                        refs = []
                        for source in item["sources"]:
                            if source["channel"] != "desktop_run_ledger":
                                continue
                            run_id = json.loads(source["content"])["run_id"]
                            try:
                                RunLedger(args.root).get(run_id)
                                available = True
                            except (RunLedgerError, OSError):
                                available = False
                            refs.append({"ref": "run:" + run_id, "availability": "available" if available else "unavailable"})
                        if refs:
                            item["evidence_availability"] = refs
        print(json.dumps({"ok": True, "op": op, "result": result}, ensure_ascii=False, allow_nan=False))
        return 0
    except MemoryError as exc:
        error = str(exc)
    except RunLedgerError as exc:
        error = exc.code
    except (TypeError, ValueError, KeyError, OverflowError):
        error = "INVALID_REQUEST"
    except sqlite3.OperationalError:
        error = "STORAGE_UNAVAILABLE"
    except sqlite3.DatabaseError:
        error = "STORAGE_ERROR"
    except OSError:
        error = "FILESYSTEM_UNAVAILABLE"
    print(json.dumps({"ok": False, "error_code": error}, ensure_ascii=False))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
