"""Generate synthetic protocol evidence. Does not touch the desktop or APIs."""
import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from assistant_core.events import EventStore


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "results" / "a03")
    args = parser.parse_args()
    with EventStore(args.output / "events.sqlite3") as store:
        run = store.start_run(session_id="synthetic-session", user_scope="synthetic-user", scenario_id="protocol-demo-not-desktop", version="0.1.0")
        evidence = store.add_evidence(run, kind="synthetic_fixture", reference="fixture://expected-calculator-result-408")
        parent = None
        for kind in ("observation", "action", "memory_write", "memory_read", "answer", "evaluation", "verification"):
            event = store.start_event(run, kind=kind, component="synthetic-demo", version="0.1.0", parent_event_id=parent, payload={"synthetic": True})
            store.finish_event(event, status="completed", evidence_ids=[evidence], outcome="success" if kind == "verification" else "unknown", cost={"amount": 0, "currency": "USD", "source": "local_simulation"})
            parent = event
        store.finish_run(run, verifier_event_id=parent)
        store.export_jsonl(run, args.output / "synthetic_success.jsonl")
        run = store.start_run(session_id="synthetic-restart", user_scope="synthetic-user", scenario_id="protocol-interruption", version="0.1.0")
        store.start_event(run, kind="action", component="synthetic-demo", version="0.1.0")
    with EventStore(args.output / "events.sqlite3") as store:
        store.interrupt_run(run, reason="SIMULATED_PROCESS_RESTART")
        store.export_jsonl(run, args.output / "synthetic_interrupted.jsonl")
    print("Synthetic protocol examples saved to", args.output)


if __name__ == "__main__":
    main()
