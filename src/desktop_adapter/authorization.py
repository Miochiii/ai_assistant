"""Session task authorization.

A grant is a local, user-issued scope: which window identities may be acted on,
which actions are allowed, the Harness session (optional) and an expiry. It is
checked at the tool/adapter boundary and again by the fixed executor before
input. This is an accident boundary, not a defense against arbitrary same-user
local code that can rewrite the grant files.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
from uuid import uuid4

GRANT_SCHEMA = 1
ACTIONS = ("activate", "observe", "click", "replay", "scroll", "key", "text", "chord", "drag")
DEFAULT_ACTIONS = ("activate", "observe", "click", "replay")
_GRANT_ID = re.compile(r"^[a-f0-9-]{36}$")
_WINDOW_KEYS = ("hwnd", "pid", "class_name", "title")


class GrantError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_time(value) -> datetime:
    try:
        parsed = datetime.fromisoformat(str(value))
    except ValueError:
        raise GrantError("AUTHORIZATION_INVALID", "Grant time is invalid") from None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def grant_dir(root: Path | str) -> Path:
    return Path(root).resolve() / "runtime" / "authorizations"


def _path(root: Path | str, grant_id: str) -> Path:
    if not isinstance(grant_id, str) or not _GRANT_ID.fullmatch(grant_id):
        raise GrantError("AUTHORIZATION_INVALID", "Grant id is invalid")
    return grant_dir(root) / f"{grant_id}.json"


def _window(value) -> dict:
    if not isinstance(value, dict):
        raise GrantError("AUTHORIZATION_INVALID", "Grant window must be an object")
    window = {}
    for key in _WINDOW_KEYS:
        if key in ("hwnd", "pid"):
            if type(value.get(key)) is not int:
                raise GrantError("AUTHORIZATION_INVALID", f"Grant window {key} is invalid")
        elif not isinstance(value.get(key), str):
            raise GrantError("AUTHORIZATION_INVALID", f"Grant window {key} is invalid")
        window[key] = value[key]
    return window


def _grant(payload: dict) -> dict:
    if not isinstance(payload, dict) or payload.get("schema_version") != GRANT_SCHEMA:
        raise GrantError("AUTHORIZATION_INVALID", "Grant schema is invalid")
    grant_id = payload.get("grant_id")
    if not isinstance(grant_id, str) or not _GRANT_ID.fullmatch(grant_id):
        raise GrantError("AUTHORIZATION_INVALID", "Grant id is invalid")
    actions = payload.get("actions")
    if not isinstance(actions, list) or not actions or any(a not in ACTIONS for a in actions):
        raise GrantError("AUTHORIZATION_INVALID", "Grant actions are invalid")
    windows = payload.get("windows")
    if not isinstance(windows, list) or not windows:
        raise GrantError("AUTHORIZATION_INVALID", "Grant must include at least one window")
    program_ids = payload.get("program_ids")
    if program_ids is not None and (not isinstance(program_ids, list)
                                    or any(not isinstance(p, str) for p in program_ids)):
        raise GrantError("AUTHORIZATION_INVALID", "Grant program_ids are invalid")
    return {
        "schema_version": GRANT_SCHEMA, "grant_id": grant_id,
        "created_at": payload.get("created_at"), "expires_at": payload.get("expires_at"),
        "task": payload.get("task", ""), "harness_session": payload.get("harness_session"),
        "windows_session": payload.get("windows_session"),
        "windows": [_window(w) for w in windows], "actions": list(dict.fromkeys(actions)),
        "program_ids": program_ids,
    }


def create_grant(root: Path | str, *, windows, actions=DEFAULT_ACTIONS,
                 ttl_seconds: int = 600, task: str = "", harness_session: str | None = None,
                 windows_session: int | None = None, program_ids=None) -> dict:
    if not isinstance(ttl_seconds, int) or not 1 <= ttl_seconds <= 86400:
        raise GrantError("AUTHORIZATION_INVALID", "ttl_seconds must be 1..86400")
    now = _now()
    payload = {"schema_version": GRANT_SCHEMA, "grant_id": str(uuid4()),
               "created_at": now.isoformat(), "expires_at": (now + timedelta(seconds=ttl_seconds)).isoformat(),
               "task": task, "harness_session": harness_session,
               "windows_session": windows_session,
               "windows": [_window(w) for w in windows],
               "actions": list(dict.fromkeys(actions)), "program_ids": program_ids}
    grant = _grant(payload)
    path = _path(root, grant["grant_id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("x", encoding="utf-8") as file:
            json.dump(grant, file, ensure_ascii=False, indent=2)
    except FileExistsError:
        raise GrantError("AUTHORIZATION_ALREADY_EXISTS", "Grant already exists") from None
    return grant


def load_grant(root: Path | str, grant_id: str, *, now: datetime | None = None) -> dict:
    path = _path(root, grant_id)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise GrantError("AUTHORIZATION_NOT_FOUND", "Grant is not stored") from None
    grant = _grant(payload)
    if grant["grant_id"] != grant_id:
        raise GrantError("AUTHORIZATION_INVALID", "Grant identity does not match its path")
    current = now or _now()
    if _parse_time(grant["expires_at"]) <= current.astimezone(timezone.utc):
        raise GrantError("AUTHORIZATION_EXPIRED", "Grant has expired")
    return grant


def window_matches(grant: dict, window: dict) -> bool:
    return any(all(grant_window.get(key) == window.get(key) for key in _WINDOW_KEYS)
               for grant_window in grant["windows"])


def check_grant(grant: dict, *, window: dict, action: str, program_id: str | None = None,
                now: datetime | None = None) -> None:
    if action not in ACTIONS:
        raise GrantError("AUTHORIZATION_INVALID", "Unknown grant action")
    if _parse_time(grant["expires_at"]) <= (now or _now()).astimezone(timezone.utc):
        raise GrantError("AUTHORIZATION_EXPIRED", "Grant has expired")
    if action not in grant["actions"]:
        raise GrantError("AUTHORIZATION_ACTION_NOT_ALLOWED", f"Action {action} is outside the grant")
    if not window_matches(grant, window):
        raise GrantError("AUTHORIZATION_WINDOW_NOT_ALLOWED", "Window is outside the grant")
    if program_id is not None and grant.get("program_ids") and program_id not in grant["program_ids"]:
        raise GrantError("AUTHORIZATION_PROGRAM_NOT_ALLOWED", "Program is outside the grant")


def list_grants(root: Path | str, *, harness_session: str | None = None,
                now: datetime | None = None) -> list[dict]:
    directory = grant_dir(root)
    if not directory.is_dir():
        return []
    result = []
    for path in directory.glob("*.json"):
        try:
            grant = load_grant(root, path.stem, now=now)
        except GrantError:
            continue
        if harness_session is not None and grant.get("harness_session") not in (None, "", harness_session):
            continue
        result.append(grant)
    result.sort(key=lambda item: str(item.get("created_at", "")), reverse=True)
    return result


def select_grant(root: Path | str, *, window: dict, action: str, harness_session: str | None = None,
                 program_id: str | None = None, now: datetime | None = None) -> dict:
    for grant in list_grants(root, harness_session=harness_session, now=now):
        try:
            check_grant(grant, window=window, action=action, program_id=program_id, now=now)
        except GrantError:
            continue
        return grant
    raise GrantError("AUTHORIZATION_REQUIRED",
                     "No active task grant covers this window/action; authorize it once before acting")


def revoke_grant(root: Path | str, grant_id: str) -> bool:
    path = _path(root, grant_id)
    try:
        path.unlink()
        return True
    except FileNotFoundError:
        return False
