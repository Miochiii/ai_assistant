"""Bounded target-patch relocation.

The reference patch is extracted from the stored basis image around the target
point. The fresh image may have a different canvas size, origin or scale; the
search is always bounded by a caller-provided hint and a finite scale list.
One clearly separated candidate is required, otherwise the result is
not_found/ambiguous. This module never sends input.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

import numpy as np

from .verify import ImageDecodeError, read_png

MAX_SCALES = 8
MAX_CANDIDATES = 20_000


def _bounds(center, image_shape, patch):
    height, width = image_shape[:2]
    patch_w, patch_h = patch
    if patch_w <= 0 or patch_h <= 0 or patch_w > width or patch_h > height:
        raise ValueError("patch does not fit the image")
    x, y = int(center[0]), int(center[1])
    left = min(max(0, x - patch_w // 2), width - patch_w)
    top = min(max(0, y - patch_h // 2), height - patch_h)
    return left, top, patch_w, patch_h


def _edge_map(image: np.ndarray) -> np.ndarray:
    gray = image.astype(np.float32).mean(axis=2)
    gy, gx = np.gradient(gray)
    return np.hypot(gx, gy)


def _resize_nearest(image: np.ndarray, width: int, height: int) -> np.ndarray:
    if width <= 0 or height <= 0:
        raise ValueError("scaled patch is empty")
    source_h, source_w = image.shape[:2]
    ys = np.minimum((np.arange(height) * source_h / height).astype(np.int64), source_h - 1)
    xs = np.minimum((np.arange(width) * source_w / width).astype(np.int64), source_w - 1)
    return image[np.ix_(ys, xs)]


def _score(template: np.ndarray, fresh: np.ndarray, left: int, top: int, tolerance: int) -> float:
    patch_h, patch_w = template.shape[:2]
    candidate = fresh[top:top + patch_h, left:left + patch_w]
    changed = np.abs(template.astype(np.int16) - candidate.astype(np.int16)).max(axis=2) > tolerance
    return 1.0 - float(changed.mean())


def _search_range(hint: float, radius: int, limit: int) -> tuple[int, int]:
    low = max(0, int(round(hint)) - radius)
    high = min(limit, int(round(hint)) + radius)
    return low, high


def _separated_second(candidates, best, min_separation: int):
    for score, left, top, scale, center_x, center_y in candidates[1:]:
        if max(abs(center_x - best[4]), abs(center_y - best[5])) > min_separation:
            return score
    return 0.0


def locate_patch(basis_path: Path | str, fresh_path: Path | str, *, target_center,
                 patch_size=(64, 40), search_radius: int = 64, stride: int = 4,
                 tolerance: int = 16, min_similarity: float = 0.98,
                 min_margin: float = 0.005, min_separation: int = 32,
                 edge_threshold: float = 40.0, edge_min_similarity: float = 0.7,
                 scales=(1.0,), search_center=None) -> dict:
    result = {"schema_version": 1, "locator": "bounded_patch_search_v2",
              "basis": str(basis_path), "fresh": str(fresh_path),
              "basis_sha256": None, "fresh_sha256": None,
              "target_center": list(target_center), "patch_size": list(patch_size),
              "search_radius": search_radius, "stride": stride, "status": "unknown",
              "new_center": None, "similarity": None, "second_similarity": None,
              "margin": None, "candidates": 0, "method": "raw_patch",
              "scale": None, "scales": list(scales),
              "search_center": list(search_center) if search_center is not None else None,
              "edge_threshold": edge_threshold, "edge_similarity": None,
              "notes": []}
    try:
        if type(search_radius) is not int or search_radius < 0 or search_radius > 512:
            raise ValueError("search_radius must be 0..512")
        if type(stride) is not int or stride < 1 or stride > 64:
            raise ValueError("stride must be 1..64")
        if len(patch_size) != 2 or any(type(v) is not int or v <= 0 for v in patch_size):
            raise ValueError("patch_size must be [width, height]")
        if not 0 <= tolerance <= 255 or not 0 <= min_similarity <= 1 or not 0 <= min_margin <= 1:
            raise ValueError("invalid tolerance/thresholds")
        if not isinstance(scales, (list, tuple)) or not 1 <= len(scales) <= MAX_SCALES:
            raise ValueError("scales must contain 1..8 entries")
        clean_scales = []
        for scale in scales:
            if isinstance(scale, bool) or not isinstance(scale, (int, float)) \
                    or not 0.5 <= float(scale) <= 3.0:
                raise ValueError("scale must be 0.5..3.0")
            clean_scales.append(float(scale))
        if len(set(clean_scales)) != len(clean_scales):
            raise ValueError("scales must be unique")
        if search_center is not None:
            if len(search_center) != 2 or any(type(v) is not int for v in search_center):
                raise ValueError("search_center must be [x, y] integers")
        basis = read_png(basis_path)
        fresh = read_png(fresh_path)
        result["basis_sha256"] = hashlib.sha256(Path(basis_path).read_bytes()).hexdigest()
        result["fresh_sha256"] = hashlib.sha256(Path(fresh_path).read_bytes()).hexdigest()
        basis_left, basis_top, base_w, base_h = _bounds(target_center, basis.shape, patch_size)
        target_x, target_y = int(target_center[0]), int(target_center[1])
        target_local_x = target_x - basis_left
        target_local_y = target_y - basis_top
        template_base = basis[basis_top:basis_top + base_h, basis_left:basis_left + base_w]
        fresh_h, fresh_w = fresh.shape[:2]

        raw_candidates = []
        raw_limit_exceeded = False
        for scale in clean_scales:
            patch_w = max(1, int(round(base_w * scale)))
            patch_h = max(1, int(round(base_h * scale)))
            if patch_w > fresh_w or patch_h > fresh_h:
                continue
            template = _resize_nearest(template_base, patch_w, patch_h)
            local_x = (target_local_x + 0.5) * scale - 0.5
            local_y = (target_local_y + 0.5) * scale - 0.5
            if search_center is None:
                hint_x, hint_y = target_x * scale, target_y * scale
            else:
                hint_x, hint_y = search_center
            desired_left = hint_x - local_x
            desired_top = hint_y - local_y
            left_min, left_max = _search_range(desired_left, search_radius, fresh_w - patch_w)
            top_min, top_max = _search_range(desired_top, search_radius, fresh_h - patch_h)
            if left_min > left_max or top_min > top_max:
                continue
            initial_left = min(max(0, int(round(desired_left))), fresh_w - patch_w)
            initial_top = min(max(0, int(round(desired_top))), fresh_h - patch_h)
            positions = [(initial_left, initial_top)]
            for candidate_top in range(top_min, top_max + 1, stride):
                for candidate_left in range(left_min, left_max + 1, stride):
                    if candidate_left != initial_left or candidate_top != initial_top:
                        positions.append((candidate_left, candidate_top))
            for candidate_left, candidate_top in positions:
                if len(raw_candidates) >= MAX_CANDIDATES:
                    raw_limit_exceeded = True
                    break
                score = _score(template, fresh, candidate_left, candidate_top, tolerance)
                center_x = candidate_left + int(round(local_x))
                center_y = candidate_top + int(round(local_y))
                raw_candidates.append((score, candidate_left, candidate_top, scale, center_x, center_y))
            if raw_limit_exceeded:
                break
        if raw_limit_exceeded:
            result.update(status="unsupported", notes=["CANDIDATE_LIMIT"])
            return result
        result["candidates"] = len(raw_candidates)
        if not raw_candidates:
            result["status"] = "not_found"
            return result
        raw_candidates.sort(key=lambda item: item[0], reverse=True)
        best = raw_candidates[0]
        second = _separated_second(raw_candidates, best, min_separation)
        result.update(similarity=round(best[0], 6), second_similarity=round(second, 6),
                      margin=round(best[0] - second, 6), scale=best[3],
                      method="raw_patch")
        if best[0] >= min_similarity and best[0] - second >= min_margin:
            result.update(status="found", new_center=[best[4], best[5]])
            return result

        # Edge fallback for appearance changes such as a hovered menu item. It
        # is intentionally limited to the base scale; multi-scale evidence is
        # already covered by the finite raw candidates above.
        if 1.0 not in clean_scales:
            result["status"] = "not_found"
            return result
        template_edges = _edge_map(template_base)
        template_mask = template_edges > edge_threshold
        if template_mask.mean() < 0.01:
            result["status"] = "not_found"
            return result
        hint_x, hint_y = (target_x, target_y) if search_center is None else search_center
        desired_left = hint_x - target_local_x
        desired_top = hint_y - target_local_y
        left_min, left_max = _search_range(desired_left, search_radius, fresh_w - base_w)
        top_min, top_max = _search_range(desired_top, search_radius, fresh_h - base_h)
        if left_min > left_max or top_min > top_max:
            result["status"] = "not_found"
            return result
        edge_candidates = []
        initial_left = min(max(0, int(round(desired_left))), fresh_w - base_w)
        initial_top = min(max(0, int(round(desired_top))), fresh_h - base_h)
        positions = [(initial_left, initial_top)]
        for candidate_top in range(top_min, top_max + 1, stride):
            for candidate_left in range(left_min, left_max + 1, stride):
                if candidate_left != initial_left or candidate_top != initial_top:
                    positions.append((candidate_left, candidate_top))
        for candidate_left, candidate_top in positions:
            if len(edge_candidates) >= MAX_CANDIDATES:
                result.update(status="unsupported", notes=["CANDIDATE_LIMIT"])
                return result
            patch = fresh[candidate_top:candidate_top + base_h, candidate_left:candidate_left + base_w]
            candidate_edges = _edge_map(patch)
            candidate_mask = candidate_edges > edge_threshold
            if candidate_mask.mean() < 0.01:
                continue
            union = (template_mask | candidate_mask).sum()
            score = float((template_mask & candidate_mask).sum() / union) if union else 0.0
            center_x = candidate_left + target_local_x
            center_y = candidate_top + target_local_y
            edge_candidates.append((score, candidate_left, candidate_top, 1.0, center_x, center_y))
        if edge_candidates:
            edge_candidates.sort(key=lambda item: item[0], reverse=True)
            edge_best = edge_candidates[0]
            edge_second = _separated_second(edge_candidates, edge_best, min_separation)
            result.update(edge_similarity=round(edge_best[0], 6),
                          edge_second_similarity=round(edge_second, 6),
                          edge_margin=round(edge_best[0] - edge_second, 6),
                          method="edge_iou", scale=1.0)
            if edge_best[0] >= edge_min_similarity and edge_best[0] - edge_second >= min_margin:
                result.update(status="found", similarity=round(edge_best[0], 6),
                              second_similarity=round(edge_second, 6),
                              margin=round(edge_best[0] - edge_second, 6),
                              new_center=[edge_best[4], edge_best[5]])
                return result
        result["status"] = "ambiguous" if best[0] >= min_similarity else "not_found"
        return result
    except (OSError, ValueError, ImageDecodeError) as error:
        result["notes"].append(f"{type(error).__name__}: {str(error)[:120]}")
        return result
