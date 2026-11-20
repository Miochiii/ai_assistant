"""Read-only pixel observations; no application-specific discovery or input APIs.

MSS implements capture. Inspired by Windows-MCP's MSS backend and Orb's explicit
physical-pixel coordinate contract; no upstream source is copied here.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
import hashlib
import math
from pathlib import Path
from time import perf_counter
from uuid import uuid4

from assistant_core.events import now

MAX_PIXELS = 32_000_000


@dataclass(frozen=True)
class Rect:
    left: int
    top: int
    width: int
    height: int

    def __post_init__(self):
        if any(type(v) is not int for v in asdict(self).values()):
            raise ValueError("rectangle values must be integers")
        if self.width <= 0 or self.height <= 0 or self.width * self.height > MAX_PIXELS:
            raise ValueError("invalid or oversized capture rectangle")

    def contains(self, other: Rect) -> bool:
        return (self.left <= other.left and self.top <= other.top
                and other.left + other.width <= self.left + self.width
                and other.top + other.height <= self.top + self.height)


def screen_point(rect: Rect, image_size: tuple[int, int], x: float, y: float) -> tuple[int, int]:
    """Map an unrotated image point to physical desktop pixels. Never inject input.

    Width/height must describe the exact image shown to the locator, including
    any resizing. Right/bottom boundaries are exclusive, matching pixel indices.
    """
    w, h = image_size
    if type(w) is not int or type(h) is not int or w <= 0 or h <= 0:
        raise ValueError("invalid image dimensions")
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in (x, y)):
        raise ValueError("coordinates must be finite numbers")
    if not (0 <= x < w and 0 <= y < h):
        raise ValueError("point outside observed image")
    return rect.left + math.floor(x * rect.width / w), rect.top + math.floor(y * rect.height / h)


def capture(directory: Path, *, monitor: int = 1, region: Rect | None = None, retain_rgb: bool = False) -> dict:
    from mss import MSS, __version__
    from mss.tools import to_png

    start = perf_counter()
    observed_at = now()
    with MSS() as sct:
        monitors = sct.monitors
        if type(monitor) is not int or not 1 <= monitor < len(monitors):
            raise ValueError("select one actual monitor using the monitors command")
        display = Rect(**{k: int(monitors[monitor][k]) for k in ('left', 'top', 'width', 'height')})
        bounds = display if region is None else region
        if not display.contains(bounds):
            raise ValueError("capture region must lie within the selected monitor")
        shot = sct.grab(asdict(bounds))
        if (shot.width, shot.height) != (bounds.width, bounds.height):
            raise RuntimeError("capture dimensions differ from requested physical bounds")
        rgb = shot.rgb
        grabbed = perf_counter()
        png = to_png(rgb, (shot.width, shot.height))
        encoded = perf_counter()
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / 'screen.png'
    # One run owns one directory; never overwrite an earlier observation.
    with path.open('xb') as f:
        f.write(png)
    if retain_rgb:
        with (directory / 'source.rgb').open('xb') as f:
            f.write(rgb)
    persisted = perf_counter()
    timings = {
        'capture_ms': round((grabbed - start) * 1000, 2),
        'encode_ms': round((encoded - grabbed) * 1000, 2),
        'persist_ms': round((persisted - encoded) * 1000, 2),
        'total_ms': round((persisted - start) * 1000, 2),
    }
    return {
        'schema_version': 1, 'observation_id': str(uuid4()),
        'observed_at': observed_at, 'captured_at': now(),
        'backend': 'mss', 'backend_version': __version__,
        'monitor_index': monitor, 'monitor_bounds': asdict(display),
        'capture_bounds': asdict(bounds), 'coordinate_space': 'physical_desktop_pixels',
        'image': {'path': str(path.resolve()), 'width': shot.width, 'height': shot.height,
                  'sha256': hashlib.sha256(png).hexdigest(), 'resized': False},
        'elapsed_ms': timings['total_ms'], 'timings': timings,
        'diagnostics': ['UNIFORM_IMAGE_REQUIRES_REVIEW'] if min(rgb) == max(rgb) else [],
        'read_only': True, 'actionable': False, 'recognition_status': 'not_run',
        'outcome': 'unknown', 'model_calls': 0,
        'limitations': ['Visible pixels only; occluded content is not reconstructed.',
                       'A screenshot does not establish application identity or task success.',
                       'Coordinate mapping is geometric, not authorization or a live action target.'],
    }
