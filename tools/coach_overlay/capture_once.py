"""One-shot mss capture with a local coarse frame difference.

Read-only with respect to the desktop: no model, no keyboard/mouse input.
The score is computed on a 32x18 sample grid against an optional previous raw
RGB frame. It is deliberately coarse and local; it is not a semantic change
detector.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

GRID_X = 32
GRID_Y = 18
CHANGE_THRESHOLD = 8
MAX_PREVIOUS_BYTES = 64 * 1024 * 1024


def score_frame(previous: bytes | None, current: bytes, width: int, height: int):
    """Return (score 0..255, changed_ratio 0..1, bbox or None)."""
    if previous is None:
        return 0, 0.0, None, True
    expected = width * height * 3
    if len(previous) != expected or len(current) != expected:
        return 255, 1.0, {"left": 0, "top": 0, "width": width, "height": height}, False
    total = 0
    changed = 0
    left = top = None
    right = bottom = None
    for gy in range(GRID_Y):
        y = int(gy * (height - 1) / max(1, GRID_Y - 1))
        for gx in range(GRID_X):
            x = int(gx * (width - 1) / max(1, GRID_X - 1))
            offset = (y * width + x) * 3
            diff = (abs(current[offset] - previous[offset])
                    + abs(current[offset + 1] - previous[offset + 1])
                    + abs(current[offset + 2] - previous[offset + 2])) // 3
            total += diff
            if diff >= CHANGE_THRESHOLD:
                changed += 1
                left = x if left is None else min(left, x)
                right = x if right is None else max(right, x)
                top = y if top is None else min(top, y)
                bottom = y if bottom is None else max(bottom, y)
    cells = GRID_X * GRID_Y
    bbox = None
    if left is not None:
        bbox = {"left": left, "top": top,
                "width": max(1, right - left + 1),
                "height": max(1, bottom - top + 1)}
    return round(total / cells), changed / cells, bbox, False


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--monitor", type=int, default=1)
    parser.add_argument("--outdir", required=True)
    parser.add_argument("--hwnd", type=int, default=None)
    parser.add_argument("--foreground-window", action="store_true")
    parser.add_argument("--target-pid", type=int)
    parser.add_argument("--exclude-pid", type=int, action="append", default=[])
    parser.add_argument("--desktop-windows", action="store_true")
    parser.add_argument("--previous-rgb", default=None)
    parser.add_argument("--region", nargs=4, type=int, default=None,
                        metavar=("LEFT", "TOP", "WIDTH", "HEIGHT"))
    args = parser.parse_args(argv)
    try:
        from mss import MSS
        from mss.tools import to_png
    except Exception as error:
        print(json.dumps({"ok": False, "error": f"mss unavailable: {error}"}))
        return 1
    try:
        with MSS() as sct:
            binding = None
            windows = None
            if args.desktop_windows:
                from watch_window import visible_windows
                windows = visible_windows(args.exclude_pid)
            if args.foreground_window:
                from watch_window import foreground_region, wait_foreground_region
                binding = wait_foreground_region(args.hwnd, args.target_pid, args.exclude_pid,
                                                 allow_background=args.hwnd is None)
                left, top, right, bottom = binding['rect']
                desktop = sct.monitors[0]
                left, top = max(left, desktop['left']), max(top, desktop['top'])
                right = min(right, desktop['left'] + desktop['width'])
                bottom = min(bottom, desktop['top'] + desktop['height'])
                if right <= left or bottom <= top:
                    raise RuntimeError('GUIDANCE_WINDOW_OFFSCREEN')
                region = {'left': left, 'top': top, 'width': right-left, 'height': bottom-top}
            elif args.hwnd:
                import win32gui
                left, top, right, bottom = win32gui.GetWindowRect(args.hwnd)
                region = {"left": left, "top": top,
                          "width": right - left, "height": bottom - top}
            elif args.region:
                left, top, width, height = args.region
                region = {"left": left, "top": top, "width": width, "height": height}
            else:
                if not (0 <= args.monitor < len(sct.monitors)):
                    raise ValueError("invalid monitor index")
                monitor = sct.monitors[args.monitor]
                region = {key: int(monitor[key]) for key in ("left", "top", "width", "height")}
            shot = sct.grab(region)
            if shot.width != region["width"] or shot.height != region["height"]:
                raise RuntimeError("capture dimensions differ from requested bounds")
            png = to_png(shot.rgb, (shot.width, shot.height))
            raw = bytes(shot.rgb)
            if windows is not None and visible_windows(args.exclude_pid) != windows:
                raise RuntimeError('DESKTOP_WINDOWS_CHANGED_DURING_CAPTURE')
            if (binding and not binding.get('background')
                    and foreground_region(binding['hwnd'], binding['pid'],
                                          args.exclude_pid) != binding):
                raise RuntimeError('GUIDANCE_WINDOW_CHANGED_DURING_CAPTURE')
        outdir = Path(args.outdir)
        outdir.mkdir(parents=True, exist_ok=True)
        token = uuid4().hex
        path = outdir / f"frame-{token}.png"
        raw_path = outdir / f"frame-{token}.rgb"
        with path.open("xb") as handle:
            handle.write(png)
        with raw_path.open("xb") as handle:
            handle.write(raw)
        previous = None
        previous_error = None
        if args.previous_rgb:
            try:
                candidate = Path(args.previous_rgb)
                if candidate.is_file() and candidate.stat().st_size <= MAX_PREVIOUS_BYTES:
                    previous = candidate.read_bytes()
                else:
                    previous_error = "previous_rgb_missing_or_too_large"
            except OSError as error:
                previous_error = f"previous_rgb_read_failed: {error}"
        changed_score, changed_ratio, bbox, first_frame = score_frame(
            previous, raw, shot.width, shot.height)
        print(json.dumps({
            "ok": True,
            "schema_version": 1,
            "backend": "mss",
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "monitor_index": args.monitor,
            "bounds": region,
            **({'target_window': binding} if binding else {}),
            **({'windows':windows, 'capture_scope':'desktop'} if windows is not None else {}),
            "width": shot.width,
            "height": shot.height,
            "image": {"path": str(path.resolve()), "width": shot.width,
                      "height": shot.height,
                      "sha256": hashlib.sha256(png).hexdigest()},
            "raw_path": str(raw_path.resolve()),
            "changed_score": changed_score,
            "changed_ratio": changed_ratio,
            "change_bbox": bbox,
            "first_frame": first_frame,
            **({"previous_error": previous_error} if previous_error else {}),
        }, ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": f"{type(error).__name__}: {error}"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
