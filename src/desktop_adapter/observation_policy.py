"""Pure observation policy for local change detection and bounded routing.

This module never captures the screen, sends input, calls a model or grants
authority. It only compares already-captured RGB frames and reports geometry
changes, exact pixel changes, changed blocks and critical-region checks. The
live path remains opt-in; callers must not treat an `unchanged` result as task
success.
"""
from __future__ import annotations

from dataclasses import dataclass
import time

SCHEMA_VERSION = 1
SUPPORTED_MODES = {"off", "shadow", "on"}


class ObservationPolicyError(ValueError):
    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code
        self.message = message or code


def geometry_of(observation: dict) -> dict:
    """Return the parts of a manifest that must match before comparing pixels."""
    if not isinstance(observation, dict):
        raise ObservationPolicyError("INVALID_OBSERVATION")
    image = observation.get("image") or {}
    window = observation.get("window") if isinstance(observation.get("window"), dict) else None
    window_identity = None if window is None else {
        "hwnd": window.get("hwnd"), "pid": window.get("pid"),
        "class_name": window.get("class_name"),
    }
    context = observation.get("window_context")
    context_geometry = None
    if isinstance(context, dict) and isinstance(context.get("geometry"), dict):
        geometry = context["geometry"]
        context_geometry = {
            "client_rect_screen_px": geometry.get("client_rect_screen_px"),
            "target_window_dpi": geometry.get("target_window_dpi"),
            "target_dpi_awareness": geometry.get("target_dpi_awareness"),
            "geometry_revision": geometry.get("geometry_revision"),
        }
    result = {
        "monitor_index": observation.get("monitor_index"),
        "monitor_bounds": _rect(observation.get("monitor_bounds")),
        "capture_bounds": _rect(observation.get("capture_bounds")),
        "coordinate_space": observation.get("coordinate_space"),
        "window_identity": window_identity,
        "window_context_geometry": context_geometry,
        "width": image.get("width"),
        "height": image.get("height"),
        "resized": image.get("resized"),
    }
    if result["width"] is None or result["height"] is None:
        raise ObservationPolicyError("INVALID_OBSERVATION")
    return result


def _rect(value):
    if not isinstance(value, dict):
        return value
    return {key: value.get(key) for key in ("left", "top", "width", "height")}


def check_context(previous: dict, current: dict) -> dict:
    """Compare geometry before any pixel difference is trusted."""
    before = geometry_of(previous)
    after = geometry_of(current)
    reasons = []
    for key in ("monitor_index", "monitor_bounds", "capture_bounds", "coordinate_space",
                "window_identity", "window_context_geometry", "width", "height", "resized"):
        if before.get(key) != after.get(key):
            reasons.append(key)
    if reasons:
        return {"schema_version": SCHEMA_VERSION, "status": "context_changed",
                "reasons": reasons, "previous": before, "current": after}
    return {"schema_version": SCHEMA_VERSION, "status": "same_context",
            "previous": before, "current": after}


def _rect_list(value):
    if value is None:
        return []
    if not isinstance(value, (list, tuple)):
        raise ObservationPolicyError("INVALID_CRITICAL_REGION")
    result = []
    for item in value:
        if isinstance(item, dict):
            item = (item.get("x"), item.get("y"), item.get("width"), item.get("height"))
        if (not isinstance(item, (list, tuple)) or len(item) != 4
                or any(type(v) is not int for v in item)
                or item[2] <= 0 or item[3] <= 0):
            raise ObservationPolicyError("INVALID_CRITICAL_REGION")
        result.append(tuple(item))
    return result


