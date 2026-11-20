"""Read-only foreground/owner binding for guidance captures. No focus changes."""
import ctypes
import time
from ctypes import wintypes as w

_DWI_EXTENDED_FRAME_BOUNDS = 9


def set_dpi_awareness():
    """Use physical pixels for Win32 rects, matching mss screenshots.

    Without this, GetWindowRect is virtualized (for example 1.5x logical
    coordinates) while mss still captures physical pixels. Cropping a model
    point then lands on the wrong desktop region, often the wallpaper.
    """
    try:
        user32 = ctypes.WinDLL('user32', use_last_error=True)
    except Exception:
        return
    try:
        if user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):
            return
    except Exception:
        pass
    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass


def visible_frame(hwnd):
    """DWM visible frame when available, otherwise GetWindowRect."""
    u = ctypes.WinDLL('user32', use_last_error=True)
    r = w.RECT()
    try:
        dwm = ctypes.WinDLL('dwmapi', use_last_error=True)
        if dwm.DwmGetWindowAttribute(hwnd, _DWI_EXTENDED_FRAME_BOUNDS,
                                     ctypes.byref(r), ctypes.sizeof(r)) == 0:
            return [r.left, r.top, r.right, r.bottom]
    except Exception:
        pass
    if not u.GetWindowRect(hwnd, ctypes.byref(r)):
        raise RuntimeError('GUIDANCE_WINDOW_RECT_UNAVAILABLE')
    return [r.left, r.top, r.right, r.bottom]


_SHELL_CLASSES = {
    'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'Progman', 'WorkerW',
}
_SYSTEM_TITLES = {
    'NVIDIA GeForce Overlay', 'Microsoft Text Input Application',
    'DesktopWindowXamlSource', 'Program Manager',
}
_SYSTEM_CLASSES = {'CEF-OSC-WIDGET', 'EdgeUiInputTopWndClass'}
_DWM_CLOAKED = 14


def _eligible_window(window):
    if not window or not window.get('rect'):
        return False
    if window.get('class_name') in _SHELL_CLASSES:
        return False
    if window.get('class_name') in _SYSTEM_CLASSES:
        return False
    if window.get('title') in _SYSTEM_TITLES:
        return False
    if window.get('cloaked'):
        return False
    if window.get('tool_window'):
        return False
    rect = window['rect']
    return rect[2] - rect[0] > 2 and rect[3] - rect[1] > 2


def _topmost_eligible(exclude_pids=()):
    for window in visible_windows(exclude_pids):
        if _eligible_window(window):
            return window
    return None


class ForegroundUnavailable(RuntimeError):
    def __init__(self, reason, transient=False):
        super().__init__('GUIDANCE_WINDOW_NOT_FOREGROUND: ' + reason)
        self.transient = transient


def foreground_region(hwnd=None, pid=None, exclude_pids=(), allow_background=False):
    try:
        return _foreground_region(hwnd, pid, exclude_pids)
    except ForegroundUnavailable:
        # Hiding a focused Orb can leave GetForegroundWindow pointing at the
        # now-hidden assistant. For the initial, unbound capture, use the
        # topmost eligible visible app instead of failing outright.
        if allow_background and hwnd is None:
            candidate = _topmost_eligible(exclude_pids)
            if candidate:
                return {'hwnd': candidate['hwnd'], 'pid': candidate['pid'],
                        'foreground': candidate['hwnd'], 'rect': candidate['rect'],
                        'background': True}
        raise


def _foreground_region(hwnd=None, pid=None, exclude_pids=()):
    set_dpi_awareness()
    u = ctypes.WinDLL('user32', use_last_error=True)
    u.GetForegroundWindow.restype = w.HWND
    u.GetAncestor.argtypes = [w.HWND, w.UINT]
    u.GetAncestor.restype = w.HWND
    u.GetWindow.argtypes = [w.HWND, w.UINT]
    u.GetWindow.restype = w.HWND
    u.GetWindowThreadProcessId.argtypes = [w.HWND, ctypes.POINTER(w.DWORD)]
    u.GetWindowRect.argtypes = [w.HWND, ctypes.POINTER(w.RECT)]
    for name in ('IsWindowVisible', 'IsIconic'):
        getattr(u, name).argtypes = [w.HWND]
    foreground = u.GetForegroundWindow()
    if not foreground:
        raise ForegroundUnavailable('foreground_transition', transient=True)
    # GA_ROOTOWNER may be an invisible framework owner (e.g. an owned dialog).
    # Bind the visible top-level foreground window, not that hidden owner.
    root = u.GetAncestor(foreground, 2) or foreground  # GA_ROOT
    foreground_pid = w.DWORD()
    u.GetWindowThreadProcessId(root, ctypes.byref(foreground_pid))
    if foreground_pid.value in exclude_pids:
        raise ForegroundUnavailable('assistant_still_foreground', transient=True)
    if not foreground_pid.value or not u.IsWindowVisible(root):
        raise ForegroundUnavailable('foreground_transition', transient=True)
    selected = hwnd or root
    actual_pid = w.DWORD()
    u.GetWindowThreadProcessId(selected, ctypes.byref(actual_pid))
    if not actual_pid.value or (pid and actual_pid.value != pid):
        raise ForegroundUnavailable('target_identity_changed')
    if not u.IsWindowVisible(selected) or u.IsIconic(selected):
        raise ForegroundUnavailable('target_hidden_or_minimized')
    # Permit the bound window or one of its owned dialogs. Do not silently
    # adopt another document/window merely because it belongs to the same PID.
    owner, seen = root, set()
    while owner and owner != selected and owner not in seen and len(seen) < 32:
        seen.add(owner)
        owner = u.GetWindow(owner, 4)  # GW_OWNER
    if owner != selected:
        raise ForegroundUnavailable('different_foreground_window')
    def rect(handle):
        return visible_frame(handle)
    base, active = rect(selected), rect(foreground)
    geometry = [{'hwnd': int(selected), 'rect': list(base)}]
    if foreground != selected:
        geometry.append({'hwnd': int(foreground), 'rect': list(active)})
    # Native popup/submenus can extend beyond both the owner and foreground
    # rect. They are evidence for this active process, never completion proof.
    for popup in visible_windows(exclude_pids):
        if (popup['pid'] == foreground_pid.value and popup.get('class_name') == '#32768'
                and all(g['hwnd'] != popup['hwnd'] for g in geometry)):
            geometry.append({'hwnd':popup['hwnd'],'rect':list(popup['rect'])})
    if len(geometry) > 16:
        raise ForegroundUnavailable('too_many_popup_windows')
    region = (min(g['rect'][0] for g in geometry), min(g['rect'][1] for g in geometry),
              max(g['rect'][2] for g in geometry), max(g['rect'][3] for g in geometry))
    return {'hwnd': int(selected), 'pid': actual_pid.value,
            'foreground': int(foreground), 'rect': list(region), 'window_geometry': geometry}


