"""Durable local events. A completed tool call is not a successful task.

SQLite transactions protect state across crashes; JSONL is an export format.
Recovery must be invoked only after the previous run owner has stopped.
"""
from __future__ import annotations

import json
import math
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

SCHEMA_VERSION = 1
KINDS = {"observation", "action", "verification", "memory_write", "memory_read", "answer", "evaluation"}
TERMINAL = {"completed", "failed", "timeout", "interrupted"}
OUTCOMES = {"success", "failure", "unknown"}


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def encode(value) -> str:
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def required(**values) -> None:
    if any(not isinstance(v, str) or not v.strip() for v in values.values()):
        raise ValueError("nonempty string required: " + ", ".join(values))


class EventStore:
    def __init__(self, path: str | Path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, timeout=5)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA synchronous=FULL")
        version = self.db.execute("PRAGMA user_version").fetchone()[0]
        if version not in (0, SCHEMA_VERSION):
            self.db.close()
            raise ValueError("unsupported event database schema")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS runs (
                run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
                user_scope TEXT NOT NULL, scenario_id TEXT NOT NULL,
                version TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
                status TEXT NOT NULL, outcome TEXT NOT NULL,
                verifier_event_id TEXT, error_code TEXT
            );
            CREATE TABLE IF NOT EXISTS evidence (
                evidence_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs,
                kind TEXT NOT NULL, reference TEXT NOT NULL, created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS events (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL REFERENCES runs,
                parent_event_id TEXT REFERENCES events(event_id),
                kind TEXT NOT NULL, component TEXT NOT NULL, version TEXT NOT NULL,
                started_at TEXT NOT NULL, ended_at TEXT, status TEXT NOT NULL,
                outcome TEXT NOT NULL, error_code TEXT,
                evidence_ids TEXT NOT NULL, cost TEXT NOT NULL, payload TEXT NOT NULL
            );
            PRAGMA user_version=1;
        """)

    def close(self):
        self.db.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def _run(self, run_id, *, active=False):
        row = self.db.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
        if row is None:
            raise ValueError("unknown run")
        if active and row["status"] != "running":
            raise ValueError("run already closed")
        return dict(row)

    def _event(self, event_id):
        row = self.db.execute("SELECT * FROM events WHERE event_id=?", (event_id,)).fetchone()
        if row is None:
            raise ValueError("unknown event")
        return dict(row)

    def _begin(self):
        # Serialize validation + mutation, including independent process writers.
        self.db.execute("BEGIN IMMEDIATE")

    def start_run(self, *, session_id, user_scope, scenario_id, version):
        required(session_id=session_id, user_scope=user_scope, scenario_id=scenario_id, version=version)
        run_id = str(uuid4())
        with self.db:
            self.db.execute("INSERT INTO runs VALUES (?,?,?,?,?,?,NULL,'running','unknown',NULL,NULL)",
                            (run_id, session_id, user_scope, scenario_id, version, now()))
        return run_id

    def add_evidence(self, run_id, *, kind, reference):
        """Register a local artifact/reference; does not certify its truth."""
        required(kind=kind, reference=reference)
        evidence_id = str(uuid4())
        with self.db:
            self._begin()
            self._run(run_id, active=True)
            self.db.execute("INSERT INTO evidence VALUES (?,?,?,?,?)", (evidence_id, run_id, kind, reference, now()))
        return evidence_id

    def start_event(self, run_id, *, kind, component, version, parent_event_id=None, payload=None):
        if kind not in KINDS:
            raise ValueError("unsupported event kind")
        required(component=component, version=version)
        body = encode({} if payload is None else payload)
        event_id = str(uuid4())
        with self.db:
            self._begin()
            self._run(run_id, active=True)
            if parent_event_id and self._event(parent_event_id)["run_id"] != run_id:
                raise ValueError("parent event belongs to another run")
            self.db.execute("""INSERT INTO events
                (event_id,run_id,parent_event_id,kind,component,version,started_at,status,outcome,evidence_ids,cost,payload)
                VALUES (?,?,?,?,?,?,?,'running','unknown','[]','null',?)""",
                (event_id, run_id, parent_event_id, kind, component, version, now(), body))
        return event_id

    def finish_event(self, event_id, *, status, outcome="unknown", error_code=None, evidence_ids=(), cost=None):
        if status not in TERMINAL or outcome not in OUTCOMES:
            raise ValueError("invalid status or outcome")
        if status != "completed" and outcome != "unknown":
            raise ValueError("failed/incomplete execution cannot certify a business outcome")
        if status != "completed" and not error_code:
            raise ValueError("non-completion requires error_code")
        if cost is not None:
            amount = cost.get("amount") if isinstance(cost, dict) else None
            if (isinstance(amount, bool) or not isinstance(amount, (int, float))
                    or not math.isfinite(amount) or amount < 0):
                raise ValueError("cost amount must be finite and nonnegative")
            required(currency=cost.get("currency"), source=cost.get("source"))
        ids = list(evidence_ids)
        if any(not isinstance(i, str) for i in ids) or len(set(ids)) != len(ids):
            raise ValueError("evidence ids must be unique strings")
        cost_json = encode(cost)
        with self.db:
            self._begin()
            event = self._event(event_id)
            self._run(event["run_id"], active=True)
            if event["status"] != "running":
                raise ValueError("event already finished")
            for evidence_id in ids:
                row = self.db.execute("SELECT run_id FROM evidence WHERE evidence_id=?", (evidence_id,)).fetchone()
                if row is None or row[0] != event["run_id"]:
                    raise ValueError("missing or cross-run evidence")
            if outcome != "unknown" and (event["kind"] != "verification" or not ids):
                raise ValueError("business outcome requires a verification event with evidence")
            self.db.execute("""UPDATE events SET ended_at=?,status=?,outcome=?,error_code=?,evidence_ids=?,cost=?
                WHERE event_id=?""", (now(), status, outcome, error_code, encode(ids), cost_json, event_id))

    def finish_run(self, run_id, *, verifier_event_id=None, status="completed", error_code=None):
        if status not in TERMINAL:
            raise ValueError("invalid terminal run status")
        if status != "completed" and not error_code:
            raise ValueError("non-completion requires error_code")
        if status != "completed" and verifier_event_id:
            raise ValueError("interrupted run cannot claim verified completion")
        outcome = "unknown"
        with self.db:
            self._begin()
            self._run(run_id, active=True)
            if self.db.execute("SELECT 1 FROM events WHERE run_id=? AND status='running'", (run_id,)).fetchone():
                raise ValueError("run still has unfinished events")
            if verifier_event_id:
                verifier = self._event(verifier_event_id)
                if (verifier["run_id"] != run_id or verifier["kind"] != "verification"
                        or verifier["status"] != "completed"):
                    raise ValueError("invalid verifier")
                outcome = verifier["outcome"]
            self.db.execute("UPDATE runs SET ended_at=?,status=?,outcome=?,verifier_event_id=?,error_code=? WHERE run_id=?",
                            (now(), status, outcome, verifier_event_id, error_code, run_id))
        return self.run(run_id)

    def interrupt_run(self, run_id, *, reason="INTERRUPTED"):
        """Explicit recovery/stop; never call on a live owner's run."""
        required(reason=reason)
        with self.db:
            self._begin()
            self._run(run_id, active=True)
            ended = now()
            self.db.execute("""UPDATE events SET ended_at=?,status='interrupted',outcome='unknown',error_code=?
                WHERE run_id=? AND status='running'""", (ended, reason, run_id))
            self.db.execute("UPDATE runs SET ended_at=?,status='interrupted',outcome='unknown',error_code=? WHERE run_id=?",
                            (ended, reason, run_id))
        return self.run(run_id)

    def run(self, run_id):
        return {"schema_version": SCHEMA_VERSION, **self._run(run_id)}

    def events(self, run_id):
        run = self._run(run_id)
        rows = self.db.execute("SELECT * FROM events WHERE run_id=? ORDER BY seq", (run_id,)).fetchall()
        output = []
        for row in rows:
            item = dict(row)
            for field in ("evidence_ids", "cost", "payload"):
                item[field] = json.loads(item[field])
            output.append({"schema_version": SCHEMA_VERSION, "session_id": run["session_id"],
                           "user_scope": run["user_scope"], **item})
        return output

    def export_jsonl(self, run_id, path):
        # Single database snapshot, including run + evidence manifests.
        with self.db:
            self.db.execute("BEGIN")
            records = [{"record_type": "run", **self.run(run_id)}]
            records.extend({"record_type": "evidence", **dict(row)} for row in self.db.execute(
                "SELECT * FROM evidence WHERE run_id=? ORDER BY created_at,evidence_id", (run_id,)))
            records.extend({"record_type": "event", **item} for item in self.events(run_id))
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + "." + str(uuid4()) + ".tmp")
        try:
            temporary.write_text("".join(encode(record) + "\n" for record in records), encoding="utf-8")
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
