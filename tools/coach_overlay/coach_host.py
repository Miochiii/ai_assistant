#!/usr/bin/env python3
"""Host-side Coach loop: Next event -> fresh capture -> relocate -> state update.

Display-only. The host never sends input to the target application and never
calls the executor. It reads the overlay's next event, captures the desktop,
relocates the next target patch, and writes a fresh overlay state.

The locator is deliberately bounded: a reference screenshot + target bbox from
a plan are matched near the previous target. If the target cannot be found
unambiguously, the overlay is hidden instead of showing a stale box.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from desktop_adapter.locate import locate_patch  # noqa: E402

DEFAULT_OVERLAY = Path(__file__).with_name("coach_overlay.py")
DEFAULT_PYTHON = Path(r"E:\python\python.exe")
OCR_HELPER = Path(__file__).with_name("ocr_windows.ps1")
OCR_LANGUAGE = "zh-Hans-CN"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json_atomic(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    os.replace(temp, path)


def capture_screen(run_dir: Path, index: int) -> Path:
    from mss import MSS
    from mss.tools import to_png

    path = run_dir / f"screen-{index:02d}.png"
    with MSS() as sct:
        shot = sct.grab(sct.monitors[1])
        png = to_png(shot.rgb, (shot.width, shot.height))
    path.write_bytes(png)
    return path


def rect_center(rect: list[int]) -> tuple[int, int]:
    return int(rect[0] + rect[2] // 2), int(rect[1] + rect[3] // 2)


def ocr_image(path: Path) -> dict | None:
    """Run the built-in Windows OCR engine through Windows PowerShell."""
    command = [
        "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", str(OCR_HELPER),
        "-ImagePath", str(path),
        "-Language", OCR_LANGUAGE,
    ]
    try:
        result = subprocess.run(command, capture_output=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    raw = result.stdout
    for encoding in ("utf-8-sig", "utf-8", "mbcs"):
        try:
            text = raw.decode(encoding)
        except UnicodeDecodeError:
            continue
        text = text.strip()
        if not text:
            continue
        try:
            value = json.loads(text)
        except ValueError:
            start = text.find("{")
            end = text.rfind("}")
            if start < 0 or end <= start:
                continue
            try:
                value = json.loads(text[start:end + 1])
            except ValueError:
                continue
        if isinstance(value, dict) and isinstance(value.get("lines"), list):
            return value
    return None


def _normalize_ocr_text(value: str) -> str:
    return "".join(ch for ch in value.casefold() if not ch.isspace()
                   and ch not in "“”\"'‘’「」『』")


def locate_text(step: dict, fresh_path: Path, *, debug: bool = False) -> dict | None:
    target = step.get("target")
    if not isinstance(target, str) or not target.strip():
        return None
    result = ocr_image(fresh_path)
    if not result:
        return None
    needle = _normalize_ocr_text(target)
    if not needle:
        return None
    matches = []
    for line in result["lines"]:
        if not isinstance(line, dict):
            continue
        text = line.get("text")
        rect = line.get("rect")
        if not isinstance(text, str) or not isinstance(rect, list) or len(rect) != 4:
            continue
        haystack = _normalize_ocr_text(text)
        if needle not in haystack:
            continue
        # Prefer the shortest containing line; this avoids a long transcript
        # paragraph that merely happens to include the target substring.
        matches.append((len(haystack), rect, text))
    if not matches:
        if debug:
            print(f"ocr target not found: {target!r}", file=sys.stderr, flush=True)
        return None
    matches.sort(key=lambda item: item[0])
    _, rect, text = matches[0]
    x, y, width, height = [int(v) for v in rect]
    # OCR boxes hug the glyphs; a small pad makes a usable Coach rectangle.
    pad = int(step.get("ocr_pad", 8))
    x, y = max(0, x - pad), max(0, y - pad)
    width, height = width + pad * 2, height + pad * 2
    if debug:
        print(f"ocr match {target!r} -> {text!r} rect={[x, y, width, height]}",
              file=sys.stderr, flush=True)
    return {
        "rect": [x, y, width, height],
        "locator": {
            "schema_version": 1,
            "locator": "windows_ocr_line",
            "language": result.get("language"),
            "target": target,
            "matched_text": text,
            "rect": [x, y, width, height],
        },
        "source": "ocr",
    }


def locate_step(step: dict, fresh_path: Path, *, locator: str = "auto",
                debug: bool = False) -> dict | None:
    if locator in ("auto", "ocr") and step.get("target"):
        located = locate_text(step, fresh_path, debug=debug)
        if located:
            return located
        if locator == "ocr":
            return None
    reference = step.get("reference")
    bbox = step.get("bbox")
    if not isinstance(reference, str) or not isinstance(bbox, list):
        return None
    reference_path = Path(reference).expanduser()
    if not reference_path.is_absolute():
        reference_path = ROOT / reference_path
    bbox = [int(v) for v in bbox]
    if len(bbox) != 4 or bbox[2] <= 0 or bbox[3] <= 0:
        return None
    result = locate_patch(
        reference_path, fresh_path,
        target_center=rect_center(bbox),
        patch_size=(max(32, min(96, bbox[2])), max(24, min(48, bbox[3]))),
        search_radius=int(step.get("search_radius", 64)),
        stride=3,
        tolerance=int(step.get("tolerance", 20)),
        min_similarity=float(step.get("min_similarity", 0.88)),
        min_margin=float(step.get("min_margin", 0.004)),
        min_separation=int(step.get("min_separation", 24)),
        scales=(1.0,),
    )
    if debug:
        print(json.dumps(result, ensure_ascii=False), file=sys.stderr, flush=True)
    if result.get("status") != "found" or not result.get("new_center"):
        return None
    center_x, center_y = result["new_center"]
    return {
        "rect": [center_x - bbox[2] // 2, center_y - bbox[3] // 2, bbox[2], bbox[3]],
        "locator": result,
        "source": "patch",
    }


def window_rect(hwnd: int) -> list[int] | None:
    import ctypes as C
    from ctypes import wintypes as W

    user32 = C.WinDLL("user32", use_last_error=True)
    user32.GetWindowRect.argtypes = [W.HWND, C.POINTER(W.RECT)]
    user32.GetWindowRect.restype = W.BOOL
    rect = W.RECT()
    if not user32.GetWindowRect(hwnd, C.byref(rect)):
        return None
    return [rect.left, rect.top, rect.right, rect.bottom]


def load_plan(path: Path) -> dict:
    plan = read_json(path)
    steps = plan.get("steps")
    target = plan.get("target_hwnd")
    if not isinstance(target, int) or isinstance(target, bool):
        raise ValueError("plan.target_hwnd must be an integer")
    if not isinstance(steps, list) or not 1 <= len(steps) <= 20:
        raise ValueError("plan.steps must contain 1..20 items")
    for index, step in enumerate(steps):
        if not isinstance(step, dict):
            raise ValueError(f"step {index} is not an object")
        if not isinstance(step.get("text"), str) or not step["text"].strip():
            raise ValueError(f"step {index} has no text")
        has_target = isinstance(step.get("target"), str) and bool(step["target"].strip())
        has_patch = isinstance(step.get("reference"), str)
        if not has_target and not has_patch:
            raise ValueError(f"step {index} needs target text or reference+bbox")
        if has_patch:
            bbox = step.get("bbox")
            if (not isinstance(bbox, list) or len(bbox) != 4
                    or not all(isinstance(v, int) and not isinstance(v, bool) for v in bbox)
                    or bbox[2] <= 0 or bbox[3] <= 0):
                raise ValueError(f"step {index} has invalid bbox")
        step.setdefault("id", f"step-{index + 1}")
    return plan


class CoachHost:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.plan = load_plan(Path(args.plan))
        if args.target_hwnd is not None:
            self.plan["target_hwnd"] = args.target_hwnd
        self.steps = self.plan["steps"]
        self.target_hwnd = int(self.plan["target_hwnd"])
        self.locator = args.locator
        self.run_dir = Path(args.run_dir) if args.run_dir else (
            ROOT / "results" / "coach-host" / uuid4().hex)
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.state_path = Path(args.state_file)
        self.event_path = Path(args.event_file)
        self.generation = 0
        self.index = 0
        self.overlay: subprocess.Popen | None = None
        self.located: list[dict] = []
        self._last_event: dict | None = None
        self._closed = False

    def write_state(self, index: int, rect: list[int], *, visible: bool = True,
                    note: str = "") -> None:
        self.generation += 1
        state = {
            "visible": visible,
            "generation": self.generation,
            "observed_at": now_iso(),
            "target_hwnd": self.target_hwnd,
            "window_rect": window_rect(self.target_hwnd),
            "step_index": index,
            "steps": [
                {
                    "id": step.get("id"),
                    "rect": (rect if step_index == index else
                             step.get("last_rect") or step.get("bbox") or [0, 0, 1, 1]),
                    "text": step["text"],
                }
                for step_index, step in enumerate(self.steps)
            ],
            "host": {
                "run_dir": str(self.run_dir),
                "note": note,
                "locator": "bounded_patch_search_v2",
            },
        }
        write_json_atomic(self.state_path, state)
        if self.args.debug:
            print(f"state gen={self.generation} step={index + 1}/{len(self.steps)} "
                  f"rect={rect} visible={visible} note={note}", flush=True)

    def start_overlay(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.event_path.unlink(missing_ok=True)
        log = (self.run_dir / "overlay.log").open("w", encoding="utf-8")
        command = [
            str(self.args.python), "-B", str(self.args.overlay),
            "--state-file", str(self.state_path),
            "--event-file", str(self.event_path),
            "--host-paced",
            "--whale",
            "--no-panel",
            "--max-age", "0",
            "--seconds", str(self.args.seconds),
        ]
        if self.args.exclude_capture:
            command.append("--exclude-capture")
        if self.args.no_sound:
            command.append("--no-sound")
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        self.overlay = subprocess.Popen(
            command, cwd=str(ROOT), stdout=log, stderr=subprocess.STDOUT,
            creationflags=flags)
        if self.args.debug:
            print(f"overlay pid={self.overlay.pid} log={self.run_dir / 'overlay.log'}", flush=True)

    def initial(self) -> bool:
        fresh = capture_screen(self.run_dir, 0)
        located = locate_step(self.steps[0], fresh, locator=self.locator,
                              debug=self.args.debug)
        if not located:
            self.write_state(0, self.steps[0].get("bbox") or [0, 0, 1, 1], visible=False,
                             note="initial target not found")
            return False
        self.steps[0]["last_rect"] = located["rect"]
        self.located.append(located)
        self.write_state(0, located["rect"])
        return True

    def advance(self) -> bool:
        next_index = self.index + 1
        if next_index >= len(self.steps):
            self.write_state(self.index,
                             self.steps[self.index].get("last_rect")
                             or self.steps[self.index].get("bbox") or [0, 0, 1, 1],
                             visible=False, note="finished")
            return False
        fresh = capture_screen(self.run_dir, next_index)
        located = locate_step(self.steps[next_index], fresh, locator=self.locator,
                              debug=self.args.debug)
        if not located:
            self.write_state(next_index, self.steps[next_index].get("bbox") or [0, 0, 1, 1],
                             visible=False, note="target not found; refresh observation")
            return False
        self.index = next_index
        self.steps[next_index]["last_rect"] = located["rect"]
        self.located.append(located)
        self.write_state(next_index, located["rect"])
        return True

    def read_event(self) -> dict | None:
        try:
            stat = self.event_path.stat()
            key = (stat.st_mtime_ns, stat.st_size)
        except OSError:
            return None
        if getattr(self, "_event_key", None) == key:
            return self._last_event
        try:
            event = read_json(self.event_path)
        except (OSError, ValueError):
            return None
        self._event_key = key
        self._last_event = event
        return event

    def run(self) -> int:
        if not self.initial():
            print("coach-host: initial target not found", file=sys.stderr)
            return 2
        self.start_overlay()
        deadline = time.monotonic() + self.args.seconds
        while time.monotonic() < deadline and not self._closed:
            if self.overlay and self.overlay.poll() is not None:
                print("coach-host: overlay exited", file=sys.stderr)
                return 1
            event = self.read_event()
            if event:
                kind = event.get("event")
                if kind == "closed":
                    self._closed = True
                    break
                if kind == "next_requested":
                    if event.get("step_index") != self.index:
                        continue
                    if not self.advance():
                        self._closed = True
                        break
                elif kind == "finish_requested":
                    self.write_state(self.index,
                                     self.steps[self.index].get("last_rect")
                                     or self.steps[self.index].get("bbox") or [0, 0, 1, 1],
                                     visible=False, note="finished")
                    self._closed = True
                    break
            time.sleep(0.12)
        if not self._closed:
            self.write_state(self.index,
                             self.steps[self.index].get("last_rect")
                             or self.steps[self.index].get("bbox") or [0, 0, 1, 1],
                             visible=False, note="host timeout")
        return 0

    def stop(self) -> None:
        if self.overlay and self.overlay.poll() is None:
            self.overlay.terminate()
            try:
                self.overlay.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.overlay.kill()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Host-side display-only Coach loop")
    parser.add_argument("--plan", required=True, help="plan JSON with steps/reference/bbox")
    parser.add_argument("--target-hwnd", type=int, help="override plan target_hwnd")
    parser.add_argument("--state-file", default="runtime/tmp/coach-host-state.json")
    parser.add_argument("--event-file", default="runtime/tmp/coach-host-event.json")
    parser.add_argument("--run-dir", help="directory for fresh captures and overlay log")
    parser.add_argument("--locator", choices=("auto", "ocr", "patch"), default="auto",
                        help="auto tries OCR before patch; patch requires reference+bbox")
    parser.add_argument("--overlay", default=str(DEFAULT_OVERLAY))
    parser.add_argument("--python", default=str(DEFAULT_PYTHON))
    parser.add_argument("--seconds", type=float, default=180)
    parser.add_argument("--no-sound", action="store_true")
    parser.add_argument("--exclude-capture", action="store_true",
                        help="exclude Coach windows from fresh host captures")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args(argv)
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    host = CoachHost(args)
    try:
        return host.run()
    except KeyboardInterrupt:
        return 130
    finally:
        host.stop()


if __name__ == "__main__":
    raise SystemExit(main())
