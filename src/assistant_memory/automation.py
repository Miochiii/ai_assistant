"""Trusted, deterministic desktop-run checkpoints. No model or input execution.

Consent and checkpoint sources/content commit in one SQLite write transaction.
Run JSON is locked during delivery; a crash between SQLite commit and the JSON
ack is recovered with the same operation ID. Only ID/status facts enter memory.
"""
from datetime import datetime, timedelta
import hashlib
import sqlite3

from .gateway import MemoryError, _encode, _text, _time
from desktop_adapter.runs import RunLedger

POLICY = "desktop-run-checkpoint-v1"
MAX_ATTEMPTS = 3
RETRYABLE = {"STORAGE_UNAVAILABLE", "FILESYSTEM_UNAVAILABLE"}


def _id(prefix, *parts):
    return prefix + hashlib.sha256("\0".join(parts).encode("utf-8")).hexdigest()[:48]


def automation_status(memory):
    row = memory.db.execute("SELECT * FROM memory_automation WHERE user_scope=? AND project_scope=?",
                            memory._scope).fetchone()
    disabled = {"auto_checkpoint": False, "auto_recall": False, "policy_version": POLICY,
                "retention_days": None, "consent_event_id": None,
                "body_deleted_on_expiry": False, "reason": "not_configured"}
    if row is None:
        return disabled
    try:
        source = memory._event(row["consent_event_id"])
    except MemoryError:
        return {**disabled, "reason": "consent_source_unavailable"}
    if (source["origin"] != "user" or row["policy_version"] != POLICY or row["auto_checkpoint"] not in (0, 1)
            or row["auto_recall"] != 0 or type(row["retention_days"]) is not int
            or not 1 <= row["retention_days"] <= 365):
        return {**disabled, "reason": "invalid_policy"}
    return {**disabled, "auto_checkpoint": bool(row["auto_checkpoint"]),
            "retention_days": row["retention_days"], "consent_event_id": row["consent_event_id"],
            "reason": "configured"}


def configure_automation(memory, *, source_event_id, auto_checkpoint,
                         retention_days=None, acknowledge_retained_body=False, auto_recall=False):
    if type(auto_checkpoint) is not bool or type(auto_recall) is not bool:
        raise MemoryError("INVALID_AUTOMATION_SETTINGS")
    if auto_recall:
        raise MemoryError("AUTO_RECALL_NOT_IMPLEMENTED")
    if auto_checkpoint and (type(retention_days) is not int or not 1 <= retention_days <= 365
                            or acknowledge_retained_body is not True):
        raise MemoryError("RETENTION_ACK_REQUIRED")
    with memory._transaction(write=True):
        if memory._event(source_event_id)["origin"] != "user":
            raise MemoryError("EXPLICIT_USER_SOURCE_REQUIRED")
        used = memory.db.execute("""SELECT 1 FROM memory_audit WHERE user_scope=? AND project_scope=?
            AND object_id=? AND operation IN ('automation_enabled','automation_disabled') LIMIT 1""",
            (*memory._scope, source_event_id)).fetchone()
        if used:
            # A delayed duplicate of an old enable command cannot undo a newer disable.
            return automation_status(memory)
        old = automation_status(memory)
        days = retention_days if auto_checkpoint else old["retention_days"] or 30
        memory.db.execute("""INSERT INTO memory_automation VALUES(?,?,?,?,?,?,?,?)
            ON CONFLICT(user_scope,project_scope) DO UPDATE SET
            policy_version=excluded.policy_version,auto_checkpoint=excluded.auto_checkpoint,
            auto_recall=excluded.auto_recall,retention_days=excluded.retention_days,
            consent_event_id=excluded.consent_event_id,updated_at=excluded.updated_at""",
            (*memory._scope, POLICY, int(auto_checkpoint), 0, days, source_event_id, memory._stamp()))
        memory._audit("automation_enabled" if auto_checkpoint else "automation_disabled",
                      source_event_id, memory._stamp())
    return automation_status(memory)


def expiry_preview(memory):
    """IDs only; expiry never silently deletes retained disk content."""
    with memory._transaction():
        rows = memory.db.execute("""SELECT m.memory_id,m.valid_to FROM memories m
            JOIN memory_operations o ON o.object_id=m.memory_id
            WHERE m.user_scope=? AND m.project_scope=? AND m.kind='checkpoint'
            AND m.deleted_at IS NULL AND m.valid_to<=? AND o.operation_id LIKE 'auto-checkpoint-%'
            ORDER BY m.valid_to,m.seq""", (*memory._scope, memory._stamp())).fetchall()
        return {"expired": [{"memory_id": r["memory_id"], "expired_at": r["valid_to"]} for r in rows],
                "body_retained_on_disk": True, "automatic_delete": False,
                "next_step": "Use /memory plan then /memory forget with its plan_id for each selected item."}


