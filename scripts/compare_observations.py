"""Compare two stored observation RGB frames without capturing or acting."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from desktop_adapter.observation_policy import compare_observations  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--previous", required=True, help="previous observation.json")
    parser.add_argument("--current", required=True, help="current observation.json")
    parser.add_argument("--previous-rgb", required=True)
    parser.add_argument("--current-rgb", required=True)
    parser.add_argument("--block-size", type=int, default=32)
    parser.add_argument("--max-regions", type=int, default=10)
    parser.add_argument("--critical", action="append", default=[],
                        help="x,y,width,height in image pixels; repeatable")
    parser.add_argument("--out")
    args = parser.parse_args()
    previous = json.loads(Path(args.previous).read_text(encoding="utf-8"))
    current = json.loads(Path(args.current).read_text(encoding="utf-8"))
    critical = []
    for item in args.critical:
        parts = [int(value) for value in item.split(",")]
        if len(parts) != 4:
            raise SystemExit("--critical needs x,y,width,height")
        critical.append(tuple(parts))
    result = compare_observations(
        previous, current, Path(args.previous_rgb).read_bytes(), Path(args.current_rgb).read_bytes(),
        block_size=args.block_size, max_regions=args.max_regions, critical_regions=critical)
    output = {"schema_version": 1, "previous": args.previous, "current": args.current,
              "model_calls": None, "model_calls_note": "not_observable_from_offline_compare",
              "input_events_sent": 0, "result": result}
    path = Path(args.out) if args.out else ROOT / "results/vision-efficiency/change-report.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"status": result["status"], "changed_pixels": result.get("changed_pixels"),
                      "context": result.get("reasons"), "path": str(path)}, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
