"""Generic one-click probe; no application selectors, UIA, or implicit retries.

Uses existing MSS + Win32, following Orb's physical-pixel/DPI contract.
Implementation is local; no upstream source copied.
"""
from __future__ import annotations

import ctypes as C
from ctypes import wintypes as W
from contextlib import contextmanager
from datetime import datetime, timezone
import time

from .vision import Rect, screen_point

# Standard Windows text-control capabilities, never application-name special cases.
TEXT_RECEIVER_CLASSES = frozenset({
    "edit", "richedit", "richedit20a", "richedit20w",
    "richedit50w", "richedit60w", "richeditd2dpt",
})


def text_receiver_kind(class_name: str) -> str | None:
    """Return the supported native text-control family, or None."""
    name = str(class_name or "").lower()
    if name == "edit":
        return "win32.edit"
    if name in TEXT_RECEIVER_CLASSES:
        return "win32.richedit"
    return None


def validate_age(captured_at: str, now: datetime | None = None) -> None:
    age = ((now or datetime.now(timezone.utc)) - datetime.fromisoformat(captured_at)).total_seconds()
    if not 0 <= age <= 180:
        raise ValueError('Observation expired; take a new screenshot')


def validate_pixels(before: bytes, current: bytes, size: tuple[int, int], point: tuple[int, int]) -> None:
    import numpy as np
    width, height = size
    if len(before) != width * height * 3 or len(current) != len(before):
        raise ValueError('RGB size mismatch')
    x, y = point
    if not 0 <= x < width or not 0 <= y < height:
        raise ValueError('Target outside image')
    a = np.frombuffer(before, dtype=np.uint8).reshape(height, width, 3)
    b = np.frombuffer(current, dtype=np.uint8).reshape(height, width, 3)
    # Caret blinking can change a few pixels away from the target. The target
    # patch itself must be byte-identical, not merely perceptually similar.
    changed = np.any(a != b, axis=2)
    changed_pixels = int(changed.sum())
    target = changed[max(0, y-16):min(height, y+17), max(0, x-32):min(width, x+33)]
    target_changed = bool(target.any())
    diagnostics = {
        "width": width, "height": height,
        "changed_pixels": changed_pixels, "total_pixels": width * height,
        "changed_ratio": round(changed_pixels / (width * height), 6),
        "target_changed": target_changed,
        "changed_bbox": None, "target_box": {
            "left": max(0, x-32), "top": max(0, y-16),
            "width": min(width, x+33) - max(0, x-32),
            "height": min(height, y+17) - max(0, y-16),
        },
    }
    if changed_pixels:
        ys, xs = np.nonzero(changed)
        diagnostics["changed_bbox"] = {"left": int(xs.min()), "top": int(ys.min()),
                                       "width": int(xs.max() - xs.min() + 1),
                                       "height": int(ys.max() - ys.min() + 1)}
    if float(changed.mean()) > 0.003:
        raise FrameChanged('Window pixels changed; locate again', diagnostics)
    if target_changed:
        raise FrameChanged('Target pixels changed; locate again', diagnostics)


class FrameChanged(ValueError):
    """A frame refusal with local diagnostics; no input was sent by this check."""
    def __init__(self, message: str, diagnostics: dict):
        super().__init__(message)
        self.diagnostics = diagnostics


