"""Shared desktop-action contract.

Every action is bound to one already-captured MSS observation and one
window binding. The request carries the observation ID, the exact image size
the locator saw, the physical desktop origin, and the target point in image
pixels. The executor repeats the geometry conversion; it never trusts a
screen coordinate supplied by the caller.

This module is intentionally free of Win32 input calls so the contract can be
tested without touching the desktop.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re
from uuid import uuid4

from .single_click import validate_age
from .vision import Rect, screen_point

ACTION_SCHEMA_VERSION = 1
OBSERVATION_SCHEMA_VERSION = 1
RECEIPT_SCHEMA_VERSION = 1
# Compatibility alias for legacy imports. New code must use the specific version.
SCHEMA_VERSION = ACTION_SCHEMA_VERSION
EXECUTOR_VERSION = "0.5.1"
MAX_IMAGE_PIXELS = 32_000_000
_HEX64 = re.compile(r"^[0-9a-f]{64}$")


class ActionRefused(RuntimeError):
    """A stable, machine-readable refusal reason. Never an automatic retry."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _require(condition, code: str, message: str) -> None:
    if not condition:
        raise ActionRefused(code, message)


@dataclass(frozen=True)
class ObservationRef:
    observation_id: str
    manifest: Path
    image_sha256: str
    image_size: tuple[int, int]
    desktop_origin: tuple[int, int]


@dataclass(frozen=True)
class Target:
    label: str
    center: tuple[int, int]


@dataclass(frozen=True)
class ScrollSpec:
    axis: str
    notches: int


@dataclass(frozen=True)
class KeySpec:
    key: str


@dataclass(frozen=True)
class TextSpec:
    text: str


@dataclass(frozen=True)
class ChordSpec:
    modifiers: tuple[str, ...]
    key: str


@dataclass(frozen=True)
class DragSpec:
    start: tuple[int, int]
    end: tuple[int, int]


@dataclass(frozen=True)
class ActionRequest:
    request_id: str
    operation_id: str
    observation: ObservationRef
    target: Target
    action: str
    button: str
    expected: str
    authorization_grant: str | None = None
    scroll: ScrollSpec | None = None
    key: KeySpec | None = None
    text: TextSpec | None = None
    chord: ChordSpec | None = None
    drag: DragSpec | None = None


@dataclass(frozen=True)
class LoadedObservation:
    folder: Path
    manifest: dict
    binding: dict
    image_path: Path
    capture_bounds: Rect
    image_size: tuple[int, int]
    source_rgb: Path
    window_context: dict | None = None


def _int(value, code: str, message: str) -> int:
    _require(type(value) is int, code, message)
    return value


def _pair(value, code: str, message: str) -> tuple[int, int]:
    _require(isinstance(value, (list, tuple)) and len(value) == 2, code, message)
    return _int(value[0], code, message), _int(value[1], code, message)


def _dict(value, code: str, message: str) -> dict:
    _require(isinstance(value, dict), code, message)
    return value


def _str(value, code: str, message: str, *, nonempty: bool = True) -> str:
    _require(isinstance(value, str) and (value or not nonempty), code, message)
    return value


def _sha(value, code: str, message: str) -> str:
    text = _str(value, code, message).lower()
    _require(bool(_HEX64.match(text)), code, message)
    return text


def _read_json(path: Path, code: str) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        raise ActionRefused(code, f"Cannot read {path.name}") from None
    _require(isinstance(value, dict), code, f"{path.name} must contain an object")
    return value


def _resolve_input(path_value, root: Path) -> Path:
    raw = Path(_str(path_value, "INVALID_REQUEST", "observation.manifest must be a path"))
    candidate = raw if raw.is_absolute() else root / raw
    try:
        return candidate.resolve(strict=True)
    except OSError:
        raise ActionRefused("OBSERVATION_NOT_FOUND", "Observation manifest does not exist") from None


