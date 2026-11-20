#!/usr/bin/env python3
"""Coach overlay PoC: draw a click-through rectangle, arrow and one step.

This program is display-only. It never sends mouse/keyboard input, never
reads application content. It only restores focus after its own controls briefly
activate. The target
window must be foreground for the overlay to stay visible when --target-hwnd
is supplied.

It is a prototype for Coach mode, not a production authorization or execution
component.
"""
from __future__ import annotations

import argparse
import ctypes as C
import json
import os
import sys
import time
import tkinter as tk
import tkinter.font as tkfont
from ctypes import wintypes as W
from datetime import datetime, timezone
from pathlib import Path
from watch_window import visible_frame
# Transparent chroma key. Keep this exact color out of every drawn item.
CHROMA = "#010203"
DEFAULT_COLOR = "#00E5FF"
DEFAULT_TEXT_COLOR = "#FFFFFF"
FONT_CANDIDATES = ("Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", "Arial")
ASSET_DIR = Path(__file__).resolve().parent / "assets"
WHALE_SIZE = 520
WHALE_IMAGE = ASSET_DIR / "DSniang02-chroma.png"
WHALE_SOUND = ASSET_DIR / "Ya1.mp3"
NAVY, BLUE, MUTED = "#0B1736", "#35508F", "#6B7FAE"
PAPER, PALE, BORDER = "#F7FBFF", "#DCEBFF", "#8FA6D6"
BUTTON_BOX = (204, 166, 144, 40)
CLOSE_BOX = (480, 8, 32, 32)

user32 = C.WinDLL("user32", use_last_error=True)
winmm = C.WinDLL("winmm", use_last_error=True)
winmm.mciSendStringW.argtypes = [W.LPCWSTR, W.LPWSTR, W.UINT, W.HWND]
winmm.mciSendStringW.restype = W.UINT
if C.sizeof(C.c_void_p) == 8:
    get_window_long = user32.GetWindowLongPtrW
    set_window_long = user32.SetWindowLongPtrW
else:  # pragma: no cover - this project is x64 only
    get_window_long = user32.GetWindowLongW
    set_window_long = user32.SetWindowLongW
get_window_long.argtypes = [W.HWND, C.c_int]
get_window_long.restype = C.c_ssize_t
set_window_long.argtypes = [W.HWND, C.c_int, C.c_ssize_t]
set_window_long.restype = C.c_ssize_t
user32.SetWindowPos.argtypes = [W.HWND, W.HWND, C.c_int, C.c_int, C.c_int, C.c_int, W.UINT]
user32.SetWindowPos.restype = W.BOOL
user32.ShowWindow.argtypes = [W.HWND, C.c_int]
user32.ShowWindow.restype = W.BOOL
user32.GetForegroundWindow.restype = W.HWND
user32.SetForegroundWindow.argtypes = [W.HWND]
user32.SetForegroundWindow.restype = W.BOOL
user32.IsWindow.argtypes = [W.HWND]
user32.IsWindowVisible.argtypes = [W.HWND]
user32.IsIconic.argtypes = [W.HWND]
user32.GetAncestor.argtypes = [W.HWND, W.UINT]
user32.GetAncestor.restype = W.HWND
user32.SetWindowDisplayAffinity.argtypes = [W.HWND, W.DWORD]
user32.SetWindowDisplayAffinity.restype = W.BOOL
user32.GetSystemMetrics.argtypes = [C.c_int]
user32.GetSystemMetrics.restype = C.c_int
user32.GetWindowRect.argtypes = [W.HWND, C.POINTER(W.RECT)]
user32.GetWindowRect.restype = W.BOOL
gdi32 = C.WinDLL("gdi32", use_last_error=True)
gdi32.CreateRoundRectRgn.argtypes = [C.c_int] * 6
gdi32.CreateRoundRectRgn.restype = W.HANDLE
gdi32.DeleteObject.argtypes = [W.HANDLE]
user32.SetWindowRgn.argtypes = [W.HWND, W.HANDLE, W.BOOL]
user32.SetWindowRgn.restype = C.c_int

GWL_EXSTYLE = -20
WS_EX_LAYERED = 0x00080000
WS_EX_TRANSPARENT = 0x00000020
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_NOACTIVATE = 0x08000000
WS_EX_TOPMOST = 0x00000008
HWND_TOPMOST = W.HWND(-1)
SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOACTIVATE = 0x0010
SWP_SHOWWINDOW = 0x0040
SW_SHOWNOACTIVATE = 4
WDA_EXCLUDEFROMCAPTURE = 0x00000011
SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN = 76, 77
SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN = 78, 79


def set_dpi_awareness() -> None:
    """Make Tk and Win32 coordinates physical pixels before Tk starts."""
    try:
        user32.SetProcessDpiAwarenessContext(C.c_void_p(-4))  # Per Monitor V2
        return
    except Exception:
        pass
    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass


def virtual_screen() -> tuple[int, int, int, int]:
    x = user32.GetSystemMetrics(SM_XVIRTUALSCREEN)
    y = user32.GetSystemMetrics(SM_YVIRTUALSCREEN)
    width = user32.GetSystemMetrics(SM_CXVIRTUALSCREEN)
    height = user32.GetSystemMetrics(SM_CYVIRTUALSCREEN)
    if width <= 0 or height <= 0:
        raise RuntimeError("Cannot read the virtual desktop bounds")
    return x, y, width, height


def window_rect(hwnd: int) -> tuple[int, int, int, int] | None:
    rect = W.RECT()
    if not user32.GetWindowRect(hwnd, C.byref(rect)):
        return None
    return rect.left, rect.top, rect.right, rect.bottom


def root_window(tk_window: tk.Tk) -> int:
    return int(user32.GetAncestor(tk_window.winfo_id(), 2)) or int(tk_window.winfo_id())


def target_ready(hwnd: int, overlay_hwnds: object = None) -> bool:
    if not (bool(user32.IsWindow(hwnd)) and bool(user32.IsWindowVisible(hwnd))
            and not bool(user32.IsIconic(hwnd))):
        return False
    foreground = int(user32.GetForegroundWindow() or 0)
    allowed = {overlay_hwnds} if isinstance(overlay_hwnds, int) else set(overlay_hwnds or ())
    # Creating/mapping the overlay can briefly focus it; that is our own window,
    # not a target switch. The overlay is click-through and restores the prior
    # foreground after mapping. The control panel is also ours.
    return foreground in (allowed | {hwnd}) or bool(
        foreground and int(user32.GetAncestor(foreground, 2) or 0) == hwnd)


