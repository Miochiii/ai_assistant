"""Fixed desktop action executor.

The executor is the only component that turns a contract request into mouse
input. It refuses to run at Low integrity, refuses targets above Medium, and
binds every action to one observation. It never retries.
"""
from __future__ import annotations

import ctypes as C
from ctypes import wintypes as W
from dataclasses import asdict
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import time
from uuid import uuid4

from .action_contract import (EXECUTOR_VERSION, RECEIPT_SCHEMA_VERSION, ActionRefused, ActionRequest,
                              action_digest, load_observation, parse_action_request, target_screen_point)
from .authorization import GrantError, check_grant, load_grant
from .operation import OperationError, OperationJournal
from .single_click import FrameChanged, Win32Desktop, input_delivery_observed, validate_pixels
from .vision import Rect, capture as capture_observation

INTEGRITY_LOW = 0x1000
INTEGRITY_MEDIUM = 0x2000
INTEGRITY_HIGH = 0x3000
INTEGRITY_SYSTEM = 0x4000
INTEGRITY_NAMES = {INTEGRITY_LOW: "low", INTEGRITY_MEDIUM: "medium",
                   INTEGRITY_HIGH: "high", INTEGRITY_SYSTEM: "system"}
TOKEN_QUERY = 0x0008
TOKEN_INTEGRITY_LEVEL = 25
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

_kernel = C.WinDLL("kernel32", use_last_error=True)
_advapi = C.WinDLL("advapi32", use_last_error=True)
_user = C.WinDLL("user32", use_last_error=True)
_kernel.OpenProcess.argtypes = [W.DWORD, W.BOOL, W.DWORD]
_kernel.OpenProcess.restype = W.HANDLE
_kernel.OpenProcessToken.argtypes = [W.HANDLE, W.DWORD, C.POINTER(W.HANDLE)]
_kernel.OpenProcessToken.restype = W.BOOL
_kernel.CloseHandle.argtypes = [W.HANDLE]
_kernel.GetCurrentProcess.restype = W.HANDLE
_kernel.GetCurrentThreadId.restype = W.DWORD
_kernel.ProcessIdToSessionId.argtypes = [W.DWORD, C.POINTER(W.DWORD)]
_kernel.ProcessIdToSessionId.restype = W.BOOL
_advapi.GetTokenInformation.argtypes = [W.HANDLE, C.c_int, C.c_void_p, W.DWORD, C.POINTER(W.DWORD)]
_advapi.GetTokenInformation.restype = W.BOOL
_advapi.GetSidSubAuthorityCount.argtypes = [C.c_void_p]
_advapi.GetSidSubAuthorityCount.restype = C.POINTER(C.c_ubyte)
_advapi.GetSidSubAuthority.argtypes = [C.c_void_p, W.DWORD]
_advapi.GetSidSubAuthority.restype = C.POINTER(W.DWORD)
_user.GetProcessWindowStation.restype = W.HANDLE
_user.GetThreadDesktop.argtypes = [W.DWORD]
_user.GetThreadDesktop.restype = W.HANDLE
_user.GetUserObjectInformationW.argtypes = [W.HANDLE, C.c_int, C.c_void_p, W.DWORD, C.POINTER(W.DWORD)]
_user.GetUserObjectInformationW.restype = W.BOOL


def integrity_name(rid: int | None) -> str | None:
    if rid is None:
        return None
    return INTEGRITY_NAMES.get(rid, f"unknown(0x{rid:x})")


def token_integrity(pid: int) -> int | None:
    """Return the process integrity RID, or None when it cannot be read."""
    handle = _kernel.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return None
    token = W.HANDLE()
    try:
        if not _kernel.OpenProcessToken(handle, TOKEN_QUERY, C.byref(token)):
            return None
        needed = W.DWORD()
        if _advapi.GetTokenInformation(token, TOKEN_INTEGRITY_LEVEL, None, 0, C.byref(needed)) or not needed.value:
            return None
        buffer = C.create_string_buffer(needed.value)
        if not _advapi.GetTokenInformation(token, TOKEN_INTEGRITY_LEVEL, buffer, needed.value, C.byref(needed)):
            return None
        sid = C.cast(buffer, C.POINTER(C.c_void_p))[0]
        count = _advapi.GetSidSubAuthorityCount(sid).contents.value
        if count == 0:
            return None
        return int(_advapi.GetSidSubAuthority(sid, count - 1)[0])
    finally:
        if token:
            _kernel.CloseHandle(token)
        _kernel.CloseHandle(handle)


def process_session(pid: int) -> int | None:
    value = W.DWORD()
    if not _kernel.ProcessIdToSessionId(pid, C.byref(value)):
        return None
    return int(value.value)


