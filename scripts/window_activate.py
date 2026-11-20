"""Bring one visible window to the foreground without mouse or keyboard input.

This is a focus-only action: it checks the executor and target integrity levels,
refuses elevated targets, restores minimized windows and verifies the resulting
foreground window. It never clicks, types, or changes the target process.
"""
from __future__ import annotations

import argparse
import ctypes as C
from ctypes import wintypes as W
import json
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from desktop_adapter.executor import (INTEGRITY_MEDIUM, desktop_environment, integrity_name,
                                      process_session, token_integrity)

user = C.WinDLL("user32", use_last_error=True)
kernel = C.WinDLL("kernel32", use_last_error=True)
user.IsWindow.argtypes = [W.HANDLE]
user.IsWindow.restype = W.BOOL
user.IsWindowVisible.argtypes = [W.HANDLE]
user.IsWindowVisible.restype = W.BOOL
user.IsIconic.argtypes = [W.HANDLE]
user.IsIconic.restype = W.BOOL
user.GetForegroundWindow.restype = W.HANDLE
user.GetWindowThreadProcessId.argtypes = [W.HANDLE, C.POINTER(W.DWORD)]
user.GetWindowThreadProcessId.restype = W.DWORD
kernel.GetCurrentThreadId.restype = W.DWORD
user.AttachThreadInput.argtypes = [W.DWORD, W.DWORD, W.BOOL]
user.ShowWindow.argtypes = [W.HANDLE, C.c_int]
user.SetForegroundWindow.argtypes = [W.HANDLE]
user.SetForegroundWindow.restype = W.BOOL
user.BringWindowToTop.argtypes = [W.HANDLE]
user.BringWindowToTop.restype = W.BOOL


def refusal(code: str, message: str) -> dict:
    return {"ok": False, "error_code": code, "message": message,
            "input_events_sent": 0, "clicks": 0}


def activate(hwnd: int) -> dict:
    own = token_integrity(os.getpid())
    if own != INTEGRITY_MEDIUM:
        return refusal("EXECUTOR_INTEGRITY_NOT_MEDIUM",
                       "Window activation must run at normal user (Medium) integrity")
    if not user.IsWindow(hwnd):
        return refusal("TARGET_NOT_FOUND", "Window does not exist")
    if not user.IsWindowVisible(hwnd):
        return refusal("TARGET_NOT_VISIBLE", "Window is not visible")
    pid = W.DWORD()
    user.GetWindowThreadProcessId(hwnd, C.byref(pid))
    target = token_integrity(int(pid.value))
    if target is None:
        return refusal("TARGET_INTEGRITY_UNREADABLE", "Cannot read the target integrity level")
    if target > INTEGRITY_MEDIUM:
        return refusal("TARGET_INTEGRITY_TOO_HIGH", "Refusing to focus an elevated target")
    own_session = process_session(os.getpid())
    target_session = process_session(int(pid.value))
    if own_session is None or target_session is None:
        return refusal("TARGET_SESSION_UNREADABLE", "Cannot verify the target session")
    if own_session != target_session:
        return refusal("SESSION_MISMATCH", "Executor and target are in different sessions")
    environment = desktop_environment()
    if environment.get("window_station") != "WinSta0" or environment.get("desktop") != "Default":
        return refusal("DESKTOP_MISMATCH", "Executor is not on WinSta0\\Default")

    if user.IsIconic(hwnd):
        user.ShowWindow(hwnd, 9)
    if user.GetForegroundWindow() == hwnd:
        return {"ok": True, "outcome": "already_foreground", "hwnd": hwnd, "pid": int(pid.value),
                "foreground": hwnd, "integrity": integrity_name(own),
                "target_integrity": integrity_name(target), "session": own_session,
                "input_events_sent": 0, "clicks": 0}

    foreground = user.GetForegroundWindow()
    foreground_thread = user.GetWindowThreadProcessId(foreground, None) if foreground else 0
    current_thread = kernel.GetCurrentThreadId()
    attached = False
    try:
        if foreground_thread and foreground_thread != current_thread:
            attached = bool(user.AttachThreadInput(current_thread, foreground_thread, True))
        user.ShowWindow(hwnd, 9)
        user.SetForegroundWindow(hwnd)
        user.BringWindowToTop(hwnd)
    finally:
        if attached:
            user.AttachThreadInput(current_thread, foreground_thread, False)
    time.sleep(0.2)
    current = user.GetForegroundWindow()
    if current != hwnd:
        return {"ok": False, "error_code": "FOREGROUND_UNCONFIRMED",
                "message": "Foreground readback did not confirm activation; no retry",
                "hwnd": hwnd, "pid": int(pid.value), "foreground": current,
                "integrity": integrity_name(own), "target_integrity": integrity_name(target),
                "session": own_session, "input_events_sent": 0, "clicks": 0}
    return {"ok": True, "outcome": "foreground_confirmed", "hwnd": hwnd, "pid": int(pid.value),
            "foreground": current, "integrity": integrity_name(own),
            "target_integrity": integrity_name(target), "session": own_session,
            "input_events_sent": 0, "clicks": 0}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hwnd", type=int, required=True)
    args = parser.parse_args()
    if args.hwnd <= 0:
        result = refusal("INVALID_REQUEST", "hwnd must be positive")
    else:
        result = activate(args.hwnd)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 2


if __name__ == "__main__":
    raise SystemExit(main())
