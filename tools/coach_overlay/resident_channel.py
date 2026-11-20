"""Python side of the resident assistant channel.

The Node Host owns state.json and the inbox/acks/outbox queues. This module only
reads UI state/outbox and appends user events. It never calls a model, captures
the screen or sends desktop input.
"""
from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

SCHEMA_VERSION = 1
EVENT_KINDS = {
    "chat_submit", "typing_started", "typing_ended", "start_task", "end_task",
    "check_step", "skip_step", "pause_observation", "resume_observation",
    "cancel_task", "stop_response", "close_assistant",
}


def _atomic_write(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f"{path.name}.{os.getpid()}.{uuid4().hex}.tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temp, path)


def _read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None


class ResidentChannel:
    def __init__(self, root: str | Path):
        self.root = Path(root)
        self.inbox = self.root / "inbox"
        self.outbox = self.root / "outbox"
        self.acks = self.root / "acks"
        self.instance_path = self.root / "instance.json"
        self.state_path = self.root / "state.json"
        self.ready_path = self.root / "ui-ready.json"
        self.heartbeat_path = self.root / "ui-heartbeat.json"
        self.assistant_session_id: str | None = None
        self._seq = int(time.time() * 1000)

    def wait_instance(self, timeout: float = 8.0) -> dict:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = _read_json(self.instance_path)
            if value and isinstance(value.get("assistant_session_id"), str):
                self.assistant_session_id = value["assistant_session_id"]
                return value
            time.sleep(0.05)
        raise RuntimeError(f"assistant instance not found: {self.instance_path}")

    def ready(self, **extra) -> dict:
        value = {
            "schema_version": SCHEMA_VERSION,
            "assistant_session_id": self.assistant_session_id,
            "pid": os.getpid(),
            "at": datetime.now(timezone.utc).isoformat(),
            **extra,
        }
        _atomic_write(self.ready_path, value)
        return value

    def heartbeat(self, **extra) -> dict:
        value = {
            "schema_version": SCHEMA_VERSION,
            "assistant_session_id": self.assistant_session_id,
            "pid": os.getpid(),
            "at": datetime.now(timezone.utc).isoformat(),
            **extra,
        }
        _atomic_write(self.heartbeat_path, value)
        return value

    def state(self) -> dict | None:
        return _read_json(self.state_path)

    def messages(self) -> list[dict]:
        values = []
        try:
            names = sorted(self.outbox.glob("*.json"))
        except OSError:
            return []
        for path in names:
            value = _read_json(path)
            if isinstance(value, dict):
                values.append(value)
        return values

    def next_seq(self) -> int:
        self._seq = max(self._seq + 1, int(time.time() * 1000))
        return self._seq

    def send(self, kind: str, payload: dict | None = None, *, task_id: str | None = None,
             context_epoch: int | None = None) -> dict:
        if kind not in EVENT_KINDS:
            raise ValueError(f"unsupported event kind: {kind}")
        state = self.state() or {}
        if context_epoch is None:
            context_epoch = state.get("context_epoch", 0)
        if task_id is None:
            task = state.get("task")
            task_id = task.get("task_id") if isinstance(task, dict) else None
        event = {
            "schema_version": SCHEMA_VERSION,
            "event_id": f"event-{uuid4()}",
            "assistant_session_id": self.assistant_session_id,
            "task_id": task_id,
            "context_epoch": int(context_epoch),
            "client_seq": self.next_seq(),
            "kind": kind,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "payload": payload or {},
        }
        path = self.inbox / f"{event['client_seq']:012d}-{event['event_id']}.json"
        _atomic_write(path, event)
        return event
