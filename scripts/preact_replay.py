"""Run one stored program through the PreAct replay adapter.

Use a Medium-integrity Python (the base interpreter from .venv/pyvenv.cfg).
The adapter activates the target, observes, localizes, executes and verifies
with B03; it stops/replans on mismatch and never retries.
"""
from __future__ import annotations

import argparse
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
from desktop_adapter.runs import RunLedger
from preact_adapter import ProgramReplayAdapter


def read_memory_context(raw: str | None, session: str | None) -> dict | None:
    """Accept only the host-shaped context; malformed/mismatched context is ignored."""
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(value, dict):
        return None
    scope = value.get("scope")
    context = value.get("memory_context")
    if not isinstance(scope, dict) or not isinstance(context, dict):
        return None
    if (not isinstance(scope.get("user"), str) or not scope["user"]
            or not isinstance(scope.get("project"), str) or not scope["project"]):
        return None
    for key in ("session_id", "user_event_id", "request_id", "consent_event_id"):
        if not isinstance(context.get(key), str) or not context[key]:
            return None
    if context["session_id"] != session:
        return None
    depends = context.get("depends_on", [])
    if not isinstance(depends, list) or any(not isinstance(item, str) or not item for item in depends):
        return None
    return {"scope": scope, "memory_context": context}


def checkpoint_facts(result: dict) -> list[dict]:
    """Only facts represented by the durable receipts; no inferred task success."""
    receipts = result.get("receipts") if isinstance(result.get("receipts"), list) else []
    steps = result.get("steps") if isinstance(result.get("steps"), list) else []
    facts = []
    for index, step in enumerate(steps):
        try:
            step_number = int(step.get("step_id"))
        except (TypeError, ValueError):
            step_number = index + 1
        receipt = receipts[index] if index < len(receipts) and isinstance(receipts[index], dict) else {}
        delivered = receipt.get("input_delivered")
        if delivered is None:
            delivered = receipt.get("input_delivery_observed")
        delivery = "sent" if delivered is True else "not_sent" if delivered is False else "unknown"
        facts.append({"step": step_number, "input_delivery": delivery,
                      "verification": "unknown"})
    return facts



def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--program-id", required=True)
    parser.add_argument("--version", type=int, default=2)
    parser.add_argument("--out")
    parser.add_argument("--grant-id")
    parser.add_argument("--session", default=os.environ.get("DSH_SESSION_ID"))
    args = parser.parse_args()
    program = load_program(ROOT, args.program_id, args.version)
    adapter = ProgramReplayAdapter(ROOT, program, grant_id=args.grant_id,
                                   harness_session=args.session)
    memory = read_memory_context(os.environ.get("DSH_MEMORY_CONTEXT"), args.session)
    ledger = RunLedger(ROOT)
    run = ledger.start(task_id=f"program:{args.program_id}:v{args.version}",
                       request_id=memory["memory_context"]["request_id"] if memory else args.session,
                       policy_version="preact-v1",
                       scope=memory["scope"] if memory else (
                           {"user": "local-user", "project": os.environ["DSH_MEMORY_PROJECT"]}
                           if os.environ.get("DSH_MEMORY_PROJECT") else None),
                       memory_context=memory["memory_context"] if memory else None)
    try:
        result = adapter.run()
    except BaseException:
        ledger.end(run["run_id"], operation_id="replay-exception",
                   termination_reason="error", input_delivery="unknown",
                   verification={"status": "unknown", "reason": "adapter_exception"},
                   executor_state="unknown",
                   checkpoint_write={"status": "pending"} if memory else
                   {"status": "skipped", "reason": "no_checkpoint"})
        raise
    receipts = result.get("receipts", [])
    delivery = "sent" if receipts else "not_sent"
    status = result.get("status")
    if status == "completed":
        termination, verification = "completed", {"status": "passed", "source": "inventory.replay"}
    elif status == "replan_required":
        termination, verification = "replan_required", {"status": "unknown", "reason": result.get("reason")}
    elif status == "stopped":
        termination, verification = "stopped", {"status": "unknown", "reason": result.get("reason")}
    else:
        termination, verification = "error", {"status": "unknown", "reason": result.get("reason")}
    record = ledger.end(run["run_id"], operation_id="replay-finish", termination_reason=termination,
                        input_delivery=delivery, verification=verification,
                        executor_state="stopped", checkpoint_facts=checkpoint_facts(result),
                        checkpoint_write={"status": "pending"} if memory else
                        {"status": "skipped", "reason": "no_auto_checkpoint"})
    output = {"checked_at": datetime.now(timezone.utc).isoformat(),
              "program_id": args.program_id, "program_version": args.version,
              "run_id": run["run_id"], "run_record": record, "result": result}
    path = Path(args.out) if args.out else (ROOT / "results/b02/single-click-20261025"
                                             / f"replay-{args.program_id}-v{args.version}.json")
    path.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"status": result.get("status"), "reason": result.get("reason"),
                      "path": str(path), "receipts": len(receipts), "run_id": run["run_id"]},
                     ensure_ascii=True))
    return 0 if result.get("status") == "completed" else 2


if __name__ == "__main__":
    raise SystemExit(main())
