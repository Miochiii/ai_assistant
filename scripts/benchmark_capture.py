"""Measure local screenshot capture/encode/persist cost with a bounded region.

No model request and no desktop input. The caller supplies a region so this does
not silently capture a full screen. Temporary PNG/RGB evidence is removed.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import statistics
import sys
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from desktop_adapter.vision import Rect, capture  # noqa: E402


def parse_region(value):
    parts = [int(item) for item in value.split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("region must be LEFT,TOP,WIDTH,HEIGHT")
    return Rect(*parts)


def summary(values):
    if not values:
        return None
    return {"min_ms": round(min(values), 2), "median_ms": round(statistics.median(values), 2),
            "max_ms": round(max(values), 2), "count": len(values)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--region", required=True, type=parse_region)
    parser.add_argument("--monitor", type=int, default=1)
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--out", default=str(ROOT / "results/vision-efficiency/capture-baseline.json"))
    args = parser.parse_args()
    if not 1 <= args.runs <= 50:
        raise SystemExit("--runs must be 1..50")
    session = ROOT / "runtime" / "benchmark-capture" / str(uuid4())
    records = []
    try:
        for index in range(args.runs):
            folder = session / f"run-{index}"
            observation = capture(folder, monitor=args.monitor, region=args.region, retain_rgb=True)
            timings = observation["timings"]
            records.append({**timings, "image_bytes": Path(observation["image"]["path"]).stat().st_size,
                            "image_pixels": observation["image"]["width"] * observation["image"]["height"]})
    finally:
        shutil.rmtree(session, ignore_errors=True)
    report = {
        "schema_version": 1, "checked_at": datetime.now(timezone.utc).isoformat(),
        "monitor": args.monitor, "region": list(vars(args.region).values()), "runs": args.runs,
        "capture_count": len(records),
        "images_sent": 0, "model_calls": None,
        "model_calls_note": "not_observable_from_local_capture; plugin does not call a model",
        "input_events_sent": 0,
        "capture": summary([item["capture_ms"] for item in records]),
        "encode": summary([item["encode_ms"] for item in records]),
        "persist": summary([item["persist_ms"] for item in records]),
        "total": summary([item["total_ms"] for item in records]),
        "image_bytes": summary([item["image_bytes"] for item in records]),
        "samples": records,
        "limitations": ["Small engineering sample; no p95 claim.",
                        "Times are process-local and do not include model request latency."],
    }
    path = Path(args.out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"capture_median_ms": report["capture"]["median_ms"],
                      "encode_median_ms": report["encode"]["median_ms"],
                      "persist_median_ms": report["persist"]["median_ms"],
                      "path": str(path)}, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
