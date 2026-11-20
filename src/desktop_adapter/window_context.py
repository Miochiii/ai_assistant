"""Read-only window context shared by observation, planning and replay.

This is W1 of the window-context design: identity, outer/client geometry, DPI,
monitor intersection and a derived geometry revision. It never sends input,
authorizes a window, or turns a visual match into permission.
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes as W
from datetime import datetime, timezone
import hashlib
import json
import uuid

SCHEMA_VERSION = 1
GWL_EXSTYLE = -20
GW_OWNER = 4
GA_ROOT = 2
DWMWA_EXTENDED_FRAME_BOUNDS = 9
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
DPI_AWARENESS = {0: "unaware", 1: "system", 2: "per_monitor"}


class WindowContextError(RuntimeError):
    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code
        self.message = message or code


def _stamp():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def _rect(value):
    return {"left": int(value[0]), "top": int(value[1]),
            "width": int(value[2] - value[0]), "height": int(value[3] - value[1])}


def _intersection(a, b):
    return max(a["left"], b["left"]) < min(a["left"] + a["width"], b["left"] + b["width"]) and \
        max(a["top"], b["top"]) < min(a["top"] + a["height"], b["top"] + b["height"])


def _process_creation(pid: int):
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [W.DWORD, W.BOOL, W.DWORD]
    kernel32.OpenProcess.restype = W.HANDLE
    kernel32.GetProcessTimes.argtypes = [W.HANDLE, ctypes.POINTER(W.FILETIME),
                                         ctypes.POINTER(W.FILETIME), ctypes.POINTER(W.FILETIME),
                                         ctypes.POINTER(W.FILETIME)]
    kernel32.GetProcessTimes.restype = W.BOOL
    kernel32.CloseHandle.argtypes = [W.HANDLE]
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not handle:
        return None, "PROCESS_OPEN_FAILED"
    try:
        creation, exit_time, kernel, user = (W.FILETIME() for _ in range(4))
        if not kernel32.GetProcessTimes(handle, ctypes.byref(creation), ctypes.byref(exit_time),
                                        ctypes.byref(kernel), ctypes.byref(user)):
            return None, "PROCESS_TIMES_FAILED"
        value = (int(creation.dwHighDateTime) << 32) | int(creation.dwLowDateTime)
        seconds = value / 10_000_000 - 11644473600
        return datetime.fromtimestamp(seconds, timezone.utc).isoformat(timespec="microseconds"), None
    finally:
        kernel32.CloseHandle(handle)


def _session_id(pid: int):
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.ProcessIdToSessionId.argtypes = [W.DWORD, ctypes.POINTER(W.DWORD)]
    kernel32.ProcessIdToSessionId.restype = W.BOOL
    session = W.DWORD()
    if not kernel32.ProcessIdToSessionId(int(pid), ctypes.byref(session)):
        return None, "SESSION_QUERY_FAILED"
    return int(session.value), None


def _dpi_awareness(context):
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.GetAwarenessFromDpiAwarenessContext.argtypes = [W.HANDLE]
    user32.GetAwarenessFromDpiAwarenessContext.restype = ctypes.c_int
    if not context:
        return "unknown", "DPI_AWARENESS_UNAVAILABLE"
    value = user32.GetAwarenessFromDpiAwarenessContext(context)
    return DPI_AWARENESS.get(value, f"unknown:{value}"), None


def _monitor_info(win32api):
    monitors = []
    for hmonitor, _hdc, _monitor_bounds in win32api.EnumDisplayMonitors():
        try:
            info = win32api.GetMonitorInfo(hmonitor)
        except Exception:
            continue
        monitors.append({
            "device": info.get("Device"),
            "monitor_rect": _rect(info["Monitor"]),
            "work_rect": _rect(info["Work"]),
            "primary": bool(info.get("Flags", 0) & 1),
        })
    return monitors


def _visible_frame(user32, hwnd):
    rect = W.RECT()
    try:
        result = ctypes.WinDLL("dwmapi").DwmGetWindowAttribute(
            W.HWND(hwnd), DWMWA_EXTENDED_FRAME_BOUNDS, ctypes.byref(rect), ctypes.sizeof(rect))
    except Exception:
        return None, "DWM_UNAVAILABLE"
    if result != 0:
        return None, f"DWM_ERROR_{result}"
    return {"left": rect.left, "top": rect.top,
            "width": rect.right - rect.left, "height": rect.bottom - rect.top}, None


def geometry_revision(geometry: dict) -> str:
    value = json.dumps(geometry, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def region_from_context(context: dict, space: str, width: int, height: int) -> tuple[int, int, int, int]:
    """Place a same-size capture at the client or window origin; no fixed margin."""
    if space not in {"client", "window"}:
        raise WindowContextError("INVALID_REGION_SPACE")
    geometry = context.get("geometry") or {}
    if space == "client":
        rect = geometry.get("client_rect_screen_px")
    else:
        rect = geometry.get("visible_frame_rect_screen_px") or geometry.get("window_rect_screen_px")
    if not isinstance(rect, dict) or not all(type(rect.get(k)) is int for k in ("left", "top", "width", "height")):
        raise WindowContextError("WINDOW_GEOMETRY_UNAVAILABLE")
    if width <= 0 or height <= 0:
        raise WindowContextError("INVALID_REGION_SIZE")
    if width > rect["width"] or height > rect["height"]:
        raise WindowContextError("WINDOW_TOO_SMALL")
    return rect["left"], rect["top"], width, height


def _read_window_context(hwnd: int, *, gui=None, win32api=None, win32process=None,
                         user32=None) -> dict:
    """Read a snapshot; unsupported/unknown fields are explicit, never zero-filled."""
    if type(hwnd) is not int or hwnd <= 0:
        raise WindowContextError("INVALID_HWND")
    errors = []
    if gui is None or win32api is None or win32process is None:
        import win32api as _api
        import win32gui as _gui
        import win32process as _process
        gui = gui or _gui
        win32api = win32api or _api
        win32process = win32process or _process
    try:
        if not gui.IsWindow(hwnd):
            raise WindowContextError("WINDOW_UNAVAILABLE")
        pid = int(win32process.GetWindowThreadProcessId(hwnd)[1])
        class_name = gui.GetClassName(hwnd)
        title = gui.GetWindowText(hwnd)
        window_rect = _rect(gui.GetWindowRect(hwnd))
        owner = gui.GetWindow(hwnd, GW_OWNER)
        root = gui.GetAncestor(hwnd, GA_ROOT)
        foreground = gui.GetForegroundWindow()
        visible = bool(gui.IsWindowVisible(hwnd))
        minimized = bool(gui.IsIconic(hwnd))
        local_left, local_top, local_right, local_bottom = gui.GetClientRect(hwnd)
        client_left, client_top = gui.ClientToScreen(hwnd, (local_left, local_top))
        client_right, client_bottom = gui.ClientToScreen(hwnd, (local_right, local_bottom))
        client_rect = {"left": client_left, "top": client_top,
                       "width": client_right - client_left, "height": client_bottom - client_top}
    except WindowContextError:
        raise
    except Exception as error:
        raise WindowContextError("WINDOW_CONTEXT_UNAVAILABLE", type(error).__name__) from None

    creation, creation_error = _process_creation(pid)
    if creation_error:
        errors.append(creation_error)
    session, session_error = _session_id(pid)
    if session_error:
        errors.append(session_error)

    user32 = user32 or ctypes.WinDLL("user32", use_last_error=True)
    user32.GetDpiForWindow.argtypes = [W.HWND]
    user32.GetDpiForWindow.restype = W.UINT
    user32.GetWindowDpiAwarenessContext.argtypes = [W.HWND]
    user32.GetWindowDpiAwarenessContext.restype = W.HANDLE
    user32.GetThreadDpiAwarenessContext.restype = W.HANDLE
    try:
        target_dpi = int(user32.GetDpiForWindow(W.HWND(hwnd))) or None
        if target_dpi is None:
            errors.append("DPI_QUERY_UNAVAILABLE")
    except Exception:
        target_dpi = None
        errors.append("DPI_QUERY_UNAVAILABLE")
    target_awareness, awareness_error = _dpi_awareness(
        user32.GetWindowDpiAwarenessContext(W.HWND(hwnd)))
    if awareness_error:
        errors.append(awareness_error)
    thread_awareness, thread_error = _dpi_awareness(user32.GetThreadDpiAwarenessContext())
    if thread_error:
        errors.append(thread_error)
    visible_frame, frame_error = _visible_frame(user32, hwnd)
    if frame_error:
        errors.append(frame_error)

    try:
        monitor_list = _monitor_info(win32api)
    except Exception:
        monitor_list = []
        errors.append("MONITOR_ENUMERATION_FAILED")
    intersected = [item for item in monitor_list if _intersection(item["monitor_rect"], window_rect)]
    if not intersected:
        errors.append("MONITOR_INTERSECTION_UNKNOWN")

    geometry = {
        "window_rect_screen_px": window_rect,
        "visible_frame_rect_screen_px": visible_frame,
        "client_rect_screen_px": client_rect,
        "monitors_intersected": intersected,
        "target_window_dpi": target_dpi,
        "target_dpi_awareness": target_awareness,
        "capture_thread_dpi_awareness": thread_awareness,
    }
    return {
        "schema_version": SCHEMA_VERSION,
        "context_id": str(uuid.uuid4()),
        "observed_at": _stamp(),
        "identity": {
            "hwnd": hwnd, "pid": pid, "process_started_at": creation,
            "class_name": class_name, "windows_session": session,
            "binding_generation": None, "application_identity": None,
            "identity_source": "win32",
        },
        "presentation": {
            "title": title, "foreground_hwnd": foreground, "visible": visible,
            "minimized": minimized, "owner_hwnd": owner or None, "root_hwnd": root or None,
        },
        "geometry": {**geometry, "geometry_revision": geometry_revision(geometry)},
        "visibility": {"status": "unknown", "checked_point": None, "checked_at": None,
                       "evidence": "W1 read-only context; no occlusion proof"},
        "capability": {"read_only_available": True, "action_context_available": False,
                       "reason_codes": ["W1_READ_ONLY"]},
        "errors": errors,
    }


def read_window_context(hwnd: int, *, gui=None, win32api=None, win32process=None) -> dict:
    """Read a physical-pixel snapshot in a self-contained per-monitor DPI context."""
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.SetThreadDpiAwarenessContext.argtypes = [ctypes.c_void_p]
    user32.SetThreadDpiAwarenessContext.restype = ctypes.c_void_p
    previous = user32.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))
    if not previous:
        raise WindowContextError("DPI_CONTEXT_UNAVAILABLE")
    try:
        return _read_window_context(hwnd, gui=gui, win32api=win32api,
                                    win32process=win32process, user32=user32)
    finally:
        user32.SetThreadDpiAwarenessContext(previous)