def parse_age(value: str, now: datetime | None = None) -> float:
    stamp = datetime.fromisoformat(value)
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return ((now or datetime.now(timezone.utc)) - stamp).total_seconds()


def observation_state(path: str, bbox: list[int], text: str, generation: int,
                      max_age: float) -> dict:
    """Convert an observation image bbox into physical screen state.

    Coach display does not require action readiness; a window identity plus a
    screenshot bbox is enough. Action authorization remains a separate path.
    """
    manifest = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    image = manifest.get("image")
    bounds = manifest.get("capture_bounds")
    window = manifest.get("window")
    observed_at = manifest.get("observed_at")
    if not isinstance(image, dict) or not isinstance(bounds, dict) or not isinstance(window, dict):
        raise ValueError("observation lacks image/capture_bounds/window")
    width, height = image.get("width"), image.get("height")
    if not all(isinstance(value, int) for value in (width, height)) or width <= 0 or height <= 0:
        raise ValueError("observation image size is invalid")
    if (not isinstance(bbox, (list, tuple)) or len(bbox) != 4
            or not all(isinstance(value, int) and not isinstance(value, bool) for value in bbox)
            or bbox[2] <= 0 or bbox[3] <= 0
            or bbox[0] < 0 or bbox[1] < 0
            or bbox[0] + bbox[2] > width or bbox[1] + bbox[3] > height):
        raise ValueError("bbox must be a non-empty rectangle inside the observation image")
    if not isinstance(observed_at, str):
        raise ValueError("observation has no observed_at")
    age = parse_age(observed_at)
    if max_age > 0 and (age < -5 or age > max_age):
        raise ValueError(f"observation is stale ({age:.1f}s, max {max_age:.1f}s)")
    hwnd = window.get("hwnd")
    if not isinstance(hwnd, int) or isinstance(hwnd, bool):
        raise ValueError("observation has no target hwnd")
    win_rect = window.get("rect")
    if (not isinstance(win_rect, (list, tuple)) or len(win_rect) != 4
            or not all(isinstance(value, int) and not isinstance(value, bool) for value in win_rect)):
        win_rect = None
    left = bounds.get("left")
    top = bounds.get("top")
    if not all(isinstance(value, int) for value in (left, top)):
        raise ValueError("observation origin is invalid")
    return {
        "visible": True,
        "rect": [left + bbox[0], top + bbox[1], bbox[2], bbox[3]],
        "text": text,
        "target_hwnd": hwnd,
        "window_rect": list(win_rect) if win_rect else None,
        "generation": generation,
        "observed_at": observed_at,
        "observation_id": manifest.get("observation_id"),
    }


def point_in_rect(x: int, y: int, rect: tuple[int, int, int, int]) -> bool:
    left, top, width, height = rect
    return left <= x < left + width and top <= y < top + height


def overlaps(a: tuple, b: tuple, padding: int = 12) -> bool:
    """XYWH overlap, including breathing room for strokes and animation."""
    return (a[0] < b[0] + b[2] + padding and a[0] + a[2] + padding > b[0]
            and a[1] < b[1] + b[3] + padding and a[1] + a[3] + padding > b[1])


def corner_position(screen: tuple, obstacles: list[tuple]) -> tuple | None:
    x, y, width, height = screen
    if width < WHALE_SIZE + 52 or height < WHALE_SIZE + 52:
        return None
    # Extra 6px allows the entrance rise while preserving the 20px margin.
    for left, top in ((x + width - WHALE_SIZE - 26, y + height - WHALE_SIZE - 26),
                      (x + 26, y + height - WHALE_SIZE - 26),
                      (x + width - WHALE_SIZE - 26, y + 26), (x + 26, y + 26)):
        if not any(overlaps((left, top, WHALE_SIZE, WHALE_SIZE), b) for b in obstacles):
            return left, top
    return None


def wrap_lines(text: str, measure, width: int) -> list[str]:
    """Measured CJK/Latin wrapping; explicit newlines count toward the limit."""
    lines = []
    for paragraph in text.split("\n"):
        line = ""
        for char in paragraph:
            if line and measure(line + char) > width:
                lines.append(line.rstrip())
                line = ""
            line += char
        lines.append(line.rstrip())
    return lines


def rounded_rect(canvas, bounds, radius=10, **style):
    x, y, right, bottom = bounds
    return canvas.create_polygon(
        x + radius, y, right - radius, y, right, y, right, y + radius,
        right, bottom - radius, right, bottom, right - radius, bottom,
        x + radius, bottom, x, bottom, x, bottom - radius, x, y + radius, x, y,
        smooth=True, splinesteps=16, **style)


def keyed_photo(master, source):
    """Normalize the supplied chroma asset's near-black matte at render time.

    Win32 color keys require an exact RGB match. The existing precomposited
    asset has (0..15) matte pixels around its silhouette, which otherwise show
    as black fragments. Only normalize this known asset, not arbitrary custom
    artwork. No asset file is changed and no image is rebuilt during animation.
    """
    ppm = source.tk.call(str(source), "data", "-format", "ppm")
    header_end = ppm.find(b"\n", ppm.find(b"\n", ppm.find(b"\n") + 1) + 1) + 1
    pixels = bytearray(ppm[header_end:])
    for offset in range(0, len(pixels), 3):
        if max(pixels[offset:offset + 3]) <= 15:
            pixels[offset:offset + 3] = b"\x01\x02\x03"
    return tk.PhotoImage(master=master, data=ppm[:header_end] + pixels, format="ppm")


