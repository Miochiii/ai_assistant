"""Compare a verified visual template with a post-action observation."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from desktop_adapter.verify import compare_template


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--template", required=True)
    parser.add_argument("--after", required=True)
    parser.add_argument("--region", type=int, nargs=4)
    parser.add_argument("--tolerance", type=int, default=16)
    parser.add_argument("--min-similarity", type=float, default=0.98)
    parser.add_argument("--critical-region", type=int, nargs=4)
    parser.add_argument("--critical-tolerance", type=int, default=0)
    parser.add_argument("--max-critical-changed", type=float, default=0.0)
    parser.add_argument("--out")
    args = parser.parse_args()
    result = compare_template(args.template, args.after, region=args.region,
                              tolerance=args.tolerance, min_similarity=args.min_similarity,
                              critical_region=args.critical_region,
                              critical_tolerance=args.critical_tolerance,
                              max_critical_changed=args.max_critical_changed)
    if args.out:
        Path(args.out).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["status"] == "passed" else 2 if result["status"] == "failed" else 3


if __name__ == "__main__":
    raise SystemExit(main())