def _object_name(handle) -> str | None:
    if not handle:
        return None
    text = C.create_unicode_buffer(512)
    needed = W.DWORD()
    if not _user.GetUserObjectInformationW(handle, 2, text, C.sizeof(text), C.byref(needed)):
        return None
    return text.value


def desktop_environment() -> dict:
    return {"session": process_session(os.getpid()),
            "window_station": _object_name(_user.GetProcessWindowStation()),
            "desktop": _object_name(_user.GetThreadDesktop(_kernel.GetCurrentThreadId()))}


def missing_dependencies() -> list[str]:
    missing = []
    for name in ("mss", "numpy", "win32gui", "win32process"):
        try:
            __import__(name)
        except Exception:
            missing.append(name)
    return missing


def grab_region(bounds: Rect) -> bytes:
    from mss import MSS
    with MSS() as sct:
        shot = sct.grab(asdict(bounds))
        if (shot.width, shot.height) != (bounds.width, bounds.height):
            raise ValueError("Captured frame dimensions changed")
        return shot.rgb


def display_bounds() -> Rect:
    from mss import MSS
    with MSS() as sct:
        monitor = sct.monitors[0]
    return Rect(int(monitor["left"]), int(monitor["top"]), int(monitor["width"]), int(monitor["height"]))


def changed_delta(before: bytes, after: bytes, width: int, height: int) -> dict:
    """Generic post-action change signal; never a task-success claim."""
    try:
        import numpy as np
        if len(before) != width * height * 3 or len(after) != len(before):
            return {"available": False, "reason": "RGB_SIZE_MISMATCH"}
        a = np.frombuffer(before, dtype=np.uint8).reshape(height, width, 3)
        b = np.frombuffer(after, dtype=np.uint8).reshape(height, width, 3)
        changed = np.any(a != b, axis=2)
        ratio = round(float(changed.mean()), 6)
        if not changed.any():
            return {"available": True, "changed_pixel_ratio": ratio,
                    "changed_bbox": None, "coordinate_space": "capture_pixels"}
        ys, xs = np.nonzero(changed)
        return {"available": True, "changed_pixel_ratio": ratio,
                "changed_bbox": [int(xs.min()), int(ys.min()),
                                 int(xs.max()) + 1, int(ys.max()) + 1],
                "coordinate_space": "capture_pixels"}
    except Exception:
        return {"available": False, "reason": "DELTA_UNAVAILABLE"}


def _focus_checked(desktop, binding, *, text=False) -> dict:
    focus = binding.get("focus")
    if (not isinstance(focus, dict) or focus.get("available") is not True
            or not focus.get("focus_hwnd")):
        raise ActionRefused("FOCUS_EVIDENCE_MISSING",
                            "The observation has no usable focus evidence; observe again")
    try:
        current = desktop.focus_info(binding["window"]["hwnd"])
    except Exception as error:
        raise ActionRefused("FOCUS_UNREADABLE", type(error).__name__) from None
    if current.get("available") is not True:
        raise ActionRefused("FOCUS_UNREADABLE", "Current focus evidence is unavailable")
    for key in ("active_hwnd", "focus_hwnd", "focus_root_hwnd", "capture_hwnd", "menu_owner_hwnd"):
        if key not in current or key not in focus:
            raise ActionRefused("FOCUS_EVIDENCE_MISSING", "Observe again with complete focus evidence")
        if current.get(key) != focus.get(key):
            raise ActionRefused("FOCUS_CHANGED", "Keyboard focus changed after observation")
    if current["capture_hwnd"] or current["menu_owner_hwnd"]:
        raise ActionRefused("FOCUS_UNCONFIRMED", "Menu or mouse capture is active")
    if focus.get("focus_root_hwnd") != binding["window"]["hwnd"]:
        raise ActionRefused("FOCUS_UNCONFIRMED", "Focus is outside the authorized window")
    if text:
        prior = focus.get("text_receiver")
        receiver = current.get("text_receiver")
        if not isinstance(prior, dict) or not isinstance(receiver, dict):
            raise ActionRefused("RECEIVER_UNSUPPORTED", "A fresh native edit receiver is required")
        for item in (prior, receiver):
            if (item.get("supported") is not True or item.get("password") is not False
                    or item.get("readonly") is not False):
                raise ActionRefused("RECEIVER_UNSUPPORTED", "Receiver is not an editable, unselected text field")
        prior_selection = prior.get("selection_collapsed")
        if prior_selection is False:
            raise ActionRefused("RECEIVER_UNSUPPORTED", "Receiver had a non-collapsed selection")
        if prior_selection is None and prior.get("selection_probe") != "unavailable":
            raise ActionRefused("RECEIVER_UNSUPPORTED", "Receiver selection evidence is missing")
        if receiver.get("selection_collapsed") is not True:
            raise ActionRefused("RECEIVER_UNSUPPORTED", "Receiver selection is not collapsed at input time")
        for key in ("hwnd", "class_name", "rect"):
            if prior.get(key) != receiver.get(key) or prior.get(key) is None:
                raise ActionRefused("RECEIVER_CHANGED", "Text receiver changed")
    return current


