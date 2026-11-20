"""Evidence retention and deletion planning.

Ordinary screenshots and RGB baselines are short-lived. Images explicitly used
as a program visual basis (by observation id) and templates under
runtime/templates are retained. Harness attachment copies are deleted only when
they appear in the local attachment index, which the image-delivery path writes.
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil

DEFAULT_POLICY = {"ordinary_vision_ttl_hours": 24, "rgb_ttl_hours": 1,
                  "program_basis": "keep", "templates": "keep", "memory_images": False,
                  "harness_attachments": {"enabled": True, "ttl_hours": 24,
                                          "index": "runtime/attachments.jsonl"}}


def load_policy(root: Path | str) -> dict:
    path = Path(root).resolve() / "configs" / "retention.json"
    try:
        policy = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return dict(DEFAULT_POLICY)
    return {**DEFAULT_POLICY, **policy}


def _age_hours(path: Path, now: datetime) -> float:
    return max(0.0, (now - datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)).total_seconds() / 3600)


def program_basis_ids(root: Path) -> set[str]:
    result = set()
    for path in (Path(root).resolve() / "runtime" / "programs").rglob("*.json"):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        for step in payload.get("steps", []) or []:
            basis = step.get("visual_basis") if isinstance(step, dict) else None
            if isinstance(basis, dict) and isinstance(basis.get("observation_id"), str):
                result.add(basis["observation_id"])
    return result


def _attachment_path(home: Path, attachment_id: str) -> Path | None:
    if not isinstance(attachment_id, str) or not attachment_id.startswith("sha256:"):
        return None
    digest = attachment_id.split(":", 1)[1].lower()
    if len(digest) != 64 or any(ch not in "0123456789abcdef" for ch in digest):
        return None
    return home / ".dsh" / "attachments" / "v1" / "objects" / digest[:2] / digest


def plan_cleanup(root: Path | str, *, now: datetime | None = None, home: Path | str | None = None) -> dict:
    root = Path(root).resolve()
    home = Path(home).resolve() if home is not None else Path.home()
    policy = load_policy(root)
    current = now or datetime.now(timezone.utc)
    basis = program_basis_ids(root)
    plan = {"delete": [], "keep": [], "errors": []}
    vision_dir = root / "results" / "vision"
    if vision_dir.is_dir():
        for folder in vision_dir.iterdir():
            if not folder.is_dir():
                continue
            try:
                manifest = json.loads((folder / "observation.json").read_text(encoding="utf-8"))
                observation_id = manifest.get("observation_id")
            except (OSError, ValueError):
                observation_id = None
            age = _age_hours(folder, current)
            if observation_id in basis:
                plan["keep"].append({"path": str(folder), "kind": "vision", "reason": "program_basis"})
                rgb = folder / "source.rgb"
                if rgb.is_file() and _age_hours(rgb, current) >= policy["rgb_ttl_hours"]:
                    plan["delete"].append({"path": str(rgb), "kind": "rgb", "reason": "rgb_ttl"})
            elif age >= policy["ordinary_vision_ttl_hours"]:
                plan["delete"].append({"path": str(folder), "kind": "vision", "reason": "ordinary_ttl"})
            else:
                plan["keep"].append({"path": str(folder), "kind": "vision", "reason": "ordinary_ttl"})
    attachments = policy.get("harness_attachments", {})
    if attachments.get("enabled"):
        index = root / str(attachments.get("index", "runtime/attachments.jsonl"))
        ttl = attachments.get("ttl_hours", 24)
        if index.is_file():
            for line in index.read_text(encoding="utf-8", errors="replace").splitlines():
                try:
                    record = json.loads(line)
                    recorded = datetime.fromisoformat(str(record["recorded_at"]))
                    if recorded.tzinfo is None:
                        recorded = recorded.replace(tzinfo=timezone.utc)
                except (ValueError, KeyError, TypeError):
                    plan["errors"].append({"kind": "attachment_record", "reason": "invalid"})
                    continue
                path = _attachment_path(home, record.get("attachment_id"))
                if path is None:
                    continue
                try:
                    age = (current - recorded.astimezone(timezone.utc)).total_seconds() / 3600
                except ValueError:
                    continue
                if not path.is_file():
                    continue
                if age >= ttl:
                    plan["delete"].append({"path": str(path), "kind": "attachment", "reason": "attachment_ttl"})
                else:
                    plan["keep"].append({"path": str(path), "kind": "attachment", "reason": "attachment_ttl"})
    return plan


def apply_plan(root: Path | str, plan: dict, *, home: Path | str | None = None) -> dict:
    root = Path(root).resolve()
    home = Path(home).resolve() if home is not None else Path.home()
    allowed_vision = (root / "results" / "vision").resolve()
    allowed_home = (home / ".dsh" / "attachments" / "v1" / "objects").resolve()
    removed, errors = [], []
    for item in plan.get("delete", []):
        path = Path(item["path"]).resolve()
        if not (path.is_relative_to(allowed_vision) or path.is_relative_to(allowed_home)):
            errors.append({"path": str(path), "reason": "outside_retention_roots"})
            continue
        try:
            if path.is_dir():
                shutil.rmtree(path)
            elif path.is_file():
                path.unlink()
            else:
                continue
            removed.append(str(path))
        except OSError as error:
            errors.append({"path": str(path), "reason": type(error).__name__})
    return {"removed": removed, "errors": errors}