def auto_checkpoint(memory, root, *, run_id):
    """Consume only a durable host run, never model-supplied summary/consent."""
    ledger = RunLedger(root)
    with ledger._locked():
        run = ledger._load(run_id)
        state = run.get("checkpoint_write", {})
        context = run.get("memory_context")
        if (run.get("lifecycle") != "ended" or not run.get("terminal_event_id")
                or not run.get("ended_at")):
            return {"status": "skipped", "reason": "no_terminal_event"}
        if not isinstance(context, dict) or run.get("scope") != dict(zip(("user", "project"), memory._scope)):
            return {"status": "skipped", "reason": "scope_or_source_unavailable"}
        for key in ("session_id", "user_event_id", "request_id", "consent_event_id"):
            _text(context.get(key), "SOURCE_ID_REQUIRED", 256)
        if context["request_id"] != run.get("request_id"):
            raise MemoryError("REQUEST_ID_CONFLICT")
        if run.get("executor_state") not in {"stopped", "unknown"}:
            return {"status": "skipped", "reason": "executor_recovery_required"}
        operation_id = _id("auto-checkpoint-", *memory._scope, run_id, run["terminal_event_id"], POLICY)
        # Always reconcile an existing operation, even after the retry limit.
        prior = memory.db.execute("SELECT object_id FROM memory_operations WHERE operation_id=?",
                                  (operation_id,)).fetchone()
        attempts = state.get("attempts", 0)
        if prior is None and attempts >= MAX_ATTEMPTS:
            return {**state, "retry_exhausted": True}
        try:
            with memory._transaction(write=True):
                # SQLite serializes this check with disabling consent. No queued
                # trigger can pass using a stale host boolean or old enable event.
                settings = automation_status(memory)
                if (not settings["auto_checkpoint"]
                        or settings["consent_event_id"] != context["consent_event_id"]):
                    result = {"status": "skipped", "reason": "disabled_or_consent_changed"}
                else:
                    if prior is not None:
                        try:
                            previous = memory._memory(prior["object_id"])
                        except MemoryError:
                            raise MemoryError("OPERATION_DELETED") from None
                    ended = _time(run["ended_at"])
                    days = state.get("retention_days", settings["retention_days"])
                    expires = _time((datetime.fromisoformat(ended) + timedelta(days=days)).isoformat())
                    facts = run.get("checkpoint_facts", [])
                    delivery = run.get("input_delivery", "unknown")
                    verification = run.get("verification", {}).get("status", "unknown")
                    termination = run["termination_reason"]
                    executor = run.get("executor_state", "unknown")
                    # Keep existing checkpoint schema. The source event carries
                    # typed facts; the short body never copies coordinates/tokens.
                    event = {"run_id": run_id, "termination_reason": termination,
                             "executor_state": executor,
                             "evidence_refs": [f"run:{run_id}"], "task_success_verified": False}
                    receipt = {"run_id": run_id, "input_delivery": delivery, "verification": verification,
                               "verification_scope": "desktop_subtask_only", "completed_steps": facts,
                               "evidence_refs": [f"run:{run_id}"]}
                    content = {"goal": "Desktop subtask for user request " + context["request_id"],
                        "completed": [f"step {f['step']}: input_delivery={f['input_delivery']}; verification={f['verification']}"
                                      for f in facts],
                        "next_step": "Inspect run evidence, observe again and recheck authorization before any input.",
                        "blockers": [f"termination={termination}; input_delivery={delivery}; verification={verification}; executor={executor}"],
                        "status": "completed" if termination == "completed" else "blocked"}
                    source = _id("host-run-", *memory._scope, run_id, run["terminal_event_id"])
                    receipt_source = _id("host-receipt-", *memory._scope, run_id, run["terminal_event_id"])
                    # Source text is a reference, not a reconstructed user quote.
                    user_ref = _id("host-user-ref-", *memory._scope, context["user_event_id"])
                    sources = [user_ref, source, receipt_source]
                    if prior is None:
                        memory._record_event(event_id=user_ref, session_id=context["session_id"],
                            channel="harness_user_reference", origin="user",
                            content=_encode({"source_ref": context["user_event_id"], "text_retained": False}))
                        memory._record_event(event_id=source, session_id=context["session_id"],
                            channel="desktop_run_ledger", origin="tool", content=_encode(event), observed_at=ended)
                        memory._record_event(event_id=receipt_source, session_id=context["session_id"],
                            channel="desktop_executor_receipt", origin="tool", content=_encode(receipt), observed_at=ended)
                    head = memory._head("checkpoint", run["task_id"])
                    supersedes = previous["supersedes_id"] if prior else head["memory_id"] if head else None
                    mid = memory._save_checkpoint_record(task_id=run["task_id"], content=content,
                        source_event_ids=sources, depends_on=context.get("depends_on", []),
                        supersedes_id=supersedes,
                        operation_id=operation_id, valid_from=ended, valid_to=expires)
                    result = {"status": "saved", "memory_id": mid, "operation_id": operation_id,
                              "retention_days": days, "expires_at": expires, "attempts": attempts + (prior is None),
                              "requires_fresh_observation": True, "automatic_execution": False}
            if not (result["status"] == "skipped" and state.get("status") == "saved"):
                run["checkpoint_write"] = result
                ledger._write(run)
            elif state.get("memory_id"):
                result["already_saved_memory_id"] = state["memory_id"]
            return result
        except Exception as error:
            code = (str(error) if isinstance(error, MemoryError)
                    else "STORAGE_UNAVAILABLE" if isinstance(error, sqlite3.OperationalError)
                    else "STORAGE_ERROR" if isinstance(error, sqlite3.DatabaseError)
                    else "FILESYSTEM_UNAVAILABLE" if isinstance(error, OSError)
                    else "CHECKPOINT_WRITE_FAILED")
            # No raw exception text or memory body in the operational ledger.
            result = {"status": "failed", "error_code": code, "operation_id": operation_id,
                      "attempts": attempts + 1, "retention_days": state.get("retention_days", days if 'days' in locals() else 30),
                      "retryable": code in RETRYABLE}
            run["checkpoint_write"] = result
            ledger._write(run)
            raise