def _sync_input_trace(receipt: dict) -> None:
    trace = receipt.get("input_trace") or {}
    names = ("move_events_accepted", "button_events_accepted", "release_events_accepted",
             "wheel_events_accepted", "key_events_accepted", "key_release_accepted",
             "chord_events_accepted", "chord_cleanup_accepted", "text_events_accepted",
             "text_cleanup_accepted", "drag_down_accepted", "drag_moves_accepted", "drag_up_accepted")
    total = sum(max(0, int(trace.get(name, 0) or 0)) for name in names)
    receipt["input_events_sent"] = max(receipt.get("input_events_sent", 0), total)


def _release_state(receipt: dict) -> None:
    """Describe release evidence without claiming more than the receipt supports."""
    trace = receipt.get("input_trace")
    if not isinstance(trace, dict):
        return
    for kind, expected, cleanup_name in (("key", 2, "key_release_accepted"),
                                          ("chord", 4, "chord_cleanup_accepted"),
                                          ("text", None, "text_cleanup_accepted")):
        name = f"{kind}_events_accepted"
        if name not in trace:
            continue
        accepted = int(trace.get(name, 0))
        complete = (accepted == expected if expected is not None
                    else accepted % 2 == 0 and not trace.get("text_batch_incomplete", False))
        cleanup = int(trace.get(cleanup_name, 0))
        cleanup_expected = trace.get("text_cleanup_expected", 0) if kind == "text" else (1 if kind == "key" else 2)
        balanced = complete or (cleanup_expected > 0 and cleanup == cleanup_expected)
        status = ("not_attempted" if accepted == 0 and cleanup == 0
                  else "api_release_accepted" if balanced else "attempted_unconfirmed")
        receipt["release"] = {"status": status, "release_events_accepted": cleanup}
        receipt["pending_or_possible_down"] = bool(accepted and not balanced)
        if kind in ("key", "chord"):
            receipt[f"{kind}_release"] = dict(receipt["release"])
        return
    if "drag_down_accepted" in trace:
        down = trace.get("drag_down_accepted", 0)
        release_attempted = trace.get("drag_release_attempted") is True
        release_accepted = trace.get("drag_up_accepted", 0)
        if release_attempted:
            status = "api_release_accepted" if release_accepted == 1 else "attempted_unconfirmed"
        elif down == 0:
            status = "not_attempted"
        else:
            status = "unknown"
        receipt["release"] = {"status": status, "release_events_accepted": release_accepted}
        receipt["pending_or_possible_down"] = bool(
            down == 1 and release_accepted != 1) or status == "attempted_unconfirmed"
        return
    accepted = trace.get("button_events_accepted")
    release_attempted = trace.get("release_attempted") is True
    release_accepted = trace.get("release_events_accepted", 0)
    if release_attempted:
        status = "api_release_accepted" if release_accepted == 1 else "attempted_unconfirmed"
    elif accepted == 2:
        status = "not_needed"
    elif accepted in (0, None):
        status = "not_attempted"
    else:
        status = "unknown"
    receipt["release"] = {"status": status, "release_events_accepted": release_accepted}
    receipt["pending_or_possible_down"] = bool(
        accepted == 1 and release_accepted != 1) or status == "attempted_unconfirmed"


def _refusal(receipt: dict, code: str, message: str) -> dict:
    """Refuse before input, or report unknown after input; never erase facts."""
    _sync_input_trace(receipt)
    _release_state(receipt)
    attempted = int(receipt.get("gui_clicks_attempted", 0) or 0)
    sent = int(receipt.get("input_events_sent", 0) or 0)
    if attempted or sent:
        receipt.update(ok=False, outcome="unknown_after_input", error_code=code, message=message,
                       phase="after_input", task_success_verified=False)
        return receipt
    receipt.update(ok=False, outcome="refused", error_code=code, message=message,
                   gui_clicks_attempted=0, input_events_sent=0, phase="pre_action",
                   task_success_verified=False)
    return receipt