def absolute_point(display: Rect, point: tuple[int, int]) -> tuple[int, int]:
    x, y = point
    if not display.contains(Rect(x, y, 1, 1)):
        raise ValueError('Target outside virtual desktop')
    return min(65535, ((x-display.left)*65536+32768)//display.width), min(65535, ((y-display.top)*65536+32768)//display.height)


def input_delivery_observed(point, cursor_after, tick_before, tick_after):
    # API acceptance is insufficient: no automatic retry if readback disagrees.
    return tuple(point) == tuple(cursor_after) and tick_after != tick_before


class MouseInput(C.Structure):
    _fields_ = [('dx', W.LONG), ('dy', W.LONG), ('mouseData', W.DWORD),
                ('dwFlags', W.DWORD), ('time', W.DWORD), ('dwExtraInfo', C.c_size_t)]


class KeyInput(C.Structure):
    _fields_ = [('wVk', W.WORD), ('wScan', W.WORD), ('dwFlags', W.DWORD),
                ('time', W.DWORD), ('dwExtraInfo', C.c_size_t)]


class InputUnion(C.Union):
    _fields_ = [('mi', MouseInput), ('ki', KeyInput)]


VK_NAMES = {'Left': 0x25, 'Up': 0x26, 'Right': 0x27, 'Down': 0x28,
            'Home': 0x24, 'End': 0x23}


class Input(C.Structure):
    _anonymous_ = ('data',)
    _fields_ = [('type', W.DWORD), ('data', InputUnion)]


class LastInput(C.Structure):
    _fields_ = [('cbSize', W.UINT), ('dwTime', W.DWORD)]


class GuiThreadInfo(C.Structure):
    _fields_ = [('cbSize', W.DWORD), ('flags', W.DWORD),
                ('hwndActive', W.HWND), ('hwndFocus', W.HWND),
                ('hwndCapture', W.HWND), ('hwndMenuOwner', W.HWND),
                ('hwndMoveSize', W.HWND), ('hwndCaret', W.HWND),
                ('rcCaret', W.RECT)]


class Win32Desktop:
    def __init__(self):
        import win32api
        import win32gui
        import win32process
        self.gui, self.process, self.api = win32gui, win32process, win32api
        self.user = C.WinDLL('user32', use_last_error=True)
        self.user.SetThreadDpiAwarenessContext.argtypes = [C.c_void_p]
        self.user.SetThreadDpiAwarenessContext.restype = C.c_void_p
        self.user.SendInput.argtypes = [W.UINT, C.POINTER(Input), C.c_int]
        self.user.SendInput.restype = W.UINT
        self.user.GetLastInputInfo.argtypes = [C.POINTER(LastInput)]
        self.user.GetLastInputInfo.restype = W.BOOL
        self.user.GetGUIThreadInfo.argtypes = [W.DWORD, C.POINTER(GuiThreadInfo)]
        self.user.GetGUIThreadInfo.restype = W.BOOL
        if C.sizeof(C.c_void_p) != 8 or C.sizeof(Input) != 40:
            raise RuntimeError('Expected Windows x64 INPUT layout')

    @contextmanager
    def physical_pixels(self):
        previous = self.user.SetThreadDpiAwarenessContext(C.c_void_p(-4))
        if not previous:
            raise RuntimeError('Cannot establish per-monitor DPI awareness')
        try:
            yield
        finally:
            self.user.SetThreadDpiAwarenessContext(previous)

    def identity(self, hwnd: int) -> dict:
        if not self.gui.IsWindow(hwnd) or not self.gui.IsWindowVisible(hwnd) or self.gui.IsIconic(hwnd):
            raise ValueError('Window unavailable')
        return {'hwnd': hwnd, 'pid': self.process.GetWindowThreadProcessId(hwnd)[1],
                'class_name': self.gui.GetClassName(hwnd), 'title': self.gui.GetWindowText(hwnd),
                'rect': list(self.gui.GetWindowRect(hwnd))}

    def list_windows(self) -> list[dict]:
        items = []
        def visit(hwnd, _):
            if self.gui.IsWindowVisible(hwnd) and self.gui.GetWindowText(hwnd) and not self.gui.IsIconic(hwnd):
                items.append(self.identity(hwnd))
        self.gui.EnumWindows(visit, None)
        return items

    def window_context(self, hwnd: int) -> dict:
        from .window_context import read_window_context
        return read_window_context(hwnd, gui=self.gui, win32api=self.api, win32process=self.process)

    def focus_info(self, hwnd: int) -> dict:
        """Host-captured focus/capture metadata; not a proof of a text receiver."""
        thread_id, _ = self.process.GetWindowThreadProcessId(hwnd)
        info = GuiThreadInfo()
        info.cbSize = C.sizeof(GuiThreadInfo)
        if not thread_id or not self.user.GetGUIThreadInfo(thread_id, C.byref(info)):
            raise RuntimeError('Cannot read the target GUI thread focus')
        focus_root = self.gui.GetAncestor(info.hwndFocus, 2) if info.hwndFocus else 0
        receiver = {"supported": False}
        if info.hwndFocus:
            try:
                name = self.gui.GetClassName(info.hwndFocus)
                kind = text_receiver_kind(name)
                # A standard control capability, never an application-name special case.
                if kind:
                    style = self.gui.GetWindowLong(info.hwndFocus, -16)
                    receiver = {"supported": True, "kind": kind, "hwnd": int(info.hwndFocus),
                                "class_name": name, "rect": list(self.gui.GetWindowRect(info.hwndFocus)),
                                "password": bool(style & 0x20), "readonly": bool(style & 0x800),
                                "selection_collapsed": None, "selection_probe": "unavailable"}
                    try:
                        selection_start, selection_end = W.DWORD(), W.DWORD()
                        result = C.c_size_t()
                        send = self.user.SendMessageTimeoutW
                        send.argtypes = [W.HWND, W.UINT, C.c_size_t, C.c_ssize_t,
                                         W.UINT, W.UINT, C.POINTER(C.c_size_t)]
                        send.restype = C.c_ssize_t
                        ok = send(info.hwndFocus, 0x00B0, C.addressof(selection_start),
                                  C.addressof(selection_end), 0x0002, 100, C.byref(result))
                        if ok:
                            receiver["selection_collapsed"] = (
                                selection_start.value == selection_end.value)
                            receiver["selection_probe"] = "observed"
                    except Exception:
                        # Low-integrity observers may be denied cross-integrity EM_GETSEL.
                        # Keep the class/style capability; the Medium executor must
                        # verify a collapsed selection immediately before input.
                        pass
            except Exception:
                receiver = {"supported": False}
        return {
            'available': True,
            'thread_id': int(thread_id),
            'active_hwnd': int(info.hwndActive or 0),
            'focus_hwnd': int(info.hwndFocus or 0),
            'focus_root_hwnd': int(focus_root or 0),
            'capture_hwnd': int(info.hwndCapture or 0),
            'menu_owner_hwnd': int(info.hwndMenuOwner or 0),
            'caret_hwnd': int(info.hwndCaret or 0),
            'text_receiver': receiver,
            'caret_rect': {'left': int(info.rcCaret.left), 'top': int(info.rcCaret.top),
                           'right': int(info.rcCaret.right), 'bottom': int(info.rcCaret.bottom)},
        }

    def list_windows_with_context(self) -> list[dict]:
        from .window_context import WindowContextError
        items = []
        for window in self.list_windows():
            try:
                context = self.window_context(window["hwnd"])
            except WindowContextError as error:
                context = {"schema_version": 1, "available": False, "error_code": error.code}
            items.append({**window, "window_context": context})
        return items

    def input_tick(self) -> int:
        info = LastInput(C.sizeof(LastInput), 0)
        if not self.user.GetLastInputInfo(C.byref(info)):
            raise RuntimeError('Cannot check input interference')
        return info.dwTime

    def check_target(self, binding: dict, point: tuple[int, int]) -> None:
        self.check_window_point(binding, point)
        if self.gui.GetForegroundWindow() != binding['foreground'] or self.input_tick() != binding['last_input_tick']:
            raise ValueError('User input or foreground changed; observe again')

    def check_window_point(self, binding: dict, point: tuple[int, int]) -> None:
        if self.identity(binding['window']['hwnd']) != binding['window']:
            raise ValueError('Window identity or geometry changed')
        hit = self.gui.WindowFromPoint(point)
        if self.gui.GetAncestor(hit, 2) != binding['window']['hwnd']:
            raise ValueError('Target is covered by another window')
        if any(self.user.GetAsyncKeyState(vk) & 0x8000 for vk in (1, 2, 4, 16, 17, 18)):
            raise ValueError('Mouse button or modifier is held')

    def check_drag_path(self, binding, points) -> None:
        """During a drag our own left button is down; do not use click's neutral check."""
        if self.identity(binding['window']['hwnd']) != binding['window']:
            raise ValueError('Window changed during drag')
        focus = self.focus_info(binding['window']['hwnd'])
        capture = focus.get('capture_hwnd')
        if focus.get('menu_owner_hwnd') or (capture and self.gui.GetAncestor(capture, 2) != binding['window']['hwnd']):
            raise ValueError('Unexpected mouse capture or menu during drag')
        for point in points:
            hit = self.gui.WindowFromPoint(point)
            if self.gui.GetAncestor(hit, 2) != binding['window']['hwnd']:
                raise ValueError('Drag path is covered')

    def move_verified(self, display: Rect, point: tuple[int, int], trace: dict) -> None:
        x, y = absolute_point(display, point)
        trace.update(point=list(point), normalized_point=[x, y], cursor_before=list(self.gui.GetCursorPos()))
        move = (Input * 1)()
        move[0].mi = MouseInput(x, y, 0, 0xC001, 0, 0)
        C.set_last_error(0)
        trace['move_events_accepted'] = self.user.SendInput(1, move, C.sizeof(Input))
        trace['move_winerror'] = C.get_last_error()
        deadline = time.monotonic() + 0.2
        while time.monotonic() < deadline:
            if tuple(self.gui.GetCursorPos()) == tuple(point):
                break
            time.sleep(0.01)
        trace['cursor_after_move'] = list(self.gui.GetCursorPos())
        if trace['move_events_accepted'] != 1 or tuple(trace['cursor_after_move']) != tuple(point):
            raise RuntimeError('POINTER_MOVE_UNCONFIRMED; no mouse buttons sent')

    def click(self, display: Rect, point: tuple[int, int], *, trace=None, before_buttons=None) -> int:
        trace = {} if trace is None else trace
        trace['button_events_accepted'] = 0
        trace['release_attempted'] = False
        trace['release_events_accepted'] = 0
        self.move_verified(display, point, trace)
        if before_buttons is not None:
            before_buttons()
        if tuple(self.gui.GetCursorPos()) != tuple(point):
            raise RuntimeError('Pointer changed before click; no mouse buttons sent')
        inputs = (Input * 2)()
        for index, flags in enumerate((0x0002, 0x0004)):
            inputs[index].type = 0
            inputs[index].mi = MouseInput(0, 0, 0, flags, 0, 0)
        sent = self.user.SendInput(2, inputs, C.sizeof(Input))
        trace['button_events_accepted'] = sent
        if sent == 1:
            # Release only: never retry the click if a partial batch left it down.
            release = Input(); release.mi = MouseInput(0, 0, 0, 4, 0, 0)
            trace['release_attempted'] = True
            trace['release_events_accepted'] = self.user.SendInput(1, C.byref(release), C.sizeof(Input))
        if sent != 2:
            raise RuntimeError(f'Button batch incomplete ({sent}/2); outcome unknown, no retry')
        return 1 + sent

    def scroll(self, display: Rect, point: tuple[int, int], notches: int, *,
               trace=None, before_scroll=None) -> int:
        """Send one bounded vertical wheel gesture after moving to the anchor."""
        if type(notches) is not int or notches == 0 or not -3 <= notches <= 3:
            raise ValueError('Scroll notches must be -3..3 and non-zero')
        trace = {} if trace is None else trace
        trace['wheel_events_accepted'] = 0
        trace['scroll_notches'] = notches
        self.move_verified(display, point, trace)
        if before_scroll is not None:
            before_scroll()
        if tuple(self.gui.GetCursorPos()) != tuple(point):
            raise RuntimeError('Pointer changed before scroll; no wheel event sent')
        wheel = Input()
        wheel.mi = MouseInput(0, 0, (notches * 120) & 0xFFFFFFFF, 0x0800, 0, 0)
        sent = self.user.SendInput(1, C.byref(wheel), C.sizeof(Input))
        trace['wheel_events_accepted'] = sent
        if sent != 1:
            raise RuntimeError('Wheel batch incomplete; outcome unknown, no retry')
        return 1 + sent

    def drag(self, display: Rect, start: tuple[int, int], end: tuple[int, int], *,
             trace=None, before_drag=None, before_move=None, steps: int = 12) -> int:
        """Send one bounded left-button drag within one authorized window."""
        if abs(end[0] - start[0]) + abs(end[1] - start[1]) < 8:
            raise ValueError('Drag start and end are too close')
        if not 8 <= steps <= 24:
            raise ValueError('Drag steps are outside the fixed bound')
        trace = {} if trace is None else trace
        trace.update(drag_start=list(start), drag_end=list(end), drag_steps=steps,
                     drag_moves_accepted=0, drag_down_accepted=0,
                     drag_up_accepted=0, drag_release_attempted=False)
        self.move_verified(display, start, trace)
        if before_drag is not None:
            before_drag()
        if tuple(self.gui.GetCursorPos()) != tuple(start):
            raise RuntimeError('Pointer changed before drag; no mouse buttons sent')
        down = Input()
        down.mi = MouseInput(0, 0, 0, 0x0002, 0, 0)
        sent = self.user.SendInput(1, C.byref(down), C.sizeof(Input))
        trace['drag_down_accepted'] = sent
        if sent != 1:
            raise RuntimeError('Drag button-down incomplete; outcome unknown, no retry')
        released = False
        try:
            for index in range(1, steps + 1):
                if before_move is not None:
                    before_move(index)
                x = round(start[0] + (end[0] - start[0]) * index / steps)
                y = round(start[1] + (end[1] - start[1]) * index / steps)
                nx, ny = absolute_point(display, (x, y))
                move = Input()
                move.mi = MouseInput(nx, ny, 0, 0xC001, 0, 0)
                moved = self.user.SendInput(1, C.byref(move), C.sizeof(Input))
                trace['drag_moves_accepted'] += moved
                if moved != 1:
                    raise RuntimeError('Drag move incomplete; outcome unknown, no retry')
                time.sleep(0.015)
            up = Input(); up.mi = MouseInput(0, 0, 0, 0x0004, 0, 0)
            trace['drag_release_attempted'] = True
            trace['drag_up_accepted'] = self.user.SendInput(1, C.byref(up), C.sizeof(Input))
            released = trace['drag_up_accepted'] == 1
            if trace['drag_up_accepted'] != 1:
                raise RuntimeError('Drag button-up incomplete; outcome unknown, no retry')
            return 1 + 1 + trace['drag_moves_accepted'] + 1
        finally:
            if not released:
                try:
                    up = Input(); up.mi = MouseInput(0, 0, 0, 0x0004, 0, 0)
                    trace['drag_release_attempted'] = True
                    trace['drag_up_accepted'] = self.user.SendInput(1, C.byref(up), C.sizeof(Input))
                except Exception:
                    trace['drag_up_accepted'] = 0

    def press_key(self, key: str, *, trace=None, before_key=None) -> int:
        """Send one complete navigation key down/up; no repeat or hold."""
        vk = VK_NAMES.get(key)
        if vk is None:
            raise ValueError('Unsupported navigation key')
        trace = {} if trace is None else trace
        trace['key_events_accepted'] = 0
        trace['key_release_accepted'] = 0
        trace['key'] = key
        if before_key is not None:
            before_key()
        if any(self.user.GetAsyncKeyState(code) & 0x8000 for code in (1, 2, 4, 16, 17, 18, vk)):
            raise RuntimeError('Mouse button, modifier or target key is held')
        inputs = (Input * 2)()
        for index, flags in enumerate((0, 0x0002)):
            inputs[index].type = 1
            inputs[index].ki = KeyInput(vk, 0, flags, 0, 0)
        sent = self.user.SendInput(2, inputs, C.sizeof(Input))
        trace['key_events_accepted'] = sent
        if sent == 1:
            release = Input(); release.type = 1
            release.ki = KeyInput(vk, 0, 0x0002, 0, 0)
            trace['key_release_accepted'] = self.user.SendInput(1, C.byref(release), C.sizeof(Input))
        if sent != 2:
            raise RuntimeError('Key batch incomplete; outcome unknown, no retry')
        return sent

    def press_chord(self, key: str, *, trace=None, before_chord=None) -> int:
        """Send one complete Ctrl+Left/Right chord; no repeat, hold or clipboard."""
        vk = VK_NAMES.get(key)
        if key not in {'Left', 'Right'} or vk is None:
            raise ValueError('Only Ctrl+Left/Right is supported')
        trace = {} if trace is None else trace
        trace['chord_events_accepted'] = 0
        trace['chord_cleanup_accepted'] = 0
        trace['chord'] = {'modifiers': ['ctrl'], 'key': key}
        if before_chord is not None:
            before_chord()
        if any(self.user.GetAsyncKeyState(code) & 0x8000 for code in (1, 2, 4, 16, 17, 18, 0x11, vk)):
            raise RuntimeError('Mouse button, modifier or target key is held')
        sequence = ((0x11, 0), (vk, 0), (vk, 0x0002), (0x11, 0x0002))
        inputs = (Input * len(sequence))()
        for index, (code, flags) in enumerate(sequence):
            inputs[index].type = 1
            inputs[index].ki = KeyInput(code, 0, flags, 0, 0)
        sent = self.user.SendInput(len(inputs), inputs, C.sizeof(Input))
        trace['chord_events_accepted'] = sent
        if sent != len(inputs):
            cleanup = (Input * 2)()
            for index, (code, flags) in enumerate(((vk, 0x0002), (0x11, 0x0002))):
                cleanup[index].type = 1
                cleanup[index].ki = KeyInput(code, 0, flags, 0, 0)
            try:
                trace['chord_cleanup_accepted'] = self.user.SendInput(
                    len(cleanup), cleanup, C.sizeof(Input))
            except Exception:
                trace['chord_cleanup_accepted'] = 0
            raise RuntimeError('Chord batch incomplete; outcome unknown, no retry')
        return sent

    def insert_text(self, text: str, *, trace=None, before_batch=None, batch_units: int = 8) -> int:
        """Send bounded literal UTF-16 text with paired keydown/keyup events."""
        encoded = text.encode('utf-16-le', 'strict')
        units = [int.from_bytes(encoded[index:index + 2], 'little')
                 for index in range(0, len(encoded), 2)]
        if not 1 <= len(units) <= 32:
            raise ValueError('UTF-16 text length is outside the executor limit')
        trace = {} if trace is None else trace
        trace['text_units'] = len(units)
        trace['text_events_accepted'] = 0
        accepted_total = 0
        start = 0
        while start < len(units):
            if before_batch is not None:
                before_batch()
            if any(self.user.GetAsyncKeyState(code) & 0x8000 for code in (1, 2, 4, 16, 17, 18, 0x5B, 0x5C)):
                raise RuntimeError('Mouse button or modifier held during text input')
            end = min(len(units), start + max(2, min(batch_units, 8)))
            if end < len(units) and 0xD800 <= units[end - 1] <= 0xDBFF:
                end -= 1
            chunk = units[start:end]
            inputs = (Input * (len(chunk) * 2))()
            for index, unit in enumerate(chunk):
                inputs[index * 2].type = 1
                inputs[index * 2].ki = KeyInput(0, unit, 0x0004, 0, 0)
                inputs[index * 2 + 1].type = 1
                inputs[index * 2 + 1].ki = KeyInput(0, unit, 0x0006, 0, 0)
            sent = self.user.SendInput(len(inputs), inputs, C.sizeof(Input))
            accepted_total += sent
            trace['text_events_accepted'] = accepted_total
            if sent != len(inputs):
                trace['text_batch_incomplete'] = True
                trace['text_cleanup_expected'] = len(chunk)
                cleanup = (Input * len(chunk))()
                for index, unit in enumerate(chunk):
                    cleanup[index].type = 1
                    cleanup[index].ki = KeyInput(0, unit, 0x0006, 0, 0)
                try:
                    trace['text_cleanup_accepted'] = self.user.SendInput(
                        len(cleanup), cleanup, C.sizeof(Input))
                except Exception:
                    trace['text_cleanup_accepted'] = 0
                raise RuntimeError('Text batch incomplete; outcome unknown, no retry')
            start = end
        return accepted_total
