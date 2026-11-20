"""Create, list or revoke a local desktop task grant.

Run this once per task, before asking the agent to act. The grant binds exact
window identities, allowed actions and an expiry; tools and the executor reject
windows/actions outside it. The grant is a trusted local file, not a signature.
"""
from __future__ import annotations

import argparse
import ctypes
from datetime import datetime, timezone
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

from desktop_adapter.authorization import (ACTIONS, DEFAULT_ACTIONS, GrantError, create_grant,
                                          list_grants, revoke_grant)

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)


def _window(hwnd: int) -> dict:
    if not user32.IsWindow(hwnd) or not user32.IsWindowVisible(hwnd):
        raise GrantError("AUTHORIZATION_WINDOW_INVALID", f"Window {hwnd} is not visible")
    pid = ctypes.c_ulong()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    length = user32.GetWindowTextLengthW(hwnd)
    title = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, title, length + 1)
    klass = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, klass, 256)
    return {"hwnd": int(hwnd), "pid": int(pid.value), "class_name": klass.value, "title": title.value}


def _windows_session() -> int | None:
    value = ctypes.c_ulong()
    if kernel32.ProcessIdToSessionId(os.getpid(), ctypes.byref(value)):
        return int(value.value)
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hwnd", type=int, action="append", default=[])
    parser.add_argument("--actions", default=",".join(DEFAULT_ACTIONS))
    parser.add_argument("--ttl", type=int, default=600)
    parser.add_argument("--task", default="desktop task")
    parser.add_argument("--session", default=os.environ.get("DSH_SESSION_ID"))
    parser.add_argument("--program-id", action="append", default=[])
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--revoke")
    parser.add_argument("--yes", action="store_true")
    args = parser.parse_args()

    try:
        if args.list:
            grants = list_grants(ROOT, harness_session=args.session)
            print(json.dumps({"grants": grants, "count": len(grants)}, ensure_ascii=True, indent=2))
            return 0
        if args.revoke:
            removed = revoke_grant(ROOT, args.revoke)
            print(json.dumps({"revoked": removed, "grant_id": args.revoke}, ensure_ascii=True))
            return 0 if removed else 2
        if not args.hwnd:
            parser.error("--hwnd is required unless --list/--revoke is used")
        actions = [item.strip() for item in args.actions.split(",") if item.strip()]
        if not actions or any(item not in ACTIONS for item in actions):
            parser.error(f"--actions must be a subset of {', '.join(ACTIONS)}")
        windows = [_window(hwnd) for hwnd in args.hwnd]
        if not args.yes:
            summary = ", ".join(f"{w['hwnd']} {w['class_name']} {w['title']!r}" for w in windows)
            answer = input(f"Authorize {actions} on {summary} for {args.ttl}s? [y/N] ")
            if answer.strip().lower() not in ("y", "yes"):
                print(json.dumps({"ok": False, "reason": "AUTHORIZATION_CANCELLED"}, ensure_ascii=True))
                return 2
        grant = create_grant(ROOT, windows=windows, actions=actions, ttl_seconds=args.ttl,
                             task=args.task, harness_session=args.session or None,
                             windows_session=_windows_session(),
                             program_ids=args.program_id or None)
        print(json.dumps({"ok": True, "grant": grant}, ensure_ascii=True, indent=2))
        return 0
    except GrantError as error:
        print(json.dumps({"ok": False, "error_code": error.code, "message": error.message},
                         ensure_ascii=True, indent=2))
        return 2
    except (OSError, ValueError) as error:
        print(json.dumps({"ok": False, "error_code": "AUTHORIZATION_ERROR",
                          "message": str(error)[:200]}, ensure_ascii=True, indent=2))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