def wait_foreground_region(hwnd=None, pid=None, exclude_pids=(), timeout=1.2,
                           allow_background=False):
    """Allow hide/focus transitions to finish without activating any window."""
    deadline = time.monotonic() + timeout
    while True:
        try:
            return foreground_region(hwnd, pid, exclude_pids,
                                     allow_background=allow_background)
        except ForegroundUnavailable as error:
            if not error.transient or time.monotonic() >= deadline:
                raise
            time.sleep(0.05)


def visible_windows(exclude_pids=()):
    """Z-ordered geometry and local window metadata for visual binding.

    No title/OCR/UIA matching and no foreground requirement. Shell/overlay
    filtering is done by the caller so the policy stays testable in Node.
    """
    set_dpi_awareness()
    u = ctypes.WinDLL('user32', use_last_error=True)
    callback_type = ctypes.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
    u.EnumWindows.argtypes = [callback_type, w.LPARAM]
    u.GetWindowThreadProcessId.argtypes = [w.HWND, ctypes.POINTER(w.DWORD)]
    u.GetWindowRect.argtypes = [w.HWND, ctypes.POINTER(w.RECT)]
    u.GetWindow.argtypes = [w.HWND, w.UINT]
    u.GetWindow.restype = w.HWND
    u.GetClassNameW.argtypes = [w.HWND, w.LPWSTR, ctypes.c_int]
    u.GetWindowTextW.argtypes = [w.HWND, w.LPWSTR, ctypes.c_int]
    try:
        get_style = u.GetWindowLongPtrW
        get_style.argtypes = [w.HWND, ctypes.c_int]
        get_style.restype = ctypes.c_ssize_t
    except AttributeError:
        get_style = u.GetWindowLongW
        get_style.argtypes = [w.HWND, ctypes.c_int]
        get_style.restype = ctypes.c_long
    for name in ('IsWindowVisible', 'IsIconic'):
        getattr(u, name).argtypes = [w.HWND]
    windows = []
    def visit(hwnd, _):
        if not u.IsWindowVisible(hwnd) or u.IsIconic(hwnd): return True
        pid, rect = w.DWORD(), w.RECT()
        u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if not pid.value or pid.value in exclude_pids: return True
        try:
            frame = visible_frame(hwnd)
        except Exception:
            return True
        if frame[2] <= frame[0] or frame[3] <= frame[1]: return True
        cls = ctypes.create_unicode_buffer(256)
        title = ctypes.create_unicode_buffer(512)
        u.GetClassNameW(hwnd, cls, len(cls))
        u.GetWindowTextW(hwnd, title, len(title))
        cloaked = 0
        try:
            dwm = ctypes.WinDLL('dwmapi', use_last_error=True)
            value = ctypes.c_int(0)
            if dwm.DwmGetWindowAttribute(hwnd, _DWM_CLOAKED, ctypes.byref(value),
                                         ctypes.sizeof(value)) == 0:
                cloaked = value.value
        except Exception:
            pass
        if cloaked:
            return True
        style = int(get_style(hwnd, -20))
        windows.append({'hwnd':int(hwnd), 'pid':pid.value,
                        'rect':frame,
                        'class_name':cls.value, 'title':title.value,
                        'owner_hwnd':int(u.GetWindow(hwnd, 4) or 0),
                        'tool_window':bool(style & 0x00000080), 'cloaked':False})
        return len(windows) < 512
    u.EnumWindows(callback_type(visit), 0)
    return windows