def analyze_rgb(previous: bytes, current: bytes, width: int, height: int, *,
                block_size: int = 32, max_regions: int = 10,
                critical_regions=(), tolerance: int = 0) -> dict:
    """Exact RGB comparison with block aggregation.

    `unchanged` means only that this sampled frame has identical pixels. It does
    not mean the application state is unchanged or that a click succeeded.
    """
    for name, value in (("width", width), ("height", height), ("block_size", block_size),
                        ("max_regions", max_regions)):
        if type(value) is not int or value < 1:
            raise ObservationPolicyError(f"INVALID_{name.upper()}")
    if type(tolerance) is not int or not 0 <= tolerance <= 255:
        raise ObservationPolicyError("INVALID_TOLERANCE")
    if block_size > 256 or max_regions > 1000:
        raise ObservationPolicyError("INVALID_POLICY_LIMIT")
    expected = width * height * 3
    if not isinstance(previous, (bytes, bytearray)) or not isinstance(current, (bytes, bytearray)):
        raise ObservationPolicyError("INVALID_RGB")
    if len(previous) != expected or len(current) != expected:
        raise ObservationPolicyError("INVALID_RGB_LENGTH")
    critical = _rect_list(critical_regions)
    for x, y, w, h in critical:
        if x < 0 or y < 0 or x + w > width or y + h > height:
            raise ObservationPolicyError("CRITICAL_REGION_OUTSIDE_IMAGE")

    started = time.perf_counter()
    blocks = {}
    changed_pixels = 0
    critical_stats = [{"rect": [x, y, w, h], "changed_pixels": 0} for x, y, w, h in critical]
    for y in range(height):
        row = y * width
        for x in range(width):
            index = (row + x) * 3
            if tolerance == 0:
                changed = previous[index:index + 3] != current[index:index + 3]
            else:
                changed = (abs(previous[index] - current[index]) > tolerance
                           or abs(previous[index + 1] - current[index + 1]) > tolerance
                           or abs(previous[index + 2] - current[index + 2]) > tolerance)
            if not changed:
                continue
            changed_pixels += 1
            key = (x // block_size, y // block_size)
            blocks[key] = blocks.get(key, 0) + 1
            for stat, (cx, cy, cw, ch) in zip(critical_stats, critical):
                if cx <= x < cx + cw and cy <= y < cy + ch:
                    stat["changed_pixels"] += 1

    if changed_pixels == 0:
        return {
            "schema_version": SCHEMA_VERSION, "status": "unchanged",
            "width": width, "height": height, "changed_pixels": 0,
            "changed_ratio": 0.0, "changed_blocks": [], "omitted_regions": 0,
            "omitted_changed_pixels": 0, "critical_regions": critical_stats,
            "elapsed_ms": round((time.perf_counter() - started) * 1000, 2),
            "route_reason": "unchanged_local_sample_only",
            "limitations": ["Identical sampled pixels do not prove application state or task success."],
        }

    ordered = sorted(blocks.items(), key=lambda item: (-item[1], item[0][1], item[0][0]))
    shown = ordered[:max_regions]
    changed_blocks = []
    for (bx, by), count in shown:
        x, y = bx * block_size, by * block_size
        changed_blocks.append({"x": x, "y": y,
                               "width": min(block_size, width - x),
                               "height": min(block_size, height - y),
                               "changed_pixels": count})
    omitted = ordered[max_regions:]
    return {
        "schema_version": SCHEMA_VERSION, "status": "changed",
        "width": width, "height": height, "changed_pixels": changed_pixels,
        "changed_ratio": round(changed_pixels / (width * height), 6),
        "changed_blocks": changed_blocks,
        "omitted_regions": len(omitted),
        "omitted_changed_pixels": sum(count for _, count in omitted),
        "critical_regions": critical_stats,
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 2),
        "route_reason": "local_change_regions_are_candidates_not_targets",
        "limitations": ["Changed pixels are candidates for inspection, not click targets or task success."],
    }


def compare_observations(previous_manifest: dict, current_manifest: dict,
                         previous_rgb: bytes, current_rgb: bytes, **kwargs) -> dict:
    context = check_context(previous_manifest, current_manifest)
    if context["status"] != "same_context":
        return context
    image = current_manifest.get("image") or {}
    return {**context, **analyze_rgb(previous_rgb, current_rgb, image["width"], image["height"], **kwargs)}


class ShadowTracker:
    """Stateful shadow comparison. It never calls input or changes routing."""

    def __init__(self, **policy):
        self.policy = policy
        self.last = {}

    @staticmethod
    def _key(observation):
        geometry = geometry_of(observation)
        return (geometry["monitor_index"], geometry["coordinate_space"])

    def observe(self, observation: dict, rgb: bytes) -> dict:
        key = self._key(observation)
        previous = self.last.get(key)
        self.last[key] = (observation, rgb)
        if previous is None:
            return {"schema_version": SCHEMA_VERSION, "status": "baseline",
                    "route_reason": "no_previous_frame_for_context",
                    "limitations": ["Baseline does not imply the next frame will be stable."]}
        result = compare_observations(previous[0], observation, previous[1], rgb, **self.policy)
        return result

