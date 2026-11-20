"""Deterministic visual template verifier; no model or app-specific selector.

It decodes the saved PNG with a small standard-library decoder (8-bit RGB/RGBA,
non-interlaced) and compares a chosen region with a previously verified
template. A pass means "this region still looks like the verified template",
not that the underlying task succeeded; callers must store the template with
the program/verification evidence.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
from pathlib import Path
import struct
import zlib

import numpy as np

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class ImageDecodeError(ValueError):
    pass


def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def read_png(path: Path | str) -> np.ndarray:
    """Return an HxWx3 uint8 RGB array for an 8-bit non-interlaced PNG."""
    data = Path(path).read_bytes()
    if not data.startswith(PNG_SIGNATURE):
        raise ImageDecodeError("not a PNG")
    position = len(PNG_SIGNATURE)
    header = None
    idat = bytearray()
    while position + 12 <= len(data):
        length = struct.unpack(">I", data[position:position + 4])[0]
        kind = data[position + 4:position + 8]
        body = data[position + 8:position + 8 + length]
        position += 12 + length
        if kind == b"IHDR":
            header = struct.unpack(">IIBBBBB", body)
        elif kind == b"IDAT":
            idat.extend(body)
        elif kind == b"IEND":
            break
    if header is None:
        raise ImageDecodeError("missing IHDR")
    width, height, depth, color_type, compression, filter_method, interlace = header
    if depth != 8 or interlace != 0 or compression != 0 or filter_method != 0:
        raise ImageDecodeError("unsupported PNG format")
    channels = {2: 3, 6: 4}.get(color_type)
    if channels is None:
        raise ImageDecodeError("unsupported PNG color type")
    try:
        raw = zlib.decompress(bytes(idat))
    except zlib.error as error:
        raise ImageDecodeError("invalid PNG data") from error
    stride = width * channels
    if len(raw) != height * (stride + 1):
        raise ImageDecodeError("unexpected PNG payload size")
    pixels = bytearray(width * height * channels)
    previous = bytearray(stride)
    offset = 0
    for y in range(height):
        filter_type = raw[offset]
        offset += 1
        line = bytearray(raw[offset:offset + stride])
        offset += stride
        if filter_type == 1:
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif filter_type == 2:
            for i in range(stride):
                line[i] = (line[i] + previous[i]) & 0xFF
        elif filter_type == 3:
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((left + previous[i]) >> 1)) & 0xFF
        elif filter_type == 4:
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                upper = previous[i]
                upper_left = previous[i - channels] if i >= channels else 0
                line[i] = (line[i] + _paeth(left, upper, upper_left)) & 0xFF
        elif filter_type != 0:
            raise ImageDecodeError("unsupported PNG filter")
        pixels[y * stride:(y + 1) * stride] = line
        previous = line
    array = np.frombuffer(bytes(pixels), dtype=np.uint8).reshape(height, width, channels)
    return np.ascontiguousarray(array[:, :, :3])


@dataclass(frozen=True)
class Region:
    left: int
    top: int
    width: int
    height: int


def _region(value) -> Region:
    if value is None:
        return None
    if isinstance(value, Region):
        return value
    if isinstance(value, dict):
        value = (value.get("left"), value.get("top"), value.get("width"), value.get("height"))
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        raise ValueError("region must be [left, top, width, height]")
    left, top, width, height = value
    if any(type(item) is not int for item in (left, top, width, height)) or width <= 0 or height <= 0:
        raise ValueError("region must contain positive integers")
    return Region(left, top, width, height)


def _crop(image: np.ndarray, region: Region | None) -> np.ndarray:
    if region is None:
        return image
    height, width = image.shape[:2]
    if region.left < 0 or region.top < 0 or region.left + region.width > width \
            or region.top + region.height > height:
        raise ValueError("region is outside the image")
    return image[region.top:region.top + region.height, region.left:region.left + region.width]


def compare_template(template_path: Path | str, after_path: Path | str, *,
                     region=None, tolerance: int = 16, min_similarity: float = 0.98,
                     critical_region=None, critical_tolerance: int = 0,
                     max_critical_changed: float = 0.0,
                     template_region=None, after_region=None,
                     template_critical_region=None, after_critical_region=None) -> dict:
    """Compare a verified template with a post-action screenshot.

    `region` selects the same crop on both images. `template_region` and
    `after_region` may select different origins when the window moved or was
    resized; they must select the same width/height. Critical regions are
    translated separately for the same reason.
    """
    result = {"schema_version": 1, "checker": "visual_template",
              "template": str(template_path), "after": str(after_path),
              "template_sha256": None, "after_sha256": None,
              "region": None, "template_region": None, "after_region": None,
              "tolerance": tolerance, "min_similarity": min_similarity,
              "critical_region": None, "critical_template_region": None,
              "critical_after_region": None,
              "critical_tolerance": critical_tolerance,
              "max_critical_changed": max_critical_changed,
              "status": "unknown", "similarity": None, "changed_ratio": None,
              "critical_changed_ratio": None, "notes": []}
    try:
        if not 0 <= tolerance <= 255 or not 0 <= min_similarity <= 1:
            raise ValueError("invalid tolerance or threshold")
        if not 0 <= critical_tolerance <= 255 or not 0 <= max_critical_changed <= 1:
            raise ValueError("invalid critical threshold")
        template = read_png(template_path)
        after = read_png(after_path)
        result["template_sha256"] = hashlib.sha256(Path(template_path).read_bytes()).hexdigest()
        result["after_sha256"] = hashlib.sha256(Path(after_path).read_bytes()).hexdigest()
        template_box = _region(template_region if template_region is not None else region)
        after_box = _region(after_region if after_region is not None else region)
        if (template_box is None) != (after_box is None):
            raise ValueError("both comparison regions are required")
        if template_box is not None and (template_box.width, template_box.height) != (after_box.width,
                                                                                      after_box.height):
            raise ValueError("template_region and after_region must have equal dimensions")
        template_crop = _crop(template, template_box)
        after_crop = _crop(after, after_box)
        if template_box is not None:
            result["template_region"] = [template_box.left, template_box.top,
                                         template_box.width, template_box.height]
        if after_box is not None:
            result["after_region"] = [after_box.left, after_box.top,
                                      after_box.width, after_box.height]
        if region is not None:
            selected = _region(region)
            result["region"] = [selected.left, selected.top, selected.width, selected.height]
        difference = np.abs(template_crop.astype(np.int16) - after_crop.astype(np.int16)).max(axis=2)
        changed = difference > tolerance
        ratio = float(changed.mean())
        result["changed_ratio"] = round(ratio, 6)
        result["similarity"] = round(1.0 - ratio, 6)
        template_critical = _region(template_critical_region if template_critical_region is not None
                                    else critical_region)
        after_critical = _region(after_critical_region if after_critical_region is not None
                                 else critical_region)
        if (template_critical is None) != (after_critical is None):
            raise ValueError("both critical regions are required")
        if template_critical is not None:
            if (template_critical.width, template_critical.height) != (after_critical.width,
                                                                      after_critical.height):
                raise ValueError("critical regions must have equal dimensions")
            template_critical_crop = _crop(template, template_critical)
            after_critical_crop = _crop(after, after_critical)
            critical_difference = np.abs(template_critical_crop.astype(np.int16)
                                         - after_critical_crop.astype(np.int16)).max(axis=2)
            critical_changed = critical_difference > critical_tolerance
            critical_ratio = float(critical_changed.mean())
            result["critical_template_region"] = [template_critical.left, template_critical.top,
                                                  template_critical.width, template_critical.height]
            result["critical_after_region"] = [after_critical.left, after_critical.top,
                                               after_critical.width, after_critical.height]
            if critical_region is not None:
                selected = _region(critical_region)
                result["critical_region"] = [selected.left, selected.top,
                                             selected.width, selected.height]
            result["critical_changed_ratio"] = round(critical_ratio, 6)
        if result["similarity"] < min_similarity:
            result["status"] = "failed"
        elif result["critical_changed_ratio"] is not None and result["critical_changed_ratio"] > max_critical_changed:
            result["status"] = "failed"
        else:
            result["status"] = "passed"
        if ratio > 0:
            ys, xs = np.nonzero(changed)
            result["changed_bbox"] = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
    except (OSError, ValueError, ImageDecodeError) as error:
        result["notes"].append(type(error).__name__)
    return result
