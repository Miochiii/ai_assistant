"""Explicit, scoped SQLite memory with provenance and conservative erasure.

The host owns identity and source roles. This is a trusted local application API,
not an authenticated service and not a model-callable authorization boundary.
Recalled strings are evidence/data; they never grant permission to execute tools.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
import unicodedata
from uuid import uuid4

VERSION = 1
APPLICATION_ID = 0x4D454D31
KINDS = {"fact", "preference", "profile", "episode", "checkpoint"}
GUIDANCE_KEY = "panel.guidance.style"
GUIDANCE_STYLES = ("一次只说一步", "先给概览")


class MemoryError(ValueError):
    """Stable error code; messages never contain memory content."""


def _text(value, code="INVALID_TEXT", maximum=16000):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum or "\x00" in value:
        raise MemoryError(code)
    return value


def _time(value):
    if not isinstance(value, str):
        raise MemoryError("INVALID_TIME")
    try:
        instant = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if instant.tzinfo is None or instant.utcoffset() is None:
            raise ValueError()
        return instant.astimezone(timezone.utc).isoformat(timespec="microseconds")
    except (ValueError, OverflowError):
        raise MemoryError("INVALID_TIME") from None


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def _encode(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def _normalize(value):
    return unicodedata.normalize("NFKC", value).casefold()


@dataclass(frozen=True)
class Scope:
    user: str
    project: str

    def __post_init__(self):
        _text(self.user, "INVALID_SCOPE", 256)
        _text(self.project, "INVALID_SCOPE", 256)


class MemoryGateway:
    def __init__(self, path: str | Path, scope: Scope, *, clock=_now):
        if not isinstance(scope, Scope):
            raise MemoryError("INVALID_SCOPE")
        self.scope, self.clock = scope, clock
        self._scope = (scope.user, scope.project)
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, timeout=5, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        try:
            app = self.db.execute("PRAGMA application_id").fetchone()[0]
            version = self.db.execute("PRAGMA user_version").fetchone()[0]
            tables = self.db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
            if (app, version) != (APPLICATION_ID, VERSION) and (app or version or tables):
                raise MemoryError("WRONG_DATABASE_OR_SCHEMA")
            self.db.execute("PRAGMA foreign_keys=ON")
            self.db.execute("PRAGMA secure_delete=ON")
            self.db.execute("PRAGMA journal_mode=DELETE")
            self.db.execute("PRAGMA synchronous=FULL")
            schema = Path(__file__).with_name("schema.sql").read_text(encoding="utf-8")
            self.db.executescript("BEGIN IMMEDIATE;\n" + schema +
                                 f"\nPRAGMA application_id={APPLICATION_ID}; PRAGMA user_version={VERSION}; COMMIT;")
        except BaseException:
            self.db.close()
            raise

    def close(self):
        self.db.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    @contextmanager
    def _transaction(self, *, write=False):
        self.db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
        try:
            yield
            self.db.commit()
        except BaseException:
            self.db.rollback()
            raise

    def _stamp(self):
        return _time(self.clock())

    def _audit(self, operation, object_id, stamp):
        self.db.execute("INSERT INTO memory_audit(operation,object_id,user_scope,project_scope,recorded_at) VALUES(?,?,?,?,?)",
                        (operation, object_id, *self._scope, stamp))

    def _event(self, event_id):
        row = self.db.execute("SELECT * FROM memory_events WHERE event_id=? AND user_scope=? AND project_scope=?",
                              (event_id, *self._scope)).fetchone()
        if row is None or row["deleted_at"]:
            raise MemoryError("SOURCE_UNAVAILABLE")
        return row

    def _memory(self, memory_id):
        row = self.db.execute("SELECT * FROM memories WHERE memory_id=? AND user_scope=? AND project_scope=?",
                              (memory_id, *self._scope)).fetchone()
        if row is None or row["deleted_at"]:
            raise MemoryError("MEMORY_UNAVAILABLE")
        return row

    def record_event(self, *, event_id, session_id, channel, origin, content, observed_at=None):
        """Host supplies stable opaque IDs and authentic roles, never model arguments.

        Exact redelivery is idempotent. A deleted ID is permanently rejected.
        One event should represent a small independently erasable source excerpt.
        """
        for item in (event_id, session_id, channel):
            _text(item, maximum=256)
        _text(content)
        if origin not in {"user", "model", "tool", "screen"}:
            raise MemoryError("INVALID_ORIGIN")
        with self._transaction(write=True):
            self._record_event(event_id=event_id, session_id=session_id, channel=channel,
                               origin=origin, content=content, observed_at=observed_at)
        return event_id

    def _record_event(self, *, event_id, session_id, channel, origin, content, observed_at=None):
        """Internal primitive; caller validates fields and owns the write transaction."""
        existing = self.db.execute("SELECT * FROM memory_events WHERE event_id=?", (event_id,)).fetchone()
        if existing:
            if existing["deleted_at"]:
                raise MemoryError("SOURCE_DELETED")
            expected = (*self._scope, session_id, channel, origin, content)
            actual = tuple(existing[k] for k in ("user_scope", "project_scope", "session_id", "channel", "origin", "content"))
            if expected != actual or (observed_at is not None and _time(observed_at) != existing["observed_at"]):
                raise MemoryError("SOURCE_ID_CONFLICT")
            return event_id
        stamp = self._stamp()
        observed = stamp if observed_at is None else _time(observed_at)
        self.db.execute("INSERT INTO memory_events VALUES(?,?,?,?,?,?,?,?,?,NULL)",
                        (event_id, *self._scope, session_id, channel, origin, content, observed, stamp))
        self._audit("source_recorded", event_id, stamp)
        return event_id

    def _sources(self, source_event_ids):
        if not isinstance(source_event_ids, (list, tuple)) or not source_event_ids:
            raise MemoryError("SOURCES_REQUIRED")
        if len(source_event_ids) > 64 or any(not isinstance(x, str) for x in source_event_ids):
            raise MemoryError("INVALID_SOURCES")
        return [self._event(i) for i in dict.fromkeys(source_event_ids)]

    def _content(self, kind, content):
        if kind not in KINDS:
            raise MemoryError("INVALID_KIND")
        if kind == "checkpoint":
            keys = {"goal", "completed", "next_step", "blockers", "status"}
            if not isinstance(content, dict) or set(content) != keys:
                raise MemoryError("INVALID_CHECKPOINT")
            _text(content["goal"])
            _text(content["next_step"])
            if content["status"] not in {"in_progress", "blocked", "completed"}:
                raise MemoryError("INVALID_CHECKPOINT")
            for key in ("completed", "blockers"):
                if not isinstance(content[key], list) or len(content[key]) > 100:
                    raise MemoryError("INVALID_CHECKPOINT")
                for entry in content[key]:
                    _text(entry)
        elif kind == "episode":
            # The baseline records reports, not certified task outcomes.
            if not isinstance(content, dict) or set(content) != {"summary", "outcome"} or content["outcome"] != "unknown":
                raise MemoryError("EPISODE_REQUIRES_UNKNOWN_OUTCOME")
            _text(content["summary"])
        else:
            _text(content)
        encoded = _encode(content)
        if len(encoded) > 16000:
            raise MemoryError("CONTENT_TOO_LARGE")
        return encoded

    def _head(self, kind, key):
        return self.db.execute("""SELECT * FROM memories WHERE user_scope=? AND project_scope=?
            AND kind=? AND memory_key=? AND activated_at IS NOT NULL AND deleted_at IS NULL
            ORDER BY seq DESC LIMIT 1""", (*self._scope, kind, key)).fetchone()

    def _create(self, *, kind, key, content, source_event_ids, supersedes_id=None,
                valid_from=None, valid_to=None, depends_on=(), activate=False):
        _text(key, maximum=256)
        body = self._content(kind, content)
        sources = self._sources(source_event_ids)
        if activate and kind != "checkpoint" and any(s["origin"] != "user" for s in sources):
            raise MemoryError("EXPLICIT_USER_SOURCE_REQUIRED")
        stamp = self._stamp()
        start = stamp if valid_from is None else _time(valid_from)
        end = None if valid_to is None else _time(valid_to)
        if end is not None and end <= start:
            raise MemoryError("INVALID_INTERVAL")
        if not isinstance(depends_on, (list, tuple)) or len(depends_on) > 64 or any(not isinstance(x, str) for x in depends_on):
            raise MemoryError("INVALID_DEPENDENCIES")
        parents = [self._memory(i) for i in dict.fromkeys(depends_on)]
        for parent in parents:
            if not parent["activated_at"] or parent["revoked_at"]:
                raise MemoryError("DEPENDENCY_NOT_ACTIVE")
        head = self._head(kind, key)
        if (head["memory_id"] if head else None) != supersedes_id:
            raise MemoryError("REVISION_CONFLICT")
        if head and start < head["valid_from"]:
            raise MemoryError("NON_MONOTONIC_VALID_TIME")
        mid = str(uuid4())
        self.db.execute("""INSERT INTO memories(memory_id,user_scope,project_scope,kind,memory_key,content,
            recorded_at,activated_at,valid_from,valid_to,supersedes_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
            (mid, *self._scope, kind, key, body, stamp, stamp if activate else None, start, end, supersedes_id))
        self.db.executemany("INSERT INTO memory_sources VALUES(?,?)", [(mid, s["event_id"]) for s in sources])
        self.db.executemany("INSERT INTO memory_dependencies VALUES(?,?)", [(mid, p["memory_id"]) for p in parents])
        if activate:
            self._index(mid, kind, key, body)
        self._audit("activated" if activate else "proposed", mid, stamp)
        return mid

    def propose(self, **record):
        with self._transaction(write=True):
            return self._create(**record, activate=False)

    def remember(self, **record):
        """Trusted host's explicit-user write; revisions require the prior head ID."""
        with self._transaction(write=True):
            return self._create(**record, activate=True)

    def remember_panel_note(self, *, event_id, session_id, original, kind, key, content):
        """Atomically persist one explicit panel command and its note on UI redelivery."""
        for value in (event_id, session_id, key):
            _text(value, maximum=256)
        _text(original)
        if kind not in {"preference", "fact"}:
            raise MemoryError("INVALID_KIND")
        with self._transaction(write=True):
            self._record_event(event_id=event_id, session_id=session_id, channel="assistant-panel",
                               origin="user", content=original)
            head = self._head(kind, key)
            if head and not head["revoked_at"] and json.loads(head["content"]) == content:
                linked = self.db.execute("SELECT 1 FROM memory_sources WHERE memory_id=? AND event_id=?",
                                         (head["memory_id"], event_id)).fetchone()
                if linked:
                    return head["memory_id"]
            return self._create(kind=kind, key=key, content=content, source_event_ids=[event_id], activate=True)

    def set_panel_guidance(self, *, event_id, session_id, original, content):
        """One versioned, workspace-scoped choice from an explicit panel command."""
        for value in (event_id, session_id):
            _text(value, maximum=256)
        _text(original)
        if content not in (*GUIDANCE_STYLES, "停用"):
            raise MemoryError("INVALID_GUIDANCE_STYLE")
        with self._transaction(write=True):
            self._record_event(event_id=event_id, session_id=session_id, channel="panel-guidance-setting",
                               origin="user", content=original)
            head = self._head("preference", GUIDANCE_KEY)
            prior = self.db.execute("SELECT memory_id FROM memory_sources WHERE event_id=?", (event_id,)).fetchone()
            if prior:
                if (head and not head["revoked_at"] and head["memory_id"] == prior["memory_id"]
                        and json.loads(head["content"]) == content):
                    return head["memory_id"]
                raise MemoryError("REVISION_CONFLICT")
            return self._create(kind="preference", key=GUIDANCE_KEY, content=content, source_event_ids=[event_id],
                                supersedes_id=head["memory_id"] if head else None, activate=True)

    def panel_guidance(self):
        """Indexed read of this setting only. Ordinary notes and revisions cannot opt in."""
        with self._transaction():
            head = self._head("preference", GUIDANCE_KEY)
            if not head or head["revoked_at"] or head["valid_to"] or head["valid_from"] > self._stamp():
                return None
            style = json.loads(head["content"])
            if style not in GUIDANCE_STYLES:
                return None
            sources = self.db.execute("""SELECT e.channel, e.origin, e.deleted_at FROM memory_sources s
                JOIN memory_events e ON e.event_id=s.event_id WHERE s.memory_id=?""", (head["memory_id"],)).fetchall()
            if len(sources) != 1 or tuple(sources[0]) != ("panel-guidance-setting", "user", None):
                return None
            return {"version": head["memory_id"], "style": style}

    def confirm(self, memory_id, *, confirmation_event_id):
        with self._transaction(write=True):
            memory = self._memory(memory_id)
            confirmation = self._event(confirmation_event_id)
            if confirmation["origin"] != "user":
                raise MemoryError("EXPLICIT_USER_SOURCE_REQUIRED")
            if memory["activated_at"] or memory["revoked_at"]:
                raise MemoryError("NOT_PENDING")
            head = self._head(memory["kind"], memory["memory_key"])
            if (head["memory_id"] if head else None) != memory["supersedes_id"]:
                raise MemoryError("REVISION_CONFLICT")
            self._sources([r[0] for r in self.db.execute("SELECT event_id FROM memory_sources WHERE memory_id=?", (memory_id,))])
            for row in self.db.execute("SELECT parent_id FROM memory_dependencies WHERE memory_id=?", (memory_id,)):
                parent = self._memory(row[0])
                if parent["revoked_at"]:
                    raise MemoryError("DEPENDENCY_NOT_ACTIVE")
            stamp = self._stamp()
            self.db.execute("UPDATE memories SET activated_at=? WHERE memory_id=?", (stamp, memory_id))
            self.db.execute("INSERT OR IGNORE INTO memory_sources VALUES(?,?)", (memory_id, confirmation_event_id))
            self._index(memory_id, memory["kind"], memory["memory_key"], memory["content"])
            self._audit("confirmed", memory_id, stamp)
        return memory_id

    def _index(self, memory_id, kind, key, body):
        value = json.loads(body)
        # No schema keys in search text; only actual content and the exact key.
        if kind == "checkpoint":
            text = " ".join([value["goal"], *value["completed"], value["next_step"], *value["blockers"]])
        elif kind == "episode":
            text = value["summary"]
        else:
            text = value
        self.db.execute("INSERT OR REPLACE INTO memory_search VALUES(?,?)", (memory_id, _normalize(key + " " + text)))

    def _rows(self, *, kind=None, key=None):
        sql = "SELECT * FROM memories WHERE user_scope=? AND project_scope=? AND deleted_at IS NULL"
        args = list(self._scope)
        if kind is not None:
            if kind not in KINDS:
                raise MemoryError("INVALID_KIND")
            sql += " AND kind=?"
            args.append(kind)
        if key is not None:
            _text(key, maximum=256)
            sql += " AND memory_key=?"
            args.append(key)
        return self.db.execute(sql + " ORDER BY seq", args).fetchall()

    def _selection(self, rows, instant):
        heads = {}
        for row in rows:
            if row["activated_at"] and row["valid_from"] <= instant:
                heads[(row["kind"], row["memory_key"])] = row["memory_id"]
        reasons = {}
        for row in rows:
            if row["revoked_at"]:
                reason = "revoked"
            elif not row["activated_at"]:
                reason = "candidate"
            elif row["valid_from"] > instant:
                reason = "not_yet_valid"
            elif heads.get((row["kind"], row["memory_key"])) != row["memory_id"]:
                reason = "superseded"
            elif row["valid_to"] and instant >= row["valid_to"]:
                reason = "expired"
            else:
                reason = "selected"
            reasons[row["memory_id"]] = reason
        # A summary/checkpoint derived from an old fact must not silently
        # survive a correction or expiry. No dependency cycles can be created:
        # parents must already exist before a new immutable row is inserted.
        dependencies = list(self.db.execute("SELECT memory_id,parent_id FROM memory_dependencies"))
        while True:
            changed = False
            for mid, parent in dependencies:
                if reasons.get(mid) == "selected" and reasons.get(parent) != "selected":
                    reasons[mid] = "dependency_unavailable"
                    changed = True
            if not changed:
                break
        return reasons

    def _view(self, row, reason):
        sources = [dict(s) for s in self.db.execute("""SELECT e.event_id,e.session_id,e.channel,e.origin,
            e.observed_at,e.recorded_at,e.content FROM memory_events e JOIN memory_sources s ON e.event_id=s.event_id
            WHERE s.memory_id=? AND e.deleted_at IS NULL ORDER BY e.event_id""", (row["memory_id"],))]
        return {"memory_id": row["memory_id"], "kind": row["kind"], "key": row["memory_key"],
                "content": json.loads(row["content"]), "user_scope": row["user_scope"], "project_scope": row["project_scope"],
                "recorded_at": row["recorded_at"], "activated_at": row["activated_at"],
                "valid_from": row["valid_from"], "valid_to": row["valid_to"], "revoked_at": row["revoked_at"],
                "supersedes_id": row["supersedes_id"], "reason": reason,
                "status": "revoked" if row["revoked_at"] else ("active" if row["activated_at"] else "candidate"),
                "sources": sources, "depends_on": [r[0] for r in self.db.execute(
                    "SELECT parent_id FROM memory_dependencies WHERE memory_id=? ORDER BY parent_id", (row["memory_id"],))],
                "trust": "context_only", "execution_authority": False, "schema_version": VERSION}

    def recall(self, *, route="current", kind=None, key=None, query=None, at=None, limit=10, max_chars=24000):
        """Routes are explicit: no heuristic classification of user questions.

        `at` means valid-time according to today's retained evidence, NOT a
        reconstruction of what the system knew then. Revocations stay excluded.
        """
        if route not in {"none", "current", "history", "search"}:
            raise MemoryError("INVALID_ROUTE")
        if type(limit) is not int or not 1 <= limit <= 100:
            raise MemoryError("INVALID_LIMIT")
        if type(max_chars) is not int or not 512 <= max_chars <= 64000:
            raise MemoryError("INVALID_CONTEXT_BUDGET")
        instant = self._stamp() if at is None else _time(at)
        result = {"route": route, "as_of": instant, "items": [], "excluded": [], "truncated": False,
                  "execution_authority": False, "reason": "memory_not_required" if route == "none" else "no_match"}
        if route == "none":
            return result
        if route in {"current", "history"} and (kind is None or key is None):
            raise MemoryError("EXACT_KEY_REQUIRED")
        tokens = []
        if route == "search":
            tokens = list(dict.fromkeys(_normalize(_text(query, maximum=512)).split()))
            if not tokens:
                raise MemoryError("INVALID_QUERY")
        with self._transaction():
            rows = self._rows(kind=kind, key=key)
            reasons = self._selection(self._rows(), instant)
            matches = []
            for row in rows:
                reason = reasons[row["memory_id"]]
                if route == "history":
                    matches.append((row, reason, 0))
                elif reason != "selected":
                    if route == "current":
                        result["excluded"].append({"memory_id": row["memory_id"], "reason": reason})
                elif route == "search":
                    entry = self.db.execute("SELECT text FROM memory_search WHERE memory_id=?", (row["memory_id"],)).fetchone()
                    if entry and all(token in entry[0] for token in tokens):
                        matches.append((row, "literal_text_match", sum(entry[0].count(t) for t in tokens)))
                else:
                    matches.append((row, reason, 0))
            if route == "search":
                matches.sort(key=lambda entry: (-entry[2], -entry[0]["seq"]))
            # History is newest-first, so truncation does not hide recent corrections.
            elif route == "history":
                matches.reverse()
            result["truncated"] = len(matches) > limit or len(result["excluded"]) > 100
            result["excluded"] = result["excluded"][-100:]
            used = 0
            for row, reason, _ in matches[:limit]:
                item = self._view(row, reason)
                size = len(_encode(item))
                if used + size > max_chars:
                    result["truncated"] = True
                    result["reason"] = "context_budget_exceeded"
                    result["excluded"].append({"memory_id": row["memory_id"], "reason": "context_budget_exceeded"})
                    continue
                result["items"].append(item)
                used += size
            result["context_chars"] = used
            result["max_chars"] = max_chars
            if result["items"]:
                result["reason"] = "matched"
            return result

    def _context_key(self, session_id, request_id=None, generation=1):
        _text(session_id, "INVALID_SESSION_ID", 256)
        if request_id is not None:
            _text(request_id, "INVALID_REQUEST_ID", 256)
        if type(generation) is not int or not 1 <= generation <= 1_000_000:
            raise MemoryError("INVALID_CONTEXT_GENERATION")

    def _context_state_row(self, session_id, generation):
        return self.db.execute("""SELECT * FROM memory_context_states
                WHERE user_scope=? AND project_scope=? AND session_id=? AND generation=?""",
                (*self._scope, session_id, generation)).fetchone()

    def _refresh_context(self, session_id, generation, stamp):
        """Mark exposed contexts stale when an exposed memory is no longer active.

        This is a conservative, metadata-only check. It does not rewrite history and
        does not claim that an already-submitted remote request was retracted.
        """
        rows = self.db.execute("""SELECT * FROM memory_context_exposures
                WHERE user_scope=? AND project_scope=? AND session_id=? AND generation=?""",
                (*self._scope, session_id, generation)).fetchall()
        affected = set()
        for exposure in rows:
            if exposure["stage"] == "invalidated":
                continue
            for memory_id in json.loads(exposure["memory_ids"]):
                memory = self.db.execute("""SELECT revoked_at,deleted_at,valid_to FROM memories
                        WHERE memory_id=? AND user_scope=? AND project_scope=?""",
                        (memory_id, *self._scope)).fetchone()
                active = (memory is not None and not memory["revoked_at"] and not memory["deleted_at"]
                          and (memory["valid_to"] is None or memory["valid_to"] > stamp))
                if not active:
                    affected.add(exposure["exposure_id"])
        if affected:
            self._invalidate_context_exposures(affected, "memory_not_active", stamp)
        state = self._context_state_row(session_id, generation)
        if state is None:
            self.db.execute("""INSERT INTO memory_context_states
                    (user_scope,project_scope,session_id,generation,status,revision,
                     invalidation_event_ids,updated_at) VALUES(?,?,?,?,?,?,?,?)""",
                    (*self._scope, session_id, generation, "clean", 0, "[]", stamp))
            return self._context_state_row(session_id, generation)
        return state

    def _invalidate_context_exposures(self, exposure_ids, reason, stamp):
        if not exposure_ids:
            return
        for exposure_id in sorted(exposure_ids):
            self.db.execute("""UPDATE memory_context_exposures
                    SET stage='invalidated', invalidated_at=?, invalidation_reason=?
                    WHERE exposure_id=? AND user_scope=? AND project_scope=?""",
                    (stamp, reason[:128], exposure_id, *self._scope))
        states = self.db.execute("""SELECT DISTINCT session_id,generation FROM memory_context_exposures
                WHERE exposure_id IN ({}) AND user_scope=? AND project_scope=?""".format(
                    ",".join("?" for _ in exposure_ids)),
                (*sorted(exposure_ids), *self._scope)).fetchall()
        for state in states:
            current = self._context_state_row(state["session_id"], state["generation"])
            revision = (current["revision"] if current else 0) + 1
            events = json.loads(current["invalidation_event_ids"]) if current else []
            events = (events + [reason[:128]])[-100:]
            if current:
                self.db.execute("""UPDATE memory_context_states SET status='needs_refresh',revision=?,
                        invalidation_event_ids=?,updated_at=? WHERE user_scope=? AND project_scope=?
                        AND session_id=? AND generation=?""",
                        (revision, json.dumps(events, ensure_ascii=True), stamp, *self._scope,
                         state["session_id"], state["generation"]))
            else:
                self.db.execute("""INSERT INTO memory_context_states
                        (user_scope,project_scope,session_id,generation,status,revision,
                         invalidation_event_ids,updated_at) VALUES(?,?,?,?,?,?,?,?)""",
                        (*self._scope, state["session_id"], state["generation"], "needs_refresh",
                         revision, json.dumps(events, ensure_ascii=True), stamp))

    def _invalidate_memories_in_context(self, memory_ids, reason, stamp):
        wanted = set(memory_ids)
        affected = set()
        for exposure in self.db.execute("""SELECT exposure_id,memory_ids FROM memory_context_exposures
                WHERE user_scope=? AND project_scope=? AND stage!='invalidated'""", self._scope):
            if wanted & set(json.loads(exposure["memory_ids"])):
                affected.add(exposure["exposure_id"])
        if affected:
            self._invalidate_context_exposures(affected, reason, stamp)

    def context_state(self, *, session_id, generation=1):
        self._context_key(session_id, generation=generation)
        with self._transaction(write=True):
            state = self._refresh_context(session_id, generation, self._stamp())
            return {"session_id": session_id, "generation": generation,
                    "status": state["status"], "revision": state["revision"],
                    "invalidation_event_ids": json.loads(state["invalidation_event_ids"]),
                    "execution_authority": False}

    def context_generation(self, *, session_id):
        """Return the latest context generation for host bootstrap after restart."""
        self._context_key(session_id)
        row = self.db.execute("""SELECT MAX(generation) AS generation
                FROM memory_context_states
                WHERE user_scope=? AND project_scope=? AND session_id=?""",
                (*self._scope, session_id)).fetchone()
        generation = int(row["generation"] or 1) if row else 1
        return {"session_id": session_id, "generation": generation,
                "has_state": bool(row and row["generation"]),
                "execution_authority": False}

    def refresh_context(self, *, session_id, generation=1, reason="manual"):
        """Create a fresh clean generation without rewriting conversation history.

        The old generation and its exposures remain as audit evidence. This only
        makes the scoped context usable again; it does not erase remote requests
        or history that already contains the old memory text.
        """
        self._context_key(session_id, generation=generation)
        _text(reason, "INVALID_INVALIDATION_REASON", 128)
        with self._transaction(write=True):
            row = self.db.execute("""SELECT MAX(generation) AS generation
                    FROM memory_context_states
                    WHERE user_scope=? AND project_scope=? AND session_id=?""",
                    (*self._scope, session_id)).fetchone()
            latest = int(row["generation"] or 0) if row else 0
            next_generation = max(latest, generation) + 1
            if next_generation > 1_000_000:
                raise MemoryError("INVALID_CONTEXT_GENERATION")
            stamp = self._stamp()
            self.db.execute("""INSERT INTO memory_context_states
                    (user_scope,project_scope,session_id,generation,status,revision,
                     invalidation_event_ids,updated_at) VALUES(?,?,?,?,?,?,?,?)""",
                    (*self._scope, session_id, next_generation, "clean", 0, "[]", stamp))
            self._audit("context_refreshed", session_id, stamp)
            return {"session_id": session_id, "generation": next_generation,
                    "previous_generation": generation, "status": "clean", "revision": 0,
                    "reason": reason, "external_history_unchanged": True,
                    "execution_authority": False}

    def register_exposure(self, *, session_id, request_id, generation=1,
                          memory_ids=None, stage="prepared"):
        self._context_key(session_id, request_id, generation)
        if stage not in {"prepared", "submitted_to_adapter"}:
            raise MemoryError("INVALID_EXPOSURE_STAGE")
        if not isinstance(memory_ids, (list, tuple)) or not memory_ids:
            raise MemoryError("INVALID_EXPOSURE_MEMORY_IDS")
        normalized = sorted({_text(memory_id, "INVALID_EXPOSURE_MEMORY_IDS", 256)
                             for memory_id in memory_ids})
        with self._transaction(write=True):
            state = self._refresh_context(session_id, generation, self._stamp())
            if state["status"] != "clean":
                raise MemoryError("CONTEXT_NEEDS_REFRESH")
            stamp = self._stamp()
            rows = self.db.execute("""SELECT memory_id FROM memories
                    WHERE user_scope=? AND project_scope=? AND memory_id IN ({})
                    AND revoked_at IS NULL AND deleted_at IS NULL
                    AND (valid_to IS NULL OR valid_to>?)""".format(
                        ",".join("?" for _ in normalized)),
                    (*self._scope, *normalized, stamp)).fetchall()
            if len(rows) != len(normalized):
                raise MemoryError("MEMORY_UNAVAILABLE")
            identity = json.dumps([*self._scope, session_id, request_id, generation, normalized],
                                  ensure_ascii=True, separators=(",", ":"))
            exposure_id = "exposure-" + hashlib.sha256(identity.encode("utf-8")).hexdigest()[:32]
            self.db.execute("""INSERT OR IGNORE INTO memory_context_exposures
                    (exposure_id,user_scope,project_scope,session_id,request_id,generation,
                     memory_ids,stage,recorded_at) VALUES(?,?,?,?,?,?,?,?,?)""",
                    (exposure_id, *self._scope, session_id, request_id, generation,
                     json.dumps(normalized, ensure_ascii=True, separators=(",", ":")), stage, stamp))
            current = self.db.execute("""SELECT stage FROM memory_context_exposures
                    WHERE exposure_id=?""", (exposure_id,)).fetchone()
            if current and current["stage"] == "prepared" and stage == "submitted_to_adapter":
                self.db.execute("UPDATE memory_context_exposures SET stage=? WHERE exposure_id=?",
                                (stage, exposure_id))
            return {"exposure_id": exposure_id, "session_id": session_id,
                    "request_id": request_id, "generation": generation,
                    "memory_ids": normalized, "stage": stage,
                    "execution_authority": False}

    def invalidate_context(self, *, session_id, generation=1, reason="manual"):
        self._context_key(session_id, generation=generation)
        _text(reason, "INVALID_INVALIDATION_REASON", 128)
        with self._transaction(write=True):
            stamp = self._stamp()
            exposures = self.db.execute("""SELECT exposure_id FROM memory_context_exposures
                    WHERE user_scope=? AND project_scope=? AND session_id=? AND generation=?
                    AND stage!='invalidated'""", (*self._scope, session_id, generation)).fetchall()
            self._invalidate_context_exposures({row["exposure_id"] for row in exposures}, reason, stamp)
            state = self._refresh_context(session_id, generation, stamp)
            return {"session_id": session_id, "generation": generation,
                    "status": state["status"], "revision": state["revision"],
                    "invalidation_event_ids": json.loads(state["invalidation_event_ids"]),
                    "execution_authority": False}

    def promote_exposures(self, *, session_id, generation=1):
        """Mark already-prepared exposures as submitted before a model dispatch."""
        self._context_key(session_id, generation=generation)
        with self._transaction(write=True):
            state = self._refresh_context(session_id, generation, self._stamp())
            if state["status"] != "clean":
                raise MemoryError("CONTEXT_NEEDS_REFRESH")
            cursor = self.db.execute("""UPDATE memory_context_exposures
                    SET stage='submitted_to_adapter'
                    WHERE user_scope=? AND project_scope=? AND session_id=? AND generation=?
                    AND stage='prepared'""", (*self._scope, session_id, generation))
            return {"session_id": session_id, "generation": generation,
                    "promoted": cursor.rowcount, "execution_authority": False}

    def revoke(self, memory_id):
        """Withdraw this version and derived memories; do not reactivate old values."""
        with self._transaction(write=True):
            self._memory(memory_id)
            ids = {memory_id}
            while True:
                extra = {r[0] for r in self.db.execute("SELECT memory_id,parent_id FROM memory_dependencies") if r[1] in ids}
                if extra <= ids:
                    break
                ids |= extra
            stamp = self._stamp()
            for mid in sorted(ids):
                self.db.execute("UPDATE memories SET revoked_at=COALESCE(revoked_at,?) WHERE memory_id=?", (stamp, mid))
                self.db.execute("DELETE FROM memory_search WHERE memory_id=?", (mid,))
                self._audit("revoked", mid, stamp)
            self._invalidate_memories_in_context(ids, "revoked", stamp)
        return {"revoked_memory_ids": sorted(ids)}

    def _erasure(self, memory_id=None, event_id=None):
        # All versions, dependent summaries, and memories sharing an erased
        # source are included. Conservative closure deliberately over-deletes.
        if (memory_id is None) == (event_id is None):
            raise MemoryError("ONE_ERASURE_TARGET_REQUIRED")
        if memory_id is not None:
            self._memory(memory_id)
        else:
            self._event(event_id)
        rows = self._rows()
        links = list(self.db.execute("SELECT memory_id,event_id FROM memory_sources"))
        deps = list(self.db.execute("SELECT memory_id,parent_id FROM memory_dependencies"))
        mids, eids = ({memory_id} if memory_id else set()), ({event_id} if event_id else set())
        while True:
            previous = (len(mids), len(eids))
            series = {(r["kind"], r["memory_key"]) for r in rows if r["memory_id"] in mids}
            mids.update(r["memory_id"] for r in rows if (r["kind"], r["memory_key"]) in series)
            eids.update(r[1] for r in links if r[0] in mids)
            mids.update(r[0] for r in links if r[1] in eids)
            mids.update(r[0] for r in deps if r[1] in mids)
            if (len(mids), len(eids)) == previous:
                return {"memory_ids": sorted(mids), "event_ids": sorted(eids), "policy": "source_and_revision_closure"}

    def _plan_metadata(self, plan):
        encoded = json.dumps(plan, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode("utf-8")
        memory_seq = self.db.execute("SELECT COALESCE(MAX(seq),0) FROM memories").fetchone()[0]
        event_count = self.db.execute("SELECT COUNT(*) FROM memory_events").fetchone()[0]
        audit_seq = self.db.execute("SELECT COALESCE(MAX(seq),0) FROM memory_audit").fetchone()[0]
        return {"plan_id": hashlib.sha256(encoded).hexdigest(),
                "data_version": f"{memory_seq}:{event_count}:{audit_seq}",
                "checked_at": self._stamp()}

    def deletion_plan(self, *, memory_id=None, event_id=None):
        with self._transaction():
            plan = self._erasure(memory_id, event_id)
            return {**plan, **self._plan_metadata(plan)}

    def forget(self, *, memory_id=None, event_id=None, plan_id=None, data_version=None):
        """Logical erasure within this DB. External exports/backups are not owned.

        When plan_id/data_version are supplied, refuse if the recomputed plan or
        database version differs from what the user approved.
        """
        with self._transaction(write=True):
            plan = self._erasure(memory_id, event_id)
            if (plan_id is None) != (data_version is None):
                raise MemoryError("INVALID_DELETION_PLAN")
            if plan_id is not None:
                metadata = self._plan_metadata(plan)
                if plan_id != metadata["plan_id"] or data_version != metadata["data_version"]:
                    raise MemoryError("DELETION_PLAN_CHANGED")
            stamp = self._stamp()
            for mid in plan["memory_ids"]:
                self.db.execute("DELETE FROM memory_search WHERE memory_id=?", (mid,))
                self.db.execute("UPDATE memories SET content=NULL,memory_key=NULL,deleted_at=? WHERE memory_id=?", (stamp, mid))
                self._audit("deleted_memory", mid, stamp)
            for eid in plan["event_ids"]:
                self.db.execute("UPDATE memory_events SET content=NULL,session_id='',channel='',deleted_at=? WHERE event_id=?", (stamp, eid))
                self._audit("deleted_source", eid, stamp)
            self._invalidate_memories_in_context(plan["memory_ids"], "forgotten", stamp)
        return {**plan, "external_copies_erased": False}

    def rebuild_index(self):
        with self._transaction(write=True):
            self.db.execute("DELETE FROM memory_search WHERE memory_id IN (SELECT memory_id FROM memories WHERE user_scope=? AND project_scope=?)", self._scope)
            rows = [r for r in self._rows() if r["activated_at"] and not r["revoked_at"]]
            for row in rows:
                self._index(row["memory_id"], row["kind"], row["memory_key"], row["content"])
        return {"indexed": len(rows)}

    def save_checkpoint(self, *, task_id, content, source_event_ids, supersedes_id=None,
                        depends_on=(), operation_id=None, valid_from=None, valid_to=None):
        # Task state is always unverified working context, never a success receipt.
        if operation_id is None:
            return self.remember(kind="checkpoint", key=task_id, content=content,
                                 source_event_ids=source_event_ids,
                                 supersedes_id=supersedes_id, depends_on=depends_on,
                                 valid_from=valid_from, valid_to=valid_to)
        with self._transaction(write=True):
            return self._save_checkpoint_record(task_id=task_id, content=content,
                source_event_ids=source_event_ids, supersedes_id=supersedes_id,
                depends_on=depends_on, operation_id=operation_id,
                valid_from=valid_from, valid_to=valid_to)

    def _save_checkpoint_record(self, *, task_id, content, source_event_ids,
                                supersedes_id=None, depends_on=(), operation_id,
                                valid_from=None, valid_to=None):
        """Internal checkpoint primitive, inside the caller's write transaction."""
        _text(operation_id, maximum=256)
        request = {
            "task_id": task_id, "content": content,
            "source_event_ids": sorted(source_event_ids),
            "supersedes_id": supersedes_id, "depends_on": sorted(depends_on),
        }
        # Preserve digests of existing v1 operations without an expiry.
        if valid_from is not None or valid_to is not None:
            request.update(valid_from=valid_from, valid_to=valid_to)
        digest = hashlib.sha256(_encode(request).encode("utf-8")).hexdigest()
        existing = self.db.execute("SELECT * FROM memory_operations WHERE operation_id=?",
                                   (operation_id,)).fetchone()
        if existing is not None:
            if (existing["operation"], existing["user_scope"], existing["project_scope"],
                    existing["request_digest"]) != ("save_checkpoint", *self._scope, digest):
                raise MemoryError("IDEMPOTENCY_CONFLICT")
            try:
                self._memory(existing["object_id"])
            except MemoryError:
                raise MemoryError("OPERATION_DELETED") from None
            return existing["object_id"]
        memory_id = self._create(kind="checkpoint", key=task_id, content=content,
                                     source_event_ids=source_event_ids, supersedes_id=supersedes_id,
                                     depends_on=depends_on, activate=True,
                                     valid_from=valid_from, valid_to=valid_to)
        self.db.execute("""INSERT INTO memory_operations
                (operation_id,operation,request_digest,user_scope,project_scope,object_id,recorded_at)
                VALUES(?,?,?,?,?,?,?)""",
                (operation_id, "save_checkpoint", digest, *self._scope, memory_id, self._stamp()))
        return memory_id

    def resume(self, task_id):
        result = self.recall(kind="checkpoint", key=task_id)
        result.update({"requires_fresh_observation": True, "automatic_execution": False,
                       "task_success_verified": False})
        return result

    def export(self):
        with self._transaction():
            rows = self._rows()
            reasons = self._selection(rows, self._stamp())
            return {"schema_version": VERSION, "user_scope": self.scope.user, "project_scope": self.scope.project,
                    "items": [self._view(row, reasons[row["memory_id"]]) for row in rows],
                    "events": [dict(row) for row in self.db.execute(
                        "SELECT * FROM memory_events WHERE user_scope=? AND project_scope=? AND deleted_at IS NULL", self._scope)],
                    "external_copy": True}

    def audit(self):
        return [dict(row) for row in self.db.execute(
            "SELECT operation,object_id,recorded_at FROM memory_audit WHERE user_scope=? AND project_scope=? ORDER BY seq", self._scope)]
