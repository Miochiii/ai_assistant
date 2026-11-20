#!/usr/bin/env python3
"""Locate a short UI target with the existing Windows OCR path.

Display-only. This helper captures one local frame, runs Windows OCR, and
prints a physical rectangle. It never sends input and never calls a model.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))
TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import coach_host  # noqa: E402


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def variants(target: str) -> list[str]:
    value = " ".join(str(target).split()).strip().strip("“”\"'「」『』")
    if not value:
        return []
    out = [value]
    for suffix in ("菜单", "按钮", "选项", "图标", "区域", "输入框", "标签"):
        if value.endswith(suffix) and len(value) > len(suffix):
            out.append(value[:-len(suffix)].strip())
    for prefix in ("左上角的", "左下角的", "右上角的", "右下角的", "中间的",
                   "上方的", "下方的", "左侧的", "右侧的"):
        if value.startswith(prefix):
            out.append(value[len(prefix):].strip())
    seen = set()
    return [item for item in out if item and not (item in seen or seen.add(item))]


def main(argv: list[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    parser = argparse.ArgumentParser(description="Locate one UI target via Windows OCR")
    parser.add_argument("--target", required=True)
    parser.add_argument("--image", default=None, help="optional existing screenshot")
    parser.add_argument("--out-dir", default=str(ROOT / "runtime" / "assistant-highlight" / "frames"))
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args(argv)
    try:
        image = Path(args.image) if args.image else None
        if image is None:
            out_dir = Path(args.out_dir)
            out_dir.mkdir(parents=True, exist_ok=True)
            image = coach_host.capture_screen(out_dir, 0)
        tried = []
        for variant in variants(args.target):
            tried.append(variant)
            located = coach_host.locate_text({"target": variant, "ocr_pad": 10}, image,
                                             debug=args.debug)
            if located:
                print(json.dumps({
                    "ok": True,
                    "target": args.target,
                    "matched_text": (located.get("locator") or {}).get("matched_text"),
                    "rect": located.get("rect"),
                    "image": str(image),
                    "located_at": now_iso(),
                }, ensure_ascii=False))
                return 0
        print(json.dumps({
            "ok": False,
            "reason": "target_not_found",
            "target": args.target,
            "tried": tried,
            "image": str(image),
            "located_at": now_iso(),
        }, ensure_ascii=False))
        return 2
    except Exception as error:
        print(json.dumps({
            "ok": False,
            "reason": type(error).__name__,
            "message": str(error)[:500],
            "target": args.target,
        }, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