class DesktopExecutor:
    """One fixed implementation; one observation; at most one click."""

    def __init__(self, root: Path | str, *, desktop=None, integrity=None, session=None,
                 environment=None, capture_fn=None, grab_fn=None, display_fn=None,
                 sleep_fn=None, clock=None, settle_attempts: int = 5,
                 settle_delay: float = 0.03):
        self.root = Path(root).resolve()
        self.desktop = desktop if desktop is not None else Win32Desktop()
        self.integrity = integrity or token_integrity
        self.session = session or process_session
        self.environment = environment or desktop_environment
        self.capture = capture_fn or capture_observation
        self.grab = grab_fn or grab_region
        self.display = display_fn or display_bounds
        self.sleep = sleep_fn or time.sleep
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.settle_attempts = max(1, min(int(settle_attempts), 10))
        self.settle_delay = max(0.0, min(float(settle_delay), 0.25))
        self._cancel_file: Path | None = None
        self._cancel_flag = False

    def _cancel_requested(self) -> bool:
        return bool(self._cancel_file and self._cancel_file.exists())

    def _check_cancel(self, code: str, message: str) -> None:
        if self._cancel_requested():
            self._cancel_flag = True
            raise ActionRefused(code, message)

    def self_check(self) -> dict:
        pid = os.getpid()
        rid = self.integrity(pid)
        environment = self.environment()
        missing = missing_dependencies()
        ok_integrity = rid == INTEGRITY_MEDIUM
        ok_dependencies = not missing
        code = None
        if not ok_integrity:
            code = "EXECUTOR_INTEGRITY_NOT_MEDIUM"
        elif not ok_dependencies:
            code = "DEPENDENCY_MISSING"
        return {"ok": ok_integrity and ok_dependencies,
                "executor_version": EXECUTOR_VERSION,
                "pid": pid,
                "integrity": integrity_name(rid),
                "integrity_rid": rid,
                "session": environment.get("session"),
                "window_station": environment.get("window_station"),
                "desktop": environment.get("desktop"),
                "dependencies_missing": missing,
                "policy": {"executor": "medium", "max_target": "medium"},
                "error_code": code}

    def execute(self, payload: dict) -> dict:
        receipt = {"schema_version": RECEIPT_SCHEMA_VERSION, "executor_version": EXECUTOR_VERSION,
                   "ok": False, "outcome": "refused", "gui_clicks_attempted": 0,
                   "input_events_sent": 0, "task_success_verified": False,
                   "phase": "pre_action", "stage": "pre_action",
                   "release": {"status": "not_attempted"}, "pending_or_possible_down": False,
                   "temporary_rgb_removed": False}
        request: ActionRequest | None = None
        loaded = None
        consumed = False
        journal = None
        operation_started = False
        operation_finalized = False
        dpi = self.desktop.physical_pixels()
        dpi_entered = False
        try:
            dpi.__enter__()
            dpi_entered = True
            request = parse_action_request(payload, self.root)
            cancel_value = os.environ.get("DSH_EXECUTOR_CANCEL_FILE")
            self._cancel_file = Path(cancel_value) if cancel_value else None
            self._cancel_flag = False
            receipt["request_id"] = request.request_id
            receipt["observation_id"] = request.observation.observation_id
            receipt["target"] = {"label": request.target.label,
                                 "attachment_point": list(request.target.center)}
            check = self.self_check()
            receipt["executor_integrity"] = check
            if not check["ok"]:
                return _refusal(receipt, check["error_code"], "Executor must run at normal user (Medium) integrity")

            loaded = load_observation(request, self.root, now=self.clock())
            if loaded.window_context:
                context = loaded.window_context
                receipt["window_context"] = {
                    "context_id": context.get("context_id"),
                    "geometry_revision": context.get("geometry", {}).get("geometry_revision"),
                    "client_rect_screen_px": context.get("geometry", {}).get("client_rect_screen_px"),
                    "target_window_dpi": context.get("geometry", {}).get("target_window_dpi"),
                    "target_dpi_awareness": context.get("geometry", {}).get("target_dpi_awareness"),
                }
                if hasattr(self.desktop, "window_context"):
                    try:
                        current_context = self.desktop.window_context(loaded.binding["window"]["hwnd"])
                    except Exception as error:
                        raise ActionRefused("WINDOW_CONTEXT_UNREADABLE", type(error).__name__) from None
                    if (current_context.get("identity") != context.get("identity")
                            or current_context.get("geometry", {}).get("geometry_revision")
                            != context.get("geometry", {}).get("geometry_revision")):
                        raise ActionRefused("WINDOW_CONTEXT_CHANGED",
                                            "Window identity or geometry changed before input")
            binding = loaded.binding
            window = binding["window"]
            target_pid = int(window["pid"])
            target_rid = self.integrity(target_pid)
            own_session = self.session(os.getpid())
            target_session = self.session(target_pid)
            environment = self.environment()
            receipt["integrity"] = {
                "executor": {"pid": os.getpid(), "level": integrity_name(check["integrity_rid"]),
                             "session": own_session},
                "target": {"pid": target_pid, "level": integrity_name(target_rid),
                           "session": target_session},
            }
            if target_rid is None:
                raise ActionRefused("TARGET_INTEGRITY_UNREADABLE", "Cannot read the target integrity level")
            if target_rid > INTEGRITY_MEDIUM:
                raise ActionRefused("TARGET_INTEGRITY_TOO_HIGH",
                                    "Target is above the executor integrity; input would be blocked")
            if own_session is None or target_session is None:
                raise ActionRefused("TARGET_SESSION_UNREADABLE", "Cannot verify the target session")
            if own_session != target_session:
                raise ActionRefused("SESSION_MISMATCH", "Executor and target are in different sessions")
            if environment.get("window_station") != "WinSta0" or environment.get("desktop") != "Default":
                raise ActionRefused("DESKTOP_MISMATCH", "Executor is not on WinSta0\\Default")

            if not request.authorization_grant:
                raise ActionRefused("AUTHORIZATION_REQUIRED",
                                    "A task grant is required before input; authorize this window once")
            try:
                grant = load_grant(self.root, request.authorization_grant)
                if grant.get("windows_session") is not None and grant["windows_session"] != own_session:
                    raise GrantError("AUTHORIZATION_SESSION_MISMATCH",
                                     "Grant was issued for a different Windows session")
                if grant.get("harness_session") and grant["harness_session"] != os.environ.get("DSH_SESSION_ID"):
                    raise GrantError("AUTHORIZATION_SESSION_MISMATCH", "Harness session does not match the grant")
                check_grant(grant, window=window, action=request.action)
            except GrantError as error:
                raise ActionRefused(error.code, error.message) from None
            receipt["authorization"] = {"grant_id": grant["grant_id"], "task": grant.get("task", ""),
                                        "expires_at": grant["expires_at"]}

            point = target_screen_point(loaded, request.target)
            drag_end = None
            if request.drag is not None:
                drag_end = (loaded.capture_bounds.left + request.drag.end[0],
                            loaded.capture_bounds.top + request.drag.end[1])
                # A foreground check alone cannot detect external input during a held gesture.
                # Refuse before even moving until a trusted live monitor is installed.
                if not callable(getattr(self.desktop, "check_drag_interference", None)):
                    raise ActionRefused("DRAG_MONITOR_UNAVAILABLE", "Drag requires a trusted live interference monitor")
                self.desktop.check_drag_interference()
            receipt["screen_point"] = list(point)
            bounds = loaded.capture_bounds
            if not Rect(bounds.left, bounds.top, bounds.width, bounds.height).contains(
                    Rect(point[0], point[1], 1, 1)):
                raise ActionRefused("TARGET_OUT_OF_DESKTOP", "Target maps outside the observed region")

            try:
                current = self.desktop.identity(window["hwnd"])
            except Exception as error:
                raise ActionRefused("WINDOW_CHANGED", str(error)) from None
            if current != window:
                raise ActionRefused("WINDOW_CHANGED", "Window identity or geometry changed")
            if self.desktop.gui.GetForegroundWindow() != binding["foreground"]:
                raise ActionRefused("FOREGROUND_CHANGED", "Target window is not foreground")
            if self.desktop.input_tick() != binding["last_input_tick"]:
                raise ActionRefused("INPUT_CHANGED", "Input occurred after observation")
            try:
                self.desktop.check_window_point(binding, point)
            except ValueError as error:
                raise ActionRefused("TARGET_COVERED", str(error)) from None

            source = loaded.source_rgb.read_bytes()
            last_frame_error = None
            for attempt in range(self.settle_attempts):
                self._check_cancel("CANCELLED_BEFORE_INPUT", "Cancel requested before input")
                fresh = self.grab(bounds)
                try:
                    validate_pixels(source, fresh, (bounds.width, bounds.height),
                                    (point[0] - bounds.left, point[1] - bounds.top))
                    break
                except FrameChanged as error:
                    last_frame_error = error
                    if attempt + 1 < self.settle_attempts:
                        self.sleep(self.settle_delay)
                except ValueError as error:
                    last_frame_error = error
                    if attempt + 1 < self.settle_attempts:
                        self.sleep(self.settle_delay)
            else:
                if isinstance(last_frame_error, FrameChanged):
                    receipt["frame_diagnostics"] = last_frame_error.diagnostics
                raise ActionRefused("FRAME_CHANGED", str(last_frame_error or "Window pixels changed")) from None

            self._check_cancel("CANCELLED_BEFORE_INPUT", "Cancel requested before input")
            try:
                with (loaded.folder / "click.once").open("x"):
                    pass
            except FileExistsError:
                raise ActionRefused("OBSERVATION_ALREADY_CONSUMED", "This observation was already used") from None
            consumed = True
            receipt["stage"] = "prepared"

            journal = OperationJournal(self.root)
            try:
                journal.begin(operation_id=request.operation_id, request_id=request.request_id,
                              digest=action_digest(request))
            except OperationError as error:
                raise ActionRefused(error.code, error.message) from None
            operation_started = True
            receipt["operation_id"] = request.operation_id

            display = self.display()
            trace: dict = {}
            receipt["input_trace"] = trace

            def before_buttons() -> None:
                self._check_cancel("CANCELLED_BEFORE_BUTTONS", "Cancel requested before mouse buttons")
                self.desktop.check_window_point(binding, point)
                if self.desktop.gui.GetForegroundWindow() != binding["foreground"]:
                    raise ActionRefused("FOREGROUND_CHANGED", "Foreground changed before the click")
                receipt["stage"] = "button_batch"
                receipt["gui_clicks_attempted"] = 1

            def before_scroll() -> None:
                self._check_cancel("CANCELLED_BEFORE_SCROLL", "Cancel requested before wheel input")
                self.desktop.check_window_point(binding, point)
                if self.desktop.gui.GetForegroundWindow() != binding["foreground"]:
                    raise ActionRefused("FOREGROUND_CHANGED", "Foreground changed before the scroll")
                receipt["stage"] = "wheel_batch"

            def before_key() -> None:
                self._check_cancel("CANCELLED_BEFORE_KEY", "Cancel requested before key input")
                _focus_checked(self.desktop, binding)
                if self.desktop.gui.GetForegroundWindow() != binding["foreground"]:
                    raise ActionRefused("FOREGROUND_CHANGED", "Foreground changed before the key")
                receipt["stage"] = "key_batch"

            def before_text() -> None:
                self._check_cancel("CANCELLED_BEFORE_TEXT", "Cancel requested before text input")
                _focus_checked(self.desktop, binding, text=True)
                if self.desktop.gui.GetForegroundWindow() != binding["foreground"]:
                    raise ActionRefused("FOREGROUND_CHANGED", "Foreground changed before the text")
                receipt["stage"] = "text_batch"

            def before_chord() -> None:
                self._check_cancel("CANCELLED_BEFORE_CHORD", "Cancel requested before chord input")
                _focus_checked(self.desktop, binding)
                if self.desktop.gui.GetForegroundWindow() != binding["foreground"]:
                    raise ActionRefused("FOREGROUND_CHANGED", "Foreground changed before the chord")
                receipt["stage"] = "chord_batch"

            def before_drag() -> None:
                self._check_cancel("CANCELLED_BEFORE_DRAG", "Cancel requested before drag input")
                for point in drag_points:
                    self.desktop.check_window_point(binding, point)
                if self.desktop.gui.GetForegroundWindow() != binding["foreground"]:
                    raise ActionRefused("FOREGROUND_CHANGED", "Foreground changed before the drag")
                receipt["stage"] = "drag_button"

            def before_drag_move(index: int) -> None:
                self._check_cancel("CANCELLED_DURING_DRAG", "Cancel requested during drag input")
                if self.desktop.gui.GetForegroundWindow() != binding["foreground"]:
                    raise ActionRefused("FOREGROUND_CHANGED", "Foreground changed during the drag")
                self.desktop.check_drag_interference()
                if self.desktop.identity(window["hwnd"]) != window:
                    raise ActionRefused("WINDOW_CHANGED", "Window moved during drag")
                if loaded.window_context:
                    ctx = self.desktop.window_context(window["hwnd"])
                    if (ctx.get("identity") != loaded.window_context.get("identity")
                            or ctx.get("geometry", {}).get("geometry_revision") !=
                            loaded.window_context.get("geometry", {}).get("geometry_revision")):
                        raise ActionRefused("WINDOW_CONTEXT_CHANGED", "Geometry changed during drag")
                self.desktop.check_drag_path(binding, drag_points[index:])
                receipt["stage"] = f"drag_move_{index}"

            is_scroll = request.action == "scroll"
            is_key = request.action == "key"
            is_text = request.action == "text"
            is_chord = request.action == "chord"
            is_drag = request.action == "drag"
            drag_points = []
            if is_drag:
                for index in range(13):
                    drag_points.append((round(point[0] + (drag_end[0] - point[0]) * index / 12),
                                        round(point[1] + (drag_end[1] - point[1]) * index / 12)))
            try:
                journal.mark(request.operation_id, "input_started")
            except OperationError as error:
                raise ActionRefused(error.code, error.message) from None
            if is_scroll:
                receipt["scroll"] = {"axis": request.scroll.axis, "notches": request.scroll.notches}
                try:
                    sent = self.desktop.scroll(display, point, request.scroll.notches, trace=trace,
                                               before_scroll=before_scroll)
                except ActionRefused:
                    raise
                except RuntimeError as error:
                    receipt["input_events_sent"] = int(trace.get("wheel_events_accepted", 0) or 0)
                    raise ActionRefused("SCROLL_UNCONFIRMED", str(error)) from None
                except ValueError as error:
                    raise ActionRefused("TARGET_CHANGED", str(error)) from None
                receipt["input_events_sent"] = sent
                _release_state(receipt)
                receipt["phase"] = "after_input"
                receipt["stage"] = "input_sent"
            elif is_key:
                receipt["key"] = {"key": request.key.key}
                try:
                    _focus_checked(self.desktop, binding)
                    sent = self.desktop.press_key(request.key.key, trace=trace, before_key=before_key)
                except ActionRefused:
                    raise
                except RuntimeError as error:
                    receipt["input_events_sent"] = int(trace.get("key_events_accepted", 0) or 0)
                    raise ActionRefused("KEY_UNCONFIRMED", str(error)) from None
                except ValueError as error:
                    raise ActionRefused("TARGET_CHANGED", str(error)) from None
                receipt["input_events_sent"] = sent
                receipt["key_release"] = {
                    "status": "api_release_accepted"
                    if (trace.get("key_events_accepted") == 2 or trace.get("key_release_accepted") == 1)
                    else "unknown",
                    "key_events_accepted": trace.get("key_events_accepted", 0),
                    "key_release_accepted": trace.get("key_release_accepted", 0),
                }
                _release_state(receipt)
                receipt["phase"] = "after_input"
                receipt["stage"] = "input_sent"
            elif is_chord:
                receipt["chord"] = {"modifiers": list(request.chord.modifiers),
                                    "key": request.chord.key}
                try:
                    _focus_checked(self.desktop, binding)
                    sent = self.desktop.press_chord(request.chord.key, trace=trace,
                                                  before_chord=before_chord)
                except ActionRefused:
                    raise
                except RuntimeError as error:
                    receipt["input_events_sent"] = int(trace.get("chord_events_accepted", 0) or 0)
                    raise ActionRefused("CHORD_UNCONFIRMED", str(error)) from None
                except ValueError as error:
                    raise ActionRefused("TARGET_CHANGED", str(error)) from None
                receipt["input_events_sent"] = sent
                receipt["chord_release"] = {
                    "status": "api_release_accepted" if trace.get("chord_events_accepted") == 4
                    else "unknown",
                    "chord_events_accepted": trace.get("chord_events_accepted", 0),
                    "cleanup_accepted": trace.get("chord_cleanup_accepted", 0),
                }
                _release_state(receipt)
                receipt["phase"] = "after_input"
                receipt["stage"] = "input_sent"
            elif is_drag:
                receipt["drag"] = {"start": list(request.drag.start), "end": list(request.drag.end)}
                receipt["gui_drags_attempted"] = 1
                try:
                    sent = self.desktop.drag(display, point, drag_end,
                                             trace=trace, before_drag=before_drag,
                                             before_move=before_drag_move)
                except ActionRefused:
                    raise
                except RuntimeError as error:
                    _sync_input_trace(receipt)
                    raise ActionRefused("DRAG_UNCONFIRMED", str(error)) from None
                except ValueError as error:
                    raise ActionRefused("TARGET_CHANGED", str(error)) from None
                receipt["input_events_sent"] = sent
                _release_state(receipt)
                receipt["phase"] = "after_input"
                receipt["stage"] = "input_sent"
            elif is_text:
                receipt["text"] = {"scalars": len(request.text.text),
                                   "utf16_units": len(request.text.text.encode("utf-16-le")) // 2}
                try:
                    _focus_checked(self.desktop, binding, text=True)
                    sent = self.desktop.insert_text(request.text.text, trace=trace,
                                                    before_batch=before_text)
                except ActionRefused:
                    raise
                except RuntimeError as error:
                    receipt["input_events_sent"] = int(trace.get("text_events_accepted", 0) or 0)
                    raise ActionRefused("TEXT_UNCONFIRMED", str(error)) from None
                except ValueError as error:
                    raise ActionRefused("TARGET_CHANGED", str(error)) from None
                receipt["input_events_sent"] = sent
                receipt["text"]["events_accepted"] = sent
                receipt["text"]["text_stored"] = False
                _release_state(receipt)
                receipt["phase"] = "after_input"
                receipt["stage"] = "input_sent"
            else:
                try:
                    sent = self.desktop.click(display, point, trace=trace, before_buttons=before_buttons)
                except ActionRefused:
                    raise
                except RuntimeError as error:
                    raise ActionRefused("MOVE_UNCONFIRMED", str(error)) from None
                except ValueError as error:
                    raise ActionRefused("TARGET_CHANGED", str(error)) from None
                receipt["input_events_sent"] = sent
                _release_state(receipt)
                receipt["phase"] = "after_input"
                receipt["stage"] = "input_sent"
            if self._cancel_requested():
                receipt["cancelled_after_input"] = True

            self.sleep(0.35)
            cursor_after = tuple(self.desktop.gui.GetCursorPos())
            foreground_after = self.desktop.gui.GetForegroundWindow()
            tick_after = self.desktop.input_tick()
            delivered = False
            if is_scroll or is_key or is_text or is_chord or is_drag:
                receipt.update(cursor_after=list(cursor_after), foreground_after=foreground_after,
                               last_input_tick_after=tick_after, input_delivery_observed=False)
            else:
                delivered = input_delivery_observed(point, cursor_after, binding["last_input_tick"], tick_after)
                receipt.update(cursor_after=list(cursor_after), foreground_after=foreground_after,
                               last_input_tick_after=tick_after, input_delivery_observed=delivered)

            after_folder = self.root / "results" / "vision" / str(uuid4())
            after = self.capture(after_folder, monitor=loaded.manifest["monitor_index"], region=bounds,
                                 retain_rgb=True)
            (after_folder / "observation.json").write_text(
                json.dumps(after, ensure_ascii=True, indent=2), encoding="utf-8")
            after_rgb_path = after_folder / "source.rgb"
            if after_rgb_path.is_file():
                receipt["post_action_delta"] = changed_delta(source, after_rgb_path.read_bytes(),
                                                             bounds.width, bounds.height)
                after_rgb_path.unlink(missing_ok=True)
                receipt["after_rgb_removed"] = True
            receipt.update(after_observation=str(after_folder / "observation.json"),
                           after_image=after["image"])
            receipt["stage"] = "captured"
            try:
                receipt["window_after"] = self.desktop.identity(window["hwnd"])
            except Exception:
                receipt["window_after"] = None
            receipt["input_api_accepted"] = True
            receipt["task_success_verified"] = False
            if receipt.get("cancelled_after_input"):
                receipt.update(ok=False, outcome="cancelled_after_input", stage="cancelled_after_input",
                               error_code="CANCELLED_AFTER_INPUT",
                               message="Cancel requested after input; no retry, inspect the post-action evidence")
            elif is_scroll or is_key or is_text or is_chord or is_drag:
                receipt.update(ok=True, outcome="input_api_accepted", stage="done")
            elif delivered:
                receipt.update(ok=True, outcome="input_delivered", stage="done")
            else:
                receipt.update(ok=False, outcome="input_unconfirmed", stage="input_unconfirmed",
                               error_code="INPUT_DELIVERY_UNCONFIRMED",
                               message="Cursor/input readback did not confirm delivery; no retry")
            try:
                journal.mark(request.operation_id, "finalized", outcome=receipt.get("outcome"))
                operation_finalized = True
            except OperationError as error:
                receipt["operation_journal_error"] = error.code
            return receipt
        except ActionRefused as error:
            if self._cancel_flag:
                receipt["cancelled"] = True
            return _refusal(receipt, error.code, error.message)
        except Exception as error:
            return _refusal(receipt, "INTERNAL", type(error).__name__)
        finally:
            _sync_input_trace(receipt)
            if dpi_entered:
                try:
                    dpi.__exit__(None, None, None)
                except Exception:
                    pass
            if loaded is not None and consumed:
                loaded.source_rgb.unlink(missing_ok=True)
                receipt["temporary_rgb_removed"] = True
            if receipt.get("release", {}).get("status") == "not_attempted":
                _release_state(receipt)
            if journal is not None and operation_started and not operation_finalized:
                outcome = receipt.get("outcome")
                phase = "unknown" if (receipt.get("input_events_sent", 0)
                                      or receipt.get("gui_clicks_attempted", 0)) else "refused"
                try:
                    journal.mark(request.operation_id, phase, outcome=outcome)
                except OperationError as error:
                    receipt["operation_journal_error"] = error.code
            if loaded is not None and request is not None:
                path = loaded.folder / f"action-{request.request_id}.json"
                try:
                    with path.open("x", encoding="utf-8") as file:
                        json.dump(receipt, file, ensure_ascii=True, indent=2)
                except FileExistsError:
                    pass
