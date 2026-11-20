"""Durable operation journal for the fixed desktop executor.

The journal prevents a retransmitted logical action from being sent twice. It
records only operation identity, digest and lifecycle phase; it never stores
screen pixels, textual input or coordinates. It cannot make input and disk I/O
atomic: a crash after ``input_started`` must be treated as possibly executed.
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
from uuid import uuid4

_OPERATION = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
_PHASES = {"prepared", "input_started", "finalized", "refused", "unknown"}


class OperationError(RuntimeError):
    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code
        self.message = message or code


def _stamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def _record(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise OperationError("OPERATION_JOURNAL_CORRUPT") from None
    if not isinstance(value, dict):
        raise OperationError("OPERATION_JOURNAL_CORRUPT")
    return value


class OperationJournal:
    def __init__(self, root: str | Path):
        self.directory = Path(root).resolve() / "runtime" / "operations"

    def _path(self, operation_id: str) -> Path:
        if not isinstance(operation_id, str) or not _OPERATION.fullmatch(operation_id):
            raise OperationError("INVALID_OPERATION_ID")
        self.directory.mkdir(parents=True, exist_ok=True)
        return self.directory / f"{operation_id}.json"

    def _write(self, path: Path, record: dict) -> None:
        temporary = path.with_name(f".{uuid4().hex}.tmp")
        try:
            temporary.write_text(json.dumps(record, ensure_ascii=True, indent=2), encoding="utf-8")
            os.replace(temporary, path)
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass

    def begin(self, *, operation_id: str, request_id: str, digest: str) -> dict:
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise OperationError("INVALID_OPERATION_DIGEST")
        path = self._path(operation_id)
        record = {"schema_version": 1, "operation_id": operation_id, "request_id": request_id,
                  "digest": digest, "phase": "prepared", "created_at": _stamp(),
                  "updated_at": _stamp()}
        try:
            with path.open("x", encoding="utf-8") as file:
                json.dump(record, file, ensure_ascii=True, indent=2)
                file.flush()
                os.fsync(file.fileno())
            return record
        except FileExistsError:
            prior = _record(path)
            if prior.get("digest") != digest:
                raise OperationError("OPERATION_CONFLICT",
                                     "The operation ID was already used with different content") from None
            if prior.get("phase") == "finalized":
                raise OperationError("OPERATION_REPLAYED",
                                     "This operation already completed; inspect its receipt") from None
            raise OperationError("OPERATION_IN_PROGRESS",
                                 "This operation is already in progress or has unknown outcome") from None

    def mark(self, operation_id: str, phase: str, *, outcome: str | None = None) -> dict:
        if phase not in _PHASES:
            raise OperationError("INVALID_OPERATION_PHASE")
        path = self._path(operation_id)
        record = _record(path)
        if record.get("phase") == "finalized" and phase != "finalized":
            raise OperationError("OPERATION_ALREADY_FINALIZED")
        record.update(phase=phase, updated_at=_stamp())
        if outcome is not None:
            record["outcome"] = str(outcome)[:128]
        self._write(path, record)
        return record

    def get(self, operation_id: str) -> dict:
        return _record(self._path(operation_id))