class CoachOverlay:
    def __init__(self, args: argparse.Namespace) -> None:
        set_dpi_awareness()
        self.args = args
        self.state_path = args.state_file
        self.static_rect = tuple(args.rect) if args.rect else None
        self.static_text = args.text
        self.target_hwnd = args.target_hwnd
        self.max_age = args.max_age
        self.generation = args.generation
        self._observed_at = None
        self._last_generation = None
        self._window_rect = None
        self.steps: list[dict] = []
        self.step_index = 0
        self._state_signature = None
        self.paused = False
        if args.observation:
            observed = observation_state(args.observation, args.bbox, args.text,
                                         args.generation, args.max_age)
            self.static_rect = tuple(observed["rect"])
            self.static_text = observed["text"]
            self.target_hwnd = observed["target_hwnd"]
            self._observed_at = observed["observed_at"]
            self._window_rect = observed.get("window_rect")
        self.visible = False
        self._mapped = False
        self._last_state_hash: object = None
        self.debug = bool(args.debug)
        self._closed = False
        self._started = time.monotonic()
        self.virtual = virtual_screen()
        self._previous_foreground = int(user32.GetForegroundWindow() or 0)
        self.panel = None
        self.panel_hwnd = 0
        self._panel_visible = False
        self.whale = None
        self.whale_hwnd = 0
        self._whale_visible = False
        self._whale_pos = (0, 0)
        self._whale_image = None
        self._whale_text = None
        self._whale_button = None
        self.whale_button_window = None
        self.whale_button_hwnd = 0
        self._whale_button_visible = False
        self.whale_close_window = None
        self.whale_close_hwnd = 0
        self._active_target = self.target_hwnd
        self._draw_key = None
        self._whale_allowed = False
        self._motion_generation = 0
        self._text_generation = 0
        self._motion_y = 0
        self._finishing = False
        self._sound_aliases = set()
        self._event_path = args.event_file
        self._host_paced = bool(args.host_paced)
        self._last_event_key = None

        self.root = tk.Tk()
        self.root.withdraw()
        self.root.overrideredirect(True)
        self.root.configure(bg=CHROMA)
        self.root.attributes("-topmost", True)
        try:
            self.root.attributes("-transparentcolor", CHROMA)
        except tk.TclError:
            pass
        self.root.attributes("-alpha", 1.0)
        self.root.geometry(f"{self.virtual[2]}x{self.virtual[3]}"
                           f"{self.virtual[0]:+d}{self.virtual[1]:+d}")
        self.canvas = tk.Canvas(self.root, bg=CHROMA, highlightthickness=0,
                                bd=0, relief="flat")
        self.canvas.pack(fill="both", expand=True)
        self.font_family = self._pick_font()
        self.label_font = tkfont.Font(self.root, family=self.font_family,
                                      size=18, weight="bold")
        self.caption_font = tkfont.Font(self.root, family=self.font_family, size=11)
        self.root.update_idletasks()
        self.hwnd = root_window(self.root)
        self._set_extended_styles()
        if not args.no_panel:
            self._create_panel()
        if args.whale:
            self._create_whale()
        # tkinter creates and may briefly activate its native window before we
        # can apply NOACTIVATE. Restore the window that had focus before launch.
        if self._previous_foreground and user32.IsWindow(self._previous_foreground):
            user32.SetForegroundWindow(self._previous_foreground)
        self._set_visible(False)
        if not args.no_panel:
            self._set_panel_visible(True)
        self.root.after(50, self._tick)
        if args.seconds > 0:
            self.root.after(int(args.seconds * 1000), self.close)
        if self.debug:
            print(f"init hwnd={self.hwnd} virtual={self.virtual} withdrawn={self.root.winfo_ismapped()}",
                  file=sys.stderr, flush=True)

    def _pick_font(self) -> str:
        families = set(tkfont.families(self.root))
        for family in FONT_CANDIDATES:
            if family in families:
                return family
        return "Arial"

    def _set_extended_styles(self) -> None:
        style = int(get_window_long(self.hwnd, GWL_EXSTYLE))
        style |= (WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW
                  | WS_EX_NOACTIVATE | WS_EX_TOPMOST)
        set_window_long(self.hwnd, GWL_EXSTYLE, style)
        if self.args.exclude_capture:
            ok = bool(user32.SetWindowDisplayAffinity(self.hwnd, WDA_EXCLUDEFROMCAPTURE))
            if not ok:
                print("coach-overlay: WDA_EXCLUDEFROMCAPTURE failed; overlay may appear in captures",
                      file=sys.stderr)
        user32.SetWindowPos(self.hwnd, HWND_TOPMOST, 0, 0, 0, 0,
                            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)

    def _create_panel(self) -> None:
        panel = tk.Toplevel(self.root)
        panel.withdraw()
        panel.overrideredirect(True)
        panel.configure(bg="#101820")
        panel.attributes("-topmost", True)
        panel.geometry("520x88+0+0")
        label = tk.Label(panel, text="COACH 0/0", bg="#101820", fg="#00E5FF",
                         font=(self.font_family, 12, "bold"), anchor="w")
        label.pack(side="left", padx=(14, 8), fill="x", expand=True)
        button_style = {"bg": "#1B2A3A", "fg": "#E6F1FF", "activebackground": "#2B4057",
                        "activeforeground": "#FFFFFF", "relief": "flat", "bd": 0,
                        "font": (self.font_family, 10, "bold"), "width": 6}
        prev = tk.Button(panel, text="◀", command=lambda: self._change_step(-1), **button_style)
        prev.pack(side="left", padx=2, pady=22)
        next_button = tk.Button(panel, text="▶", command=lambda: self._change_step(1), **button_style)
        next_button.pack(side="left", padx=2, pady=22)
        pause = tk.Button(panel, text="暂停", command=self._toggle_pause, **button_style)
        pause.pack(side="left", padx=2, pady=22)
        close = tk.Button(panel, text="关闭", command=self.close, **button_style)
        close.pack(side="left", padx=(2, 12), pady=22)
        panel.update_idletasks()
        self.panel = panel
        self.panel_label = label
        self.prev_button = prev
        self.next_button = next_button
        self.pause_button = pause
        self.panel_hwnd = root_window(panel)
        self._exclude_window(self.panel_hwnd)
        style = int(get_window_long(self.panel_hwnd, GWL_EXSTYLE))
        set_window_long(self.panel_hwnd, GWL_EXSTYLE, style | WS_EX_TOOLWINDOW | WS_EX_TOPMOST)

    def _set_panel_visible(self, visible: bool) -> None:
        if self.panel is None or self._closed:
            return
        if visible == self._panel_visible:
            return
        if visible:
            self.panel.deiconify()
            self.panel.update_idletasks()
            user32.ShowWindow(self.panel_hwnd, SW_SHOWNOACTIVATE)
            user32.SetWindowPos(self.panel_hwnd, HWND_TOPMOST,
                                self.virtual[0] + 16, self.virtual[1] + 16,
                                520, 88, SWP_SHOWWINDOW | SWP_NOACTIVATE)
            if self._previous_foreground and user32.IsWindow(self._previous_foreground):
                user32.SetForegroundWindow(self._previous_foreground)
        else:
            self.panel.withdraw()
        self._panel_visible = visible

    def _raise_panel(self) -> None:
        if self.panel is not None and self._panel_visible:
            # Both windows are topmost. Re-assert the small control panel after
            # the full-screen click-through canvas, otherwise the canvas sits
            # above the buttons and clicks fall through it.
            user32.SetWindowPos(self.panel_hwnd, HWND_TOPMOST,
                                self.virtual[0] + 16, self.virtual[1] + 16,
                                520, 88, SWP_SHOWWINDOW | SWP_NOACTIVATE)

    def _ensure_panel(self) -> None:
        if self.panel is None or self._closed:
            return
        if not self._panel_visible or not user32.IsWindowVisible(self.panel_hwnd):
            self._panel_visible = False
            self._set_panel_visible(True)
        self._raise_panel()

    def _update_panel(self) -> None:
        if self.panel is None:
            return
        count = len(self.steps)
        current = self.step_index + 1 if count else 0
        self.panel_label.configure(text=f"COACH {current}/{count}")
        state = "normal" if count > 1 else "disabled"
        self.prev_button.configure(state=state)
        self.next_button.configure(state=state)
        self.pause_button.configure(text="继续" if self.paused else "暂停")

    def _toggle_pause(self) -> None:
        self.paused = not self.paused
        self._update_panel()
        if self.paused:
            self._set_visible(False)
            self._set_whale_visible(False)

    def _emit_event(self, kind: str, **fields) -> None:
        if not self._event_path:
            return
        event = {
            "schema_version": 1,
            "event": kind,
            "at": datetime.now(timezone.utc).isoformat(),
            "step_index": self.step_index,
            "step_id": self.steps[self.step_index].get("id") if self.steps else None,
            "target_hwnd": self._active_target,
            "generation": self.generation,
        }
        event.update(fields)
        path = Path(self._event_path)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            temp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
            temp.write_text(json.dumps(event, ensure_ascii=False), encoding="utf-8")
            os.replace(temp, path)
            self._last_event_key = (kind, self.step_index)
        except OSError as error:
            if self.debug:
                print(f"event write failed path={path!r} error={error}", file=sys.stderr, flush=True)

    def _change_step(self, delta: int) -> None:
        if self._host_paced:
            self._emit_event("step_requested", delta=delta)
            return
        if not self.steps:
            return
        index = max(0, min(self.step_index + delta, len(self.steps) - 1))
        if index == self.step_index:
            return
        self.step_index = index
        self._update_panel()
        self._update_whale_text()
        # The single 150ms polling loop updates the rectangle too. Do not start
        # an additional recurring loop on every click.

    def _create_whale(self) -> None:
        path = Path(self.args.whale_image).expanduser()
        if not path.is_absolute():
            path = Path.cwd() / path
        if not path.is_file():
            print(f"coach-overlay: whale image missing: {path}", file=sys.stderr)
            return
        win = tk.Toplevel(self.root)
        win.withdraw()
        win.overrideredirect(True)
        win.configure(bg=CHROMA)
        win.attributes("-topmost", True)
        try:
            win.attributes("-transparentcolor", CHROMA)
        except tk.TclError:
            pass
        win.geometry(f"{WHALE_SIZE}x{WHALE_SIZE}+0+0")
        canvas = tk.Canvas(win, bg=CHROMA, highlightthickness=0, bd=0)
        canvas.pack(fill="both", expand=True)
        image = tk.PhotoImage(file=str(path))
        if image.width() > WHALE_SIZE:
            image = image.subsample(2)
        if path.resolve() == WHALE_IMAGE.resolve():
            image = keyed_photo(self.root, image)
        canvas.create_image(0, 0, anchor="nw", image=image)
        self._whale_image = image
        # Pixel fonts keep this fixed 520px artwork independent of Tk's point
        # scaling. At 150% these are approximately 16/11/12 logical px.
        self._step_font = tkfont.Font(self.root, family=self.font_family, size=-24, weight="bold")
        self._progress_id = canvas.create_text(
            227, 65, text="STEP 1 / 1", fill=MUTED,
            font=(self.font_family, -16, "bold"))
        canvas.create_line(213, 81, 241, 81, fill="#6BC9E3", width=2)
        self._whale_text_id = canvas.create_text(
            227, 118, text="准备中…", fill=NAVY,
            font=self._step_font, justify="center")
        win.update_idletasks()
        self.whale = win
        self.whale_canvas = canvas
        self.whale_hwnd = root_window(win)
        style = int(get_window_long(self.whale_hwnd, GWL_EXSTYLE))
        set_window_long(self.whale_hwnd, GWL_EXSTYLE,
                        style | WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT)
        self._whale_pos = (self.virtual[0] + self.virtual[2] - WHALE_SIZE - 20,
                           self.virtual[1] + self.virtual[3] - WHALE_SIZE - 20)
        self._exclude_window(self.whale_hwnd)

        # A separate opaque button window keeps the click target independent of
        # the transparent image window's changing frame. It sits inside the
        # painted bubble and looks like one control.
        self.whale_button_window, self.whale_button_hwnd, self._whale_button = self._make_control(
            "Coach · 下一步", BUTTON_BOX[2:], self._whale_next)
        self.whale_close_window, self.whale_close_hwnd, _ = self._make_control(
            "Coach · 关闭", CLOSE_BOX[2:], self.close, is_close=True)

    def _exclude_window(self, hwnd: int) -> None:
        if self.args.exclude_capture and not user32.SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE):
            print(f"coach-overlay: capture exclusion failed for control {hwnd}", file=sys.stderr)

    def _make_control(self, title, size, command, is_close=False):
        """Opaque, rounded native window: no color key or moving image frame."""
        width, height = size
        win = tk.Toplevel(self.root)
        win.withdraw()
        win.title(title)
        win.overrideredirect(True)
        win.configure(bg=PAPER)
        win.attributes("-topmost", True)
        win.geometry(f"{width}x{height}+0+0")
        canvas = tk.Canvas(win, bg=PAPER, bd=0, highlightthickness=0, cursor="hand2")
        canvas.pack(fill="both", expand=True)
        shape = rounded_rect(canvas, (1, 1, width - 2, height - 3),
                             fill=PAPER, outline=BORDER, width=1)
        label = canvas.create_text(width / 2, height / 2 - 1,
                                   text="×" if is_close else "下一步  →", fill=MUTED if is_close else BLUE,
                                   font=(self.font_family, -22 if is_close else -18, "bold"))
        canvas.control_label = label
        pressed, hover, revision = False, False, 0

        def paint():
            nonlocal revision
            revision += 1
            token = revision
            start = canvas.itemcget(shape, "fill")
            end = "#C9DFFF" if pressed and hover else PALE if hover else PAPER
            start_rgb = tuple(int(start[i:i + 2], 16) for i in (1, 3, 5))
            end_rgb = tuple(int(end[i:i + 2], 16) for i in (1, 3, 5))
            canvas.coords(label, width / 2, height / 2 - 1 + int(pressed and hover))
            canvas.itemconfigure(label, fill="#A8324A" if is_close and hover else MUTED if is_close else BLUE)

            def frame(step=1):
                if self._closed or token != revision:
                    return
                rgb = tuple(round(a + (b - a) * step / 4) for a, b in zip(start_rgb, end_rgb))
                canvas.itemconfigure(shape, fill="#%02x%02x%02x" % rgb)
                if step < 4:
                    self.root.after(20, lambda: frame(step + 1))
            frame()

        def enter(_):
            nonlocal hover
            hover = True
            paint()

        def leave(_):
            nonlocal hover
            hover = False
            paint()

        def down(_):
            nonlocal pressed
            pressed = True
            paint()

        def up(event):
            nonlocal pressed
            invoke = pressed and 0 <= event.x < width and 0 <= event.y < height
            pressed = False
            paint()
            if invoke:
                command()
                self._restore_target_foreground()

        def unmap(event):
            nonlocal pressed
            pressed = False
            leave(event)

        canvas.bind("<Enter>", enter)
        canvas.bind("<Leave>", leave)
        canvas.bind("<ButtonPress-1>", down)
        canvas.bind("<ButtonRelease-1>", up)
        # No global binding. Clear an interrupted press when this control hides.
        canvas.bind("<Unmap>", unmap)
        win.update_idletasks()
        hwnd = root_window(win)
        style = int(get_window_long(hwnd, GWL_EXSTYLE))
        set_window_long(hwnd, GWL_EXSTYLE, style | WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE)
        region = gdi32.CreateRoundRectRgn(0, 0, width + 1, height + 1, 20, 20)
        if region and not user32.SetWindowRgn(hwnd, region, True):
            gdi32.DeleteObject(region)  # On success Windows owns the region.
        self._exclude_window(hwnd)
        return win, hwnd, canvas

    def _whale_next(self) -> None:
        if not self.steps or self._finishing or self.paused or not self._whale_visible:
            return
        last = self.step_index >= len(self.steps) - 1
        self._emit_event("finish_requested" if last else "next_requested")
        if self._host_paced:
            self._play_whale_sound()
            if last:
                self._update_whale_text("步骤已浏览完")
                self._whale_pop()
            self._restore_target_foreground()
            return
        if last:
            self._finishing = True
            self._update_whale_text("步骤已浏览完")
            self._play_whale_sound()
            self._whale_pop()
            self.root.after(700, self.close)
            return
        self._change_step(1)
        self._play_whale_sound()
        self._restore_target_foreground()

    def _update_whale_text(self, text: str | None = None) -> None:
        if not self.whale:
            return
        if self._finishing:
            text = "步骤已浏览完"
        elif text is None:
            text = self.steps[self.step_index].get("text", "") if self.steps else "准备中…"
        text = text.strip() or "准备中…"
        key = (text, self.step_index, len(self.steps), self._finishing)
        if key == self._whale_text:
            return
        self._whale_text = key
        # Shrink first, then explicitly ellipsize; never suggest a truncated
        # instruction is complete. The full host text remains in state.
        for size in (24, 23, 22, 21, 20):
            self._step_font.configure(size=-size)
            lines = wrap_lines(text, self._step_font.measure, 292)
            if len(lines) <= 2:
                break
        if len(lines) > 2:
            line = lines[1]
            while line and self._step_font.measure(line + "…") > 292:
                line = line[:-1]
            lines = [lines[0], line + "…"]
        self.whale_canvas.itemconfigure(self._whale_text_id, text="\n".join(lines))
        self.whale_canvas.itemconfigure(self._progress_id,
                                        text=f"STEP {self.step_index + 1} / {max(1, len(self.steps))}")
        self._whale_button.itemconfigure(self._whale_button.control_label,
                                          text="结束提示  ✓" if self.step_index == len(self.steps) - 1 else "下一步  →")
        if self._whale_visible:
            self._whale_pop()

    def _set_whale_visible(self, visible: bool) -> None:
        if not self.whale or self._closed:
            return
        if visible == self._whale_visible:
            return
        self._motion_generation += 1
        self._whale_visible = visible
        if visible:
            for win, hwnd, _ in self._whale_windows():
                win.attributes("-alpha", 0.0)
                win.deiconify()
                win.update_idletasks()
                user32.ShowWindow(hwnd, SW_SHOWNOACTIVATE)
            self._whale_fade(0, self._motion_generation)
            self._update_whale_text()
            self._restore_target_foreground()
        else:
            self._motion_y = 0
            for win, _, _ in self._whale_windows():
                win.withdraw()

    def _whale_windows(self):
        return ((self.whale, self.whale_hwnd, (0, 0, WHALE_SIZE, WHALE_SIZE)),
                (self.whale_button_window, self.whale_button_hwnd, BUTTON_BOX),
                (self.whale_close_window, self.whale_close_hwnd, CLOSE_BOX))

    def _whale_fade(self, step: int, token: int) -> None:
        if self._closed or not self._whale_visible or token != self._motion_generation:
            return
        self._motion_y = round(6 * (1 - step / 6))
        for win, _, _ in self._whale_windows():
            win.attributes("-alpha", step / 6)
        self._restore_whale_position()
        if step < 6:
            self.root.after(28, lambda: self._whale_fade(step + 1, token))

    def _whale_pop(self) -> None:
        if not self.whale or self._closed:
            return
        # Animate only text, not the image or clickable HWND's geometry.
        self._text_generation += 1
        token = self._text_generation
        def frame(step=0):
            if self._closed or token != self._text_generation:
                return
            self.whale_canvas.coords(self._whale_text_id, 227, 118 + (3, 2, 1, 0)[step])
            self.whale_canvas.itemconfigure(self._whale_text_id,
                                            fill=(MUTED, BLUE, "#233661", NAVY)[step])
            if step < 3:
                self.root.after(35, lambda: frame(step + 1))
        frame()

    def _restore_whale_position(self) -> None:
        if not self.whale or self._closed or not self._whale_visible:
            return
        x, y = self._whale_pos
        for _, hwnd, (ox, oy, width, height) in self._whale_windows():
            user32.SetWindowPos(hwnd, HWND_TOPMOST, x + ox, y + oy + self._motion_y,
                                width, height, SWP_NOACTIVATE)

    def _restore_target_foreground(self) -> None:
        target = self._active_target or self._previous_foreground
        own = (self.hwnd, self.whale_hwnd, self.whale_button_hwnd, self.whale_close_hwnd)
        if target and user32.IsWindow(target) and int(user32.GetForegroundWindow() or 0) in own:
            user32.SetForegroundWindow(target)

    def _play_whale_sound(self) -> None:
        if self.args.no_sound or not WHALE_SOUND.is_file():
            return
        alias = f"coachwhale{int(time.monotonic() * 1000)}"
        cmd = f'open "{WHALE_SOUND}" type mpegvideo alias {alias}'
        if winmm.mciSendStringW(cmd, None, 0, None) != 0:
            return
        self._sound_aliases.add(alias)
        winmm.mciSendStringW(f"play {alias}", None, 0, None)
        self.root.after(1400, lambda: self._close_sound(alias))

    def _close_sound(self, alias):
        winmm.mciSendStringW(f"close {alias}", None, 0, None)
        self._sound_aliases.discard(alias)

    def _raise_whale(self) -> None:
        self._restore_whale_position()

    def _set_visible(self, visible: bool) -> None:
        if self._closed:
            return
        if visible == self.visible:
            return
        if self.debug:
            print(f"overlay visible={visible} mapped={self.root.winfo_ismapped()} "
                  f"fg={int(user32.GetForegroundWindow() or 0)} hwnd={self.hwnd} "
                  f"geometry={self.root.geometry()} tk={self.root.winfo_width()}x{self.root.winfo_height()} "
                  f"fpixels={self.root.winfo_fpixels('1i')} scaling={self.root.tk.call('tk','scaling')}",
                  file=sys.stderr, flush=True)
        if visible:
            # The native ShowWindow alone does not make Tk's withdrawn state
            # render. Map through Tk once, then restore the previous foreground
            # so the overlay does not remain the active window.
            if not self._mapped:
                self.root.deiconify()
                self._mapped = True
                self.root.update_idletasks()
            user32.ShowWindow(self.hwnd, SW_SHOWNOACTIVATE)
            # Tk's initial requested geometry is DPI-scaled. Force the native
            # top-level to the full virtual desktop in physical pixels.
            user32.SetWindowPos(self.hwnd, HWND_TOPMOST,
                                self.virtual[0], self.virtual[1],
                                self.virtual[2], self.virtual[3],
                                SWP_SHOWWINDOW | SWP_NOACTIVATE)
            user32.SetWindowPos(self.hwnd, HWND_TOPMOST, 0, 0, 0, 0,
                                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
            self._ensure_panel()
            self._raise_whale()
            self._restore_target_foreground()
        else:
            self.root.withdraw()
        self.visible = visible

    def _state(self) -> dict | None:
        if not self.state_path:
            return {"visible": True, "rect": self.static_rect,
                    "text": self.static_text, "target_hwnd": self.target_hwnd,
                    "window_rect": self._window_rect,
                    "generation": self.generation, "observed_at": self._observed_at}
        try:
            stat = os.stat(self.state_path)
            key = (stat.st_mtime_ns, stat.st_size)
            if key == self._last_state_hash:
                return getattr(self, "_cached_state", None)
            with open(self.state_path, "r", encoding="utf-8-sig") as handle:
                value = json.load(handle)
            self._last_state_hash = key
            self._cached_state = value if isinstance(value, dict) else None
            return self._cached_state
        except (OSError, ValueError) as error:
            if self.debug:
                print(f"state read failed path={self.state_path!r} error={type(error).__name__}: {error}",
                      file=sys.stderr, flush=True)
            self._last_state_hash = None
            self._cached_state = None
            return None

    def _validate(self, state: dict) -> tuple[tuple[int, int, int, int], str, int | None] | None:
        if state.get("visible") is False:
            return None
        generation = state.get("generation")
        if generation is not None:
            if not isinstance(generation, int) or isinstance(generation, bool):
                return None
            if self._last_generation is not None and generation < self._last_generation:
                return None
            self._last_generation = generation
        observed_at = state.get("observed_at")
        if observed_at is not None and self.max_age > 0:
            try:
                age = parse_age(observed_at)
            except (TypeError, ValueError):
                return None
            if age < -5 or age > self.max_age:
                return None
        target = state.get("target_hwnd")
        if target is not None and (not isinstance(target, int) or isinstance(target, bool)):
            return None
        # New guidance snapshots use DWM visible-frame coordinates, and may
        # include both the owner and its foreground dialog. Never compare their
        # union with GetWindowRect (invisible resize borders use another rect).
        geometry = state.get('window_geometry')
        if geometry is not None:
            if not isinstance(geometry, list) or not 1 <= len(geometry) <= 16:
                return None
            handles = []
            for entry in geometry:
                if not isinstance(entry, dict):
                    return None
                hwnd, bounds = entry.get('hwnd'), entry.get('rect')
                if (type(hwnd) is not int or hwnd <= 0 or not isinstance(bounds, list)
                        or len(bounds) != 4 or any(type(v) is not int for v in bounds)
                        or bounds[2] <= bounds[0] or bounds[3] <= bounds[1]):
                    return None
                handles.append(hwnd)
                try:
                    if not user32.IsWindowVisible(hwnd) or user32.IsIconic(hwnd) or visible_frame(hwnd) != bounds:
                        return None
                except Exception:
                    return None
            if target not in handles:
                return None
        pinned_rect = state.get("window_rect")
        if pinned_rect is not None:
            if (not isinstance(pinned_rect, (list, tuple)) or len(pinned_rect) != 4
                    or not all(isinstance(value, int) and not isinstance(value, bool)
                               for value in pinned_rect)
                    or not isinstance(target, int)):
                return None
            if window_rect(target) != tuple(pinned_rect):
                return None
        raw_steps = state.get("steps")
        if raw_steps is None:
            self.steps = [state]
            self.step_index = 0
        else:
            if not isinstance(raw_steps, list) or not 1 <= len(raw_steps) <= 20:
                return None
            requested = state.get("step_index", 0)
            if not isinstance(requested, int) or isinstance(requested, bool):
                return None
            try:
                signature = json.dumps(
                    {"generation": generation, "observed_at": observed_at,
                     "steps": raw_steps, "step_index": requested},
                    ensure_ascii=True, sort_keys=True, separators=(",", ":"))
            except TypeError:
                return None
            if signature != self._state_signature:
                self._state_signature = signature
                self.steps = [step for step in raw_steps if isinstance(step, dict)]
                if len(self.steps) != len(raw_steps):
                    return None
                self.step_index = max(0, min(requested, len(self.steps) - 1))
        if not self.steps:
            return None
        step = self.steps[self.step_index]
        rect = step.get("rect")
        if (not isinstance(rect, (list, tuple)) or len(rect) != 4
                or not all(isinstance(value, int) and not isinstance(value, bool) for value in rect)
                or rect[2] <= 0 or rect[3] <= 0):
            return None
        rect = list(rect)
        text = step.get("text", "")
        if not isinstance(text, str) or not text.strip():
            return None
        if not point_in_rect(rect[0] + 1, rect[1] + 1, (self.virtual[0], self.virtual[1],
                                                       self.virtual[2], self.virtual[3])):
            return None
        return (rect[0], rect[1], rect[2], rect[3]), text.strip()[:240], target

    def _draw(self, rect: tuple[int, int, int, int], text: str) -> None:
        left, top, width, height = rect
        sx, sy, sw, sh = self.virtual
        # Short, independent arrow; reserve its whole stroke/arrowhead bounds
        # before choosing a corner. No connector crosses the desktop.
        cx, cy = left + width // 2, top + height // 2
        candidates = ((cx, top - 62, cx, top - 9),
                      (cx, top + height + 62, cx, top + height + 9),
                      (left - 62, cy, left - 9, cy),
                      (left + width + 62, cy, left + width + 9, cy))
        arrow = next((a for a in candidates if all(
            sx + 12 <= a[i] <= sx + sw - 12 and sy + 12 <= a[i + 1] <= sy + sh - 12
            for i in (0, 2))), None)
        obstacles = [rect]
        if arrow:
            x1, y1, x2, y2 = arrow
            obstacles.append((min(x1, x2) - 10, min(y1, y2) - 10,
                              abs(x1 - x2) + 20, abs(y1 - y2) + 20))
        if self.panel and self._panel_visible:
            obstacles.append((sx + 16, sy + 16, 520, 88))
        placement = corner_position(self.virtual, obstacles) if self.whale else None
        self._whale_allowed = placement is not None
        if placement is not None:
            self._whale_pos = placement
        self._update_whale_text(text)
        key = (rect, text, self.step_index, placement, self.args.color)
        if key == self._draw_key:
            return
        self._draw_key = key
        self.canvas.delete("all")
        left, top = left - sx, top - sy
        color = self.args.color
        self.canvas.create_rectangle(left, top, left + width, top + height,
                                     outline=NAVY, width=5)
        self.canvas.create_rectangle(left - 2, top - 2, left + width + 2, top + height + 2,
                                     outline=color, width=2)
        if self._whale_allowed:
            if arrow:
                x1, y1, x2, y2 = arrow
                self.canvas.create_line(x1 - sx, y1 - sy, x2 - sx, y2 - sy,
                                        fill=color, width=3, arrow=tk.LAST, arrowshape=(10, 13, 5))
            self._draw_caption()
            return
        self._draw_callout(left, top, width, height, text, color)
        # A quiet caption for the PoC: no fake success, no hidden input.
        self._draw_caption()

    def _draw_callout(self, left, top, width, height, text, color):
        """Size the background from Tk's actual wrapped text, including newlines."""
        screen_width, screen_height = self.virtual[2:]
        natural_width = max((self.label_font.measure(line) for line in text.splitlines()), default=0)
        label_width = min(max(360, natural_width + 120), 900, screen_width - 24)
        text_id = self.canvas.create_text(0, 0, text=text, fill=DEFAULT_TEXT_COLOR,
                                          anchor="nw", justify="left", width=max(1, label_width - 82),
                                          font=self.label_font, tags=("callout-text",))
        bounds = self.canvas.bbox(text_id)
        # Extremely tall messages must not grow beyond the desktop. Keep a
        # visible ellipsis; the complete instruction remains in the chat panel.
        shortened = text
        while bounds[3] - bounds[1] > screen_height - 48 and shortened:
            shortened = shortened[:-1].rstrip()
            self.canvas.itemconfigure(text_id, text=shortened + "…")
            bounds = self.canvas.bbox(text_id)
        text_height = bounds[3] - bounds[1]
        label_height = max(64, text_height + 24)
        label_left = max(12,
                         min(left + width // 2 - label_width // 2,
                             screen_width - label_width - 12))
        if top - label_height - 44 >= 12:
            label_top = top - label_height - 44
            line_end_y = top - 4
        else:
            label_top = top + height + 44
            line_end_y = top + height + 4
        label_top = max(12, min(label_top, screen_height - label_height - 12))
        line_x = left + width // 2
        self.canvas.create_line(line_x, label_top + label_height // 2, line_x,
                                line_end_y, fill=color, width=5, arrow=tk.LAST,
                                arrowshape=(16, 20, 8))
        self.canvas.create_rectangle(label_left, label_top,
                                     label_left + label_width, label_top + label_height,
                                     fill="#101820", outline=color, width=2,
                                     tags=("callout-background",))
        self.canvas.create_text(label_left + 24, label_top + label_height // 2,
                                text="▶", fill=color, anchor="w",
                                font=(self.font_family, 20, "bold"))
        self.canvas.coords(text_id, label_left + 64 - bounds[0],
                           label_top + (label_height - text_height) / 2 - bounds[1])
        self.canvas.tag_raise(text_id)

    def _draw_caption(self):
        caption = "COACH PREVIEW · 仅显示，不会点击或输入"
        caption_width = self.caption_font.measure(caption) + 28
        rounded_rect(self.canvas, (8, self.virtual[3] - 48, caption_width + 8, self.virtual[3] - 8),
                     fill=NAVY, outline="")
        self.canvas.create_text(16, self.virtual[3] - 28,
                                text=caption,
                                fill="#B8C7D9", anchor="w",
                                font=self.caption_font)

    def _tick(self) -> None:
        if self._closed:
            return
        if self.args.seconds > 0 and time.monotonic() - self._started >= self.args.seconds:
            self.close()
            return
        if self.paused:
            self._set_visible(False)
            self._set_whale_visible(False)
            self._update_panel()
            self.root.after(150, self._tick)
            return
        state = self._state()
        if not state:
            self._set_visible(False)
            self._set_whale_visible(False)
            self.root.after(150, self._tick)
            return
        valid = self._validate(state)
        self._update_panel()
        if not valid:
            if self.debug:
                print(f"invalid state {state}", file=sys.stderr, flush=True)
            self._set_visible(False)
            self._set_whale_visible(False)
            if state.get('visible') is False and self.state_path:
                generation = state.get('generation')
                if generation != getattr(self, '_hidden_generation', None):
                    self.root.update_idletasks()
                    Path(self.state_path).with_suffix('.hidden.json').write_text(
                        json.dumps({'generation': generation}), encoding='utf-8')
                    self._hidden_generation = generation
            self.root.after(150, self._tick)
            return
        rect, text, target = valid
        self._active_target = target
        if target and not target_ready(target, (self.hwnd, self.panel_hwnd,
                                                self.whale_hwnd, self.whale_button_hwnd,
                                                self.whale_close_hwnd)):
            if self.debug:
                print(f"target not ready target={target} fg={int(user32.GetForegroundWindow() or 0)} "
                      f"visible={bool(user32.IsWindowVisible(target))}", file=sys.stderr)
            self._set_visible(False)
            self._set_whale_visible(False)
            self.root.after(150, self._tick)
            return
        self._draw(rect, text)
        self._set_visible(True)
        self._set_whale_visible(self._whale_allowed)
        self._raise_whale()
        self.root.after(150, self._tick)

    def close(self) -> None:
        if self._closed:
            return
        self._emit_event("closed")
        self._restore_target_foreground()
        self._closed = True
        for alias in tuple(self._sound_aliases):
            self._close_sound(alias)
        try:
            self.root.destroy()
        except tk.TclError:
            pass

    def run(self) -> None:
        try:
            self.root.mainloop()
        except KeyboardInterrupt:
            self.close()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Display-only Coach overlay PoC")
    parser.add_argument("--rect", nargs=4, type=int, metavar=("X", "Y", "W", "H"),
                        help="target rectangle in physical desktop pixels")
    parser.add_argument("--observation", help="action-ready observation.json path")
    parser.add_argument("--bbox", nargs=4, type=int, metavar=("X", "Y", "W", "H"),
                        help="target rectangle in observation image pixels")
    parser.add_argument("--text", default="", help="one short coaching step")
    parser.add_argument("--target-hwnd", type=int, default=None,
                        help="hide unless this window is foreground and visible")
    parser.add_argument("--state-file", help="JSON state file for host updates")
    parser.add_argument("--event-file", help="write next/finish/closed events for a host")
    parser.add_argument("--host-paced", action="store_true",
                        help="emit next events and wait for host state instead of advancing locally")
    parser.add_argument("--generation", type=int, default=1,
                        help="host generation; lower generations are ignored")
    parser.add_argument("--max-age", type=float, default=30,
                        help="reject observation/state older than this many seconds; 0 disables")
    parser.add_argument("--seconds", type=float, default=0,
                        help="auto-close after N seconds; 0 means stay until closed")
    parser.add_argument("--color", default=DEFAULT_COLOR)
    parser.add_argument("--exclude-capture", action="store_true",
                        help="try SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)")
    parser.add_argument("--no-panel", action="store_true",
                        help="do not show the small pause/prev/next/close panel")
    parser.add_argument("--whale", action="store_true",
                        help="show DSniang02 whale bubble prompt with a next button")
    parser.add_argument("--whale-image", default=str(WHALE_IMAGE),
                        help="whale widget PNG (default: assets/DSniang02-chroma.png)")
    parser.add_argument("--no-sound", action="store_true",
                        help="disable whale step sound")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args(argv)
    if args.observation:
        if not args.bbox:
            parser.error("--observation requires --bbox")
        if args.rect:
            parser.error("use either --observation/--bbox or --rect")
        if not args.text.strip():
            parser.error("--observation requires --text")
    elif not args.state_file and not args.rect:
        parser.error("provide --rect, --observation/--bbox, or --state-file")
    elif not args.state_file and not args.text.strip():
        parser.error("provide --text with --rect")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        CoachOverlay(args).run()
    except Exception as error:
        print(f"coach-overlay: {type(error).__name__}: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
