"""Durable run ledger for desktop tasks.

A run record is an operational fact log, not a success certificate. Verification
status and input-delivery facts are separate fields, and every transition carries
a caller-supplied operation ID so redelivery is idempotent. The ledger does not
send input, acquire window authorization, or retry work.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import threading
from uuid import uuid4

SCHEMA_VERSION = 1
LIFECYCLES = {"queued", "running", "waiting_user", "stopping", "ended"}
TERMINATIONS = {"completed", "cancelled", "timeout", "error", "failed", "interrupted", "replan_required", "stopped"}
INPUT_DELIVERY = {"not_sent", "sent", "unknown"}
VERIFICATION = {"passed", "failed", "unknown"}
CHECKPOINT_WRITE = {"pending", "saved", "failed", "skipped"}
_ALLOWED = {
    "queued": {"running", "waiting_user", "stopping", "ended"},
    "running": {"waiting_user", "stopping", "ended"},
    "waiting_user": {"running", "stopping", "ended"},
    "stopping": {"ended"},
    "ended": set(),
}


class RunLedgerError(RuntimeError):
    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code
        self.message = message or code


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def _text(value, code="INVALID_RUN_FIELD", maximum=512):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum or "\x00" in value:
        raise RunLedgerError(code)
    return value


def _digest(value):
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


class RunLedger:
    """Atomic per-run JSON with an idempotent transition log.

    This is deliberately a local trusted-store primitive. A same-user process can
    rewrite files; that is outside the ledger's threat model.
    """

    def __init__(self, root: str | Path, *, clock=_now, id_factory=None):
        self.root = Path(root).resolve()
        self.directory = self.root / "runtime" / "runs"
        self.directory.mkdir(parents=True, exist_ok=True)
        self.clock = clock
        self.id_factory = id_factory or (lambda: str(uuid4()))
        self._thread_lock = threading.RLock()

    def _path(self, run_id):
        _text(run_id, "INVALID_RUN_ID", 128)
        if any(ch not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for ch in run_id):
            raise RunLedgerError("INVALID_RUN_ID")
        return self.directory / f"{run_id}.json"

    @contextmanager
    def _locked(self):
        # One ledger-wide lock is sufficient for this low-frequency record layer.
        with self._thread_lock:
            lock_path = self.directory / ".ledger.lock"
            with open(lock_path, "a+b") as handle:
                handle.seek(0, os.SEEK_END)
                if handle.tell() == 0:
                    handle.write(b"\0")
                    handle.flush()
                handle.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
                    try:
                        yield
                    finally:
                        handle.seek(0)
                        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
                    try:
                        yield
                    finally:
                        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    def _write(self, record):
        record["updated_at"] = self._stamp()
        path = self._path(record["run_id"])
        temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
        body = json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        with open(temporary, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(body)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)

    def _stamp(self):
        value = self.clock()
        if not isinstance(value, str):
            raise RunLedgerError("INVALID_CLOCK")
        return value

    def _load(self, run_id):
        path = self._path(run_id)
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise RunLedgerError("RUN_NOT_FOUND") from None
        except (OSError, ValueError):
            raise RunLedgerError("RUN_CORRUPT") from None
        if not isinstance(record, dict) or record.get("schema_version") != SCHEMA_VERSION:
            raise RunLedgerError("RUN_CORRUPT")
        return record

    def start(self, *, task_id, request_id=None, run_id=None, policy_version="v1", scope=None,
              memory_context=None):
        _text(task_id, "INVALID_TASK_ID", 256)
        if request_id is not None:
            _text(request_id, "INVALID_REQUEST_ID", 256)
        _text(policy_version, "INVALID_POLICY_VERSION", 128)
        run_id = run_id or self.id_factory()
        path = self._path(run_id)
        with self._locked():
            if path.exists():
                raise RunLedgerError("RUN_ALREADY_EXISTS")
            record = {
                "schema_version": SCHEMA_VERSION,
                "run_id": run_id,
                "task_id": task_id,
                "request_id": request_id,
                "policy_version": policy_version,
                "scope": scope if isinstance(scope, dict) else None,
                "memory_context": memory_context,
                "lifecycle": "queued",
                "termination_reason": None,
                "input_delivery": "not_sent",
                "verification": {"status": "unknown", "reason": "not_verified"},
                "checkpoint_write": {"status": "pending"},
                "operations": {},
                "created_at": self._stamp(),
                "updated_at": None,
            }
            self._write(record)
            return record

    def transition(self, run_id, *, operation_id, lifecycle=None, termination_reason=None,
                   input_delivery=None, verification=None, checkpoint_write=None,
                   executor_state=None, checkpoint_facts=None):
        """Apply one idempotent transition; a repeated operation returns the prior record."""
        _text(operation_id, "INVALID_OPERATION_ID", 256)
        changes = {}
        if lifecycle is not None:
            if lifecycle not in LIFECYCLES:
                raise RunLedgerError("INVALID_LIFECYCLE")
            changes["lifecycle"] = lifecycle
        if termination_reason is not None:
            if termination_reason not in TERMINATIONS:
                raise RunLedgerError("INVALID_TERMINATION")
            changes["termination_reason"] = termination_reason
        if input_delivery is not None:
            if input_delivery not in INPUT_DELIVERY:
                raise RunLedgerError("INVALID_INPUT_DELIVERY")
            changes["input_delivery"] = input_delivery
        if verification is not None:
            if not isinstance(verification, dict) or verification.get("status") not in VERIFICATION:
                raise RunLedgerError("INVALID_VERIFICATION")
            changes["verification"] = verification
        if checkpoint_write is not None:
            if not isinstance(checkpoint_write, dict) or checkpoint_write.get("status") not in CHECKPOINT_WRITE:
                raise RunLedgerError("INVALID_CHECKPOINT_WRITE")
            changes["checkpoint_write"] = checkpoint_write
        if executor_state is not None:
            if executor_state not in {"stopped", "unknown"}:
                raise RunLedgerError("INVALID_EXECUTOR_STATE")
            changes["executor_state"] = executor_state
        if checkpoint_facts is not None:
            if (not isinstance(checkpoint_facts, list) or len(checkpoint_facts) > 100
                    or any(not isinstance(f, dict) or set(f) != {"step", "input_delivery", "verification"}
                           or type(f["step"]) is not int or not 1 <= f["step"] <= 100
                           or f["input_delivery"] not in INPUT_DELIVERY
                           or f["verification"] not in VERIFICATION for f in checkpoint_facts)):
                raise RunLedgerError("INVALID_CHECKPOINT_FACTS")
            changes["checkpoint_facts"] = checkpoint_facts
        if not changes:
            raise RunLedgerError("NO_CHANGES")
        digest = _digest(changes)
        with self._locked():
            record = self._load(run_id)
            prior = record.setdefault("operations", {}).get(operation_id)
            if prior is not None:
                if prior != digest:
                    raise RunLedgerError("RUN_OPERATION_CONFLICT")
                return record
            current = record["lifecycle"]
            if current == "ended":
                raise RunLedgerError("RUN_ENDED")
            requested = changes.get("lifecycle", current)
            if requested != current and requested not in _ALLOWED[current]:
                raise RunLedgerError("INVALID_TRANSITION")
            if requested != "ended" and changes.get("termination_reason") is not None:
                raise RunLedgerError("TERMINATION_REQUIRES_END")
            if requested == "ended" and changes.get("termination_reason") is None:
                raise RunLedgerError("END_REQUIRES_TERMINATION")
            record.update(changes)
            if requested == "ended":
                record["terminal_event_id"] = operation_id
                record["ended_at"] = self._stamp()
                record["checkpoint_write"] = record.get("checkpoint_write", {"status": "pending"})
            record["operations"][operation_id] = digest
            self._write(record)
            return record

    def end(self, run_id, *, operation_id, termination_reason, input_delivery=None,
            verification=None, checkpoint_write=None, executor_state=None, checkpoint_facts=None):
        return self.transition(run_id, operation_id=operation_id, lifecycle="ended",
                               termination_reason=termination_reason, input_delivery=input_delivery,
                               verification=verification, checkpoint_write=checkpoint_write,
                               executor_state=executor_state, checkpoint_facts=checkpoint_facts)

    def mark_interrupted(self, run_id, *, operation_id):
        return self.end(run_id, operation_id=operation_id, termination_reason="interrupted")

    def checkpoint_result(self, run_id, *, result):
        """A storage acknowledgement can arrive after end; execution stays immutable."""
        if not isinstance(result, dict) or result.get("status") not in {"failed", "skipped"}:
            raise RunLedgerError("INVALID_CHECKPOINT_WRITE")
        allowed = {"status", "reason", "error_code"}
        if set(result) - allowed or any(not isinstance(v, str) or len(v) > 128 for v in result.values()):
            raise RunLedgerError("INVALID_CHECKPOINT_WRITE")
        with self._locked():
            record = self._load(run_id)
            if record["lifecycle"] != "ended":
                raise RunLedgerError("RUN_NOT_ENDED")
            # A timed-out client cannot downgrade an already committed ack.
            if record.get("checkpoint_write", {}).get("status") != "saved":
                record["checkpoint_write"] = {**record.get("checkpoint_write", {}), **result}
                self._write(record)
            return record

    def get(self, run_id):
        with self._locked():
            return self._load(run_id)

    def list(self):
        with self._locked():
            records = []
            for path in sorted(self.directory.glob("*.json")):
                try:
                    record = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    continue
                if isinstance(record, dict) and record.get("schema_version") == SCHEMA_VERSION:
                    records.append(record)
            return records

    def unfinished(self):
        return [record for record in self.list() if record.get("lifecycle") != "ended"]

    def verified_success(self, run_id):
        """Require ended/completed + passed verification + known input delivery.

        This is a coarse gate for a single verification record. Per-step evidence
        and target conditions remain the caller's responsibility.
        """
        record = self.get(run_id)
        return (record.get("lifecycle") == "ended"
                and record.get("termination_reason") == "completed"
                and record.get("verification", {}).get("status") == "passed"
                and record.get("input_delivery") in {"sent", "not_sent"})
