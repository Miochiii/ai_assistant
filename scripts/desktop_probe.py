"""Read-only CLI prototype, isolated in a worker with a hard timeout."""
import argparse
from hashlib import sha256
import json
from pathlib import Path
import subprocess
import sys
from time import perf_counter
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("command", choices=["list", "observe"])
    result.add_argument("--application", required=True, choices=["calculator", "notepad"])
    result.add_argument("--hwnd", type=int)
    result.add_argument("--pid", type=int)
    result.add_argument("--session-id", default="local-desktop-development")
    result.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    return result


def main():
    args = parser().parse_args()
    if args.command == "observe" and (not args.hwnd or not args.pid):
        parser().error("observe requires both --hwnd and --pid from a current list result")
    if args.worker:
        # Worker has no actions, services, model clients or event database ownership.
        from desktop_adapter.windows import list_windows, observe
        try:
            result = list_windows(args.application) if args.command == "list" else observe(args.hwnd, args.pid, args.application)
            print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
        except Exception as error:
            reasons = {"TARGET_NOT_FOUND", "TARGET_AMBIGUOUS", "WINDOW_IDENTITY_CHANGED", "APPLICATION_NOT_ALLOWED",
                       "WINDOW_NOT_VISIBLE", "PROCESS_METADATA_UNAVAILABLE"}
            reason = str(error) if str(error) in reasons else "OBSERVATION_FAILED"
            print(json.dumps({"ok": False, "error_code": reason, "error_type": type(error).__name__}))
        return

    from assistant_core.events import EventStore
    output = ROOT / "results" / "desktop" / str(uuid4())
    output.mkdir(parents=True, exist_ok=False)
    command = [sys.executable, "-B", "-X", "utf8", str(Path(__file__).resolve()), *sys.argv[1:], "--worker"]
    started = perf_counter()
    worker_error = None
    with EventStore(ROOT / "runtime" / "events.sqlite3") as store:
        run = store.start_run(session_id=args.session_id, user_scope="local-user", scenario_id=f"desktop.{args.command}.{args.application}", version="0.1.0")
        event = store.start_event(run, kind="observation", component="pywinauto-read-only", version="0.1.0/pywinauto-0.6.9",
                                  payload={"application": args.application, "hwnd": args.hwnd, "pid": args.pid})
        try:
            proc = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", timeout=15,
                                  creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), cwd=ROOT)
            if proc.returncode != 0:
                raise RuntimeError("worker exit")
            response = json.loads(proc.stdout)
            if not response.get("ok"):
                worker_error = response.get("error_code", "OBSERVATION_FAILED")
                raise RuntimeError(response.get("error_type", "worker failed"))
            result = response["result"]
            result["wall_seconds"] = round(perf_counter() - started, 4)
            path = output / "observation.json"
            path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            digest = sha256(path.read_bytes()).hexdigest()
            evidence = store.add_evidence(run, kind="read_only_observation", reference=str(path.relative_to(ROOT)) + "#sha256=" + digest)
            store.finish_event(event, status="completed", evidence_ids=[evidence], cost={"amount": 0, "currency": "USD", "source": "local_only"})
            store.finish_run(run)  # No verifier: business outcome remains unknown.
            summary = {"ok": True, "run_id": run, "output": str(path), "outcome": "unknown"}
            if args.command == "list":
                summary["windows"] = result["windows"]
                summary["diagnostics"] = result["diagnostics"]
                summary["matching_process_count"] = result["matching_process_count"]
            else:
                summary.update({"node_count": len(result["nodes"]), "issues": result["issues"], "wall_seconds": result["wall_seconds"]})
        except Exception as error:
            status = "timeout" if isinstance(error, subprocess.TimeoutExpired) else "failed"
            code = "TIMEOUT" if status == "timeout" else (worker_error or "OBSERVATION_FAILED")
            store.finish_event(event, status=status, error_code=code)
            store.finish_run(run, status=status, error_code=code)
            summary = {"ok": False, "run_id": run, "outcome": "unknown", "error_code": code, "error_type": type(error).__name__}
        store.export_jsonl(run, output / "events.jsonl")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if not summary["ok"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