def parse_action_request(payload: dict, root: Path | str) -> ActionRequest:
    """Validate the caller-supplied shape. Filesystem checks happen in load_observation."""
    root = Path(root).resolve()
    payload = _dict(payload, "INVALID_REQUEST", "request must be an object")
    _require(_int(payload.get("schema_version"), "INVALID_REQUEST", "schema_version is required") == ACTION_SCHEMA_VERSION,
             "INVALID_REQUEST", f"schema_version must be {ACTION_SCHEMA_VERSION}")
    request_id = _str(payload.get("request_id"), "INVALID_REQUEST", "request_id is required")
    _require(bool(re.fullmatch(r"[A-Za-z0-9._-]{1,128}", request_id)),
             "INVALID_REQUEST", "request_id contains unsupported characters")
    operation_id = payload.get("operation_id", request_id)
    _require(isinstance(operation_id, str)
             and bool(re.fullmatch(r"[A-Za-z0-9._-]{1,128}", operation_id)),
             "INVALID_REQUEST", "operation_id contains unsupported characters")
    authorization_grant = payload.get("authorization_grant")
    if authorization_grant is not None:
        _require(isinstance(authorization_grant, str)
                 and bool(re.fullmatch(r"[a-f0-9-]{36}", authorization_grant)),
                 "AUTHORIZATION_INVALID", "authorization_grant is invalid")

    observation = _dict(payload.get("observation"), "INVALID_REQUEST", "observation is required")
    observation_id = _str(observation.get("observation_id"), "INVALID_REQUEST", "observation_id is required")
    manifest = _resolve_input(observation.get("manifest"), root)
    _require(manifest.is_relative_to(root / "results" / "vision"),
             "OBSERVATION_PATH_INVALID", "Observation must stay under results/vision")
    image_sha256 = _sha(observation.get("image_sha256"), "INVALID_REQUEST", "image_sha256 is required")
    size_obj = _dict(observation.get("image_size"), "INVALID_REQUEST", "image_size is required")
    size = (_int(size_obj.get("width"), "INVALID_REQUEST", "image_size.width is required"),
            _int(size_obj.get("height"), "INVALID_REQUEST", "image_size.height is required"))
    origin_obj = _dict(observation.get("desktop_origin"), "INVALID_REQUEST", "desktop_origin is required")
    origin = (_int(origin_obj.get("left"), "INVALID_REQUEST", "desktop_origin.left is required"),
              _int(origin_obj.get("top"), "INVALID_REQUEST", "desktop_origin.top is required"))
    _require(0 < size[0] <= MAX_IMAGE_PIXELS and 0 < size[1] <= MAX_IMAGE_PIXELS
             and size[0] * size[1] <= MAX_IMAGE_PIXELS,
             "INVALID_REQUEST", "image_size is invalid or too large")

    target = _dict(payload.get("target"), "INVALID_REQUEST", "target is required")
    label = _str(target.get("label"), "INVALID_REQUEST", "target.label is required")
    center = _pair(target.get("center"), "INVALID_REQUEST", "target.center must be [x, y]")
    _require(0 <= center[0] < size[0] and 0 <= center[1] < size[1],
             "TARGET_OUT_OF_IMAGE", "Target point is outside the locator image")

    action = _dict(payload.get("action"), "INVALID_REQUEST", "action is required")
    action_type = _str(action.get("type"), "INVALID_REQUEST", "action.type is required")
    button = _str(action.get("button", "left"), "INVALID_REQUEST", "action.button is invalid")
    scroll = None
    key = None
    text = None
    chord = None
    drag = None
    if action_type == "click":
        _require(button == "left", "ACTION_NOT_SUPPORTED",
                 "Only a left click is supported by this executor version")
    elif action_type == "scroll":
        _require("button" not in action, "INVALID_REQUEST", "scroll action must not carry a button")
        axis = _str(action.get("axis"), "INVALID_REQUEST", "scroll.axis is required")
        notches = _int(action.get("notches"), "INVALID_REQUEST", "scroll.notches is required")
        _require(axis == "vertical", "ACTION_NOT_SUPPORTED", "Only vertical scroll is supported")
        _require(notches != 0 and -3 <= notches <= 3, "INVALID_REQUEST",
                 "scroll.notches must be -3..3 and non-zero")
        scroll = ScrollSpec(axis=axis, notches=notches)
    elif action_type == "key":
        _require("button" not in action, "INVALID_REQUEST", "key action must not carry a button")
        key_name = _str(action.get("key"), "INVALID_REQUEST", "key.key is required")
        _require(key_name in {"Left", "Right", "Up", "Down", "Home", "End"}, "ACTION_NOT_SUPPORTED",
                 "Only a short navigation key is supported")
        key = KeySpec(key=key_name)
    elif action_type == "text":
        _require("button" not in action, "INVALID_REQUEST", "text action must not carry a button")
        text_value = _str(action.get("text"), "INVALID_REQUEST", "text.text is required")
        _require(1 <= len(text_value) <= 16, "TEXT_LIMIT",
                 "Text insertion is limited to 16 Unicode scalars")
        _require(not any(ord(char) < 0x20 or ord(char) == 0x7f for char in text_value),
                 "TEXT_CONTROL_CHAR", "CR/LF/Tab and control characters are not accepted")
        try:
            encoded = text_value.encode("utf-16-le", "strict")
        except UnicodeEncodeError:
            raise ActionRefused("TEXT_ENCODING", "Text contains invalid Unicode") from None
        _require(len(encoded) // 2 <= 32, "TEXT_LIMIT", "UTF-16 representation is too long")
        text = TextSpec(text=text_value)
    elif action_type == "chord":
        _require("button" not in action and "text" not in action,
                 "INVALID_REQUEST", "chord action must not carry button or text")
        modifiers = action.get("modifiers")
        _require(isinstance(modifiers, list) and len(modifiers) == 1 and modifiers[0] == "ctrl",
                 "ACTION_NOT_SUPPORTED", "Only Ctrl+Left/Right is supported")
        chord_key = _str(action.get("key"), "INVALID_REQUEST", "chord.key is required")
        _require(chord_key in {"Left", "Right"}, "ACTION_NOT_SUPPORTED",
                 "Only Ctrl+Left/Right is supported")
        chord = ChordSpec(modifiers=("ctrl",), key=chord_key)
    elif action_type == "drag":
        _require("button" not in action and "text" not in action and "modifiers" not in action,
                 "INVALID_REQUEST", "drag action must not carry button, text or modifiers")
        end = _pair(action.get("end"), "INVALID_REQUEST", "drag.end must be [x, y]")
        _require(0 <= end[0] < size[0] and 0 <= end[1] < size[1],
                 "TARGET_OUT_OF_IMAGE", "Drag end is outside the locator image")
        _require(abs(end[0] - center[0]) + abs(end[1] - center[1]) >= 8,
                 "DRAG_TOO_SHORT", "Drag start and end are too close")
        drag = DragSpec(start=center, end=end)
    else:
        raise ActionRefused("ACTION_NOT_SUPPORTED",
                            "Only click, scroll, navigation key, text, Ctrl+Left/Right and drag are supported")
    expected = _dict(payload.get("expected", {}), "INVALID_REQUEST", "expected must be an object")
    description = _str(expected.get("description", ""), "INVALID_REQUEST", "expected.description must be text",
                       nonempty=False)
    return ActionRequest(request_id=request_id, operation_id=operation_id,
                         observation=ObservationRef(observation_id, manifest, image_sha256, size, origin),
                         target=Target(label, center), action=action_type, button=button,
                         expected=description, authorization_grant=authorization_grant,
                         scroll=scroll, key=key, text=text, chord=chord, drag=drag)


def load_observation(request: ActionRequest, root: Path | str, *,
                     now: datetime | None = None) -> LoadedObservation:
    """Load and cross-check the manifest, binding and pixel baseline.

    The screenshot is never resized here. A future resized attachment must be
    represented explicitly; silently mapping a resized image is refused.
    """
    root = Path(root).resolve()
    ref = request.observation
    folder = ref.manifest.parent
    manifest = _read_json(ref.manifest, "OBSERVATION_INVALID")
    _require(manifest.get("schema_version") == OBSERVATION_SCHEMA_VERSION, "OBSERVATION_INVALID",
             "Observation schema_version is unsupported")
    _require(manifest.get("observation_id") == ref.observation_id, "OBSERVATION_ID_MISMATCH",
             "Observation ID does not match the manifest")
    _require(manifest.get("coordinate_space") == "physical_desktop_pixels",
             "COORDINATE_SPACE_INVALID", "Observation is not in physical desktop pixels")
    image = _dict(manifest.get("image"), "OBSERVATION_INVALID", "Observation image is missing")
    _require(image.get("resized") is False, "IMAGE_RESIZED",
             "Resized images are not accepted by this executor version")
    image_path = Path(_str(image.get("path"), "OBSERVATION_INVALID", "image.path is missing"))
    try:
        image_path = image_path.resolve(strict=True)
    except OSError:
        raise ActionRefused("IMAGE_NOT_FOUND", "Observation image does not exist") from None
    _require(image_path.is_relative_to(folder), "IMAGE_PATH_INVALID",
             "Observation image must stay in its observation folder")
    _require(_int(image.get("width"), "OBSERVATION_INVALID", "image.width is missing") == ref.image_size[0]
             and _int(image.get("height"), "OBSERVATION_INVALID", "image.height is missing") == ref.image_size[1],
             "IMAGE_SIZE_MISMATCH", "Request image_size differs from the captured image")
    actual_sha = hashlib.sha256(image_path.read_bytes()).hexdigest()
    _require(actual_sha == ref.image_sha256, "IMAGE_HASH_MISMATCH",
             "Request image_sha256 differs from the image bytes")
    _require(actual_sha == _sha(image.get("sha256"), "OBSERVATION_INVALID", "image.sha256 is missing"),
             "IMAGE_HASH_MISMATCH", "Observation manifest hash differs from the image bytes")

    bounds_obj = _dict(manifest.get("capture_bounds"), "OBSERVATION_INVALID", "capture_bounds is missing")
    try:
        bounds = Rect(**bounds_obj)
    except (TypeError, ValueError):
        raise ActionRefused("OBSERVATION_INVALID", "capture_bounds is invalid") from None
    _require((bounds.left, bounds.top) == ref.desktop_origin, "ORIGIN_MISMATCH",
             "Request desktop_origin differs from capture_bounds")
    _require((bounds.width, bounds.height) == ref.image_size, "ORIGIN_MISMATCH",
             "Unscaled observation must have capture size equal to image size")
    try:
        validate_age(_str(manifest.get("captured_at"), "OBSERVATION_INVALID", "captured_at is missing"),
                     now)
    except (ValueError, TypeError):
        raise ActionRefused("OBSERVATION_EXPIRED", "Observation is stale; take a new screenshot") from None

    binding_path = folder / "click-binding.json"
    _require(binding_path.is_file(), "BINDING_MISSING", "Observation has no window binding")
    binding = _read_json(binding_path, "BINDING_INVALID")
    _require(binding.get("source_sha256") == actual_sha, "BINDING_MISMATCH",
             "Binding hash differs from the observation image")
    window = _dict(binding.get("window"), "BINDING_INVALID", "Binding window is missing")
    for key in ("hwnd", "pid"):
        _int(window.get(key), "BINDING_INVALID", f"Binding window.{key} is missing")
    _require(isinstance(window.get("class_name"), str) and isinstance(window.get("title"), str),
             "BINDING_INVALID", "Binding window identity is incomplete")
    rect = window.get("rect")
    _require(isinstance(rect, list) and len(rect) == 4 and all(type(v) is int for v in rect),
             "BINDING_INVALID", "Binding window.rect is invalid")
    _int(binding.get("foreground"), "BINDING_INVALID", "Binding foreground is missing")
    _int(binding.get("last_input_tick"), "BINDING_INVALID", "Binding last_input_tick is missing")
    rgb_sha = _sha(binding.get("rgb_sha256"), "BINDING_INVALID", "Binding rgb_sha256 is missing")
    observation_context = manifest.get("window_context")
    binding_context = binding.get("window_context")
    if observation_context is not None or binding_context is not None:
        _require(isinstance(observation_context, dict) and isinstance(binding_context, dict),
                 "WINDOW_CONTEXT_INVALID", "Observation and binding must both carry window_context")
        _require(observation_context.get("geometry", {}).get("geometry_revision")
                 == binding_context.get("geometry", {}).get("geometry_revision"),
                 "WINDOW_CONTEXT_MISMATCH", "Observation and binding geometry revisions differ")
        _require(observation_context.get("identity") == binding_context.get("identity"),
                 "WINDOW_CONTEXT_MISMATCH", "Observation and binding window identities differ")
        window_context = observation_context
    else:
        window_context = None

    source_rgb = folder / "source.rgb"
    _require(source_rgb.is_file(), "SOURCE_RGB_MISSING", "Observation pixel baseline is missing")
    _require(hashlib.sha256(source_rgb.read_bytes()).hexdigest() == rgb_sha, "SOURCE_RGB_MISMATCH",
             "Observation pixel baseline changed")
    return LoadedObservation(folder=folder, manifest=manifest, binding=binding, image_path=image_path,
                             capture_bounds=bounds, image_size=ref.image_size, source_rgb=source_rgb,
                             window_context=window_context)


def target_screen_point(loaded: LoadedObservation, target: Target) -> tuple[int, int]:
    """Convert attachment pixels to physical desktop pixels using the contract."""
    return screen_point(loaded.capture_bounds, loaded.image_size, *target.center)


def action_digest(request: ActionRequest) -> str:
    """Canonical digest for operation deduplication; never includes screen pixels."""
    value = {
        "action": request.action, "button": request.button,
        "authorization_grant": request.authorization_grant,
        "expected": request.expected,
        "observation": {"observation_id": request.observation.observation_id,
                         "image_sha256": request.observation.image_sha256,
                         "image_size": list(request.observation.image_size),
                         "desktop_origin": list(request.observation.desktop_origin)},
        "target": {"label": request.target.label, "center": list(request.target.center)},
    }
    if request.scroll is not None:
        value["scroll"] = {"axis": request.scroll.axis, "notches": request.scroll.notches}
    if request.key is not None:
        value["key"] = {"key": request.key.key}
    if request.text is not None:
        # Digest only; the text body is not persisted in the operation journal.
        value["text"] = hashlib.sha256(request.text.text.encode("utf-16-le", "strict")).hexdigest()
    if request.chord is not None:
        value["chord"] = {"modifiers": list(request.chord.modifiers), "key": request.chord.key}
    if request.drag is not None:
        value["drag"] = {"start": list(request.drag.start), "end": list(request.drag.end)}
    encoded = json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def build_action_request(manifest_path: Path | str, label: str, center, expected: str = "",
                         *, request_id: str | None = None, operation_id: str | None = None,
                         root: Path | str | None = None,
                         grant_id: str | None = None) -> dict:
    """Build a request from an existing observation manifest.

    Coordinates remain image pixels. Callers cannot supply a screen coordinate:
    the executor derives it from the observation origin and size.
    """
    path = Path(manifest_path)
    manifest = _read_json(path, "OBSERVATION_INVALID")
    image = _dict(manifest.get("image"), "OBSERVATION_INVALID", "Observation image is missing")
    bounds = _dict(manifest.get("capture_bounds"), "OBSERVATION_INVALID", "capture_bounds is missing")
    size = (int(image["width"]), int(image["height"]))
    center = list(center)
    _require(isinstance(center, (list, tuple)) and len(center) == 2
             and all(type(v) is int for v in center), "INVALID_REQUEST", "center must be [x, y]")
    _require(0 <= center[0] < size[0] and 0 <= center[1] < size[1],
             "TARGET_OUT_OF_IMAGE", "Target point is outside the observation image")
    root_path = Path(root).resolve() if root is not None else path.resolve().parents[3]
    try:
        relative = path.resolve().relative_to(root_path)
    except ValueError:
        relative = path
    request_id = request_id or str(uuid4())
    return {
        "schema_version": ACTION_SCHEMA_VERSION,
        "request_id": request_id,
        "operation_id": operation_id or request_id,
        "authorization_grant": grant_id,
        "observation": {
            "observation_id": manifest["observation_id"],
            "manifest": str(relative),
            "image_sha256": image["sha256"],
            "image_size": {"width": size[0], "height": size[1]},
            "desktop_origin": {"left": int(bounds["left"]), "top": int(bounds["top"])},
        },
        "target": {"label": label, "center": center},
        "action": {"type": "click", "button": "left"},
        "expected": {"description": expected},
    }
