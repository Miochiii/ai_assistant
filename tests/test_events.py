import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from assistant_core.events import EventStore


class EventTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "events.sqlite3"
        self.store = EventStore(self.path)
        self.run = self.new_run()

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def new_run(self):
        return self.store.start_run(session_id="test-session", user_scope="synthetic-user", scenario_id="test", version="0.1.0")

    def event(self, kind="action", run=None, **kwargs):
        return self.store.start_event(run or self.run, kind=kind, component="fake", version="0.1.0", **kwargs)

    def evidence(self, run=None):
        return self.store.add_evidence(run or self.run, kind="synthetic", reference="fixture://result-408")

    def test_tool_completion_does_not_mean_success(self):
        event = self.event()
        self.store.finish_event(event, status="completed")
        result = self.store.finish_run(self.run)
        self.assertEqual(result["outcome"], "unknown")
        self.assertIsNone(self.store.events(self.run)[0]["cost"])

    def test_verified_success_survives_restart(self):
        evidence = self.evidence()
        event = self.event("verification")
        self.store.finish_event(event, status="completed", outcome="success", evidence_ids=[evidence])
        self.store.finish_run(self.run, verifier_event_id=event)
        self.store.close()
        self.store = EventStore(self.path)
        self.assertEqual(self.store.run(self.run)["outcome"], "success")

    def test_recovery_never_replays_action_or_claims_success(self):
        self.event()
        self.store.close()
        self.store = EventStore(self.path)
        self.assertEqual(self.store.run(self.run)["outcome"], "unknown")
        self.store.interrupt_run(self.run, reason="PROCESS_RESTART")
        self.assertEqual(self.store.run(self.run)["outcome"], "unknown")
        self.assertEqual(self.store.events(self.run)[0]["status"], "interrupted")
        self.assertEqual(len(self.store.events(self.run)), 1)

    def test_timeout_cannot_be_success(self):
        event = self.event("verification")
        with self.assertRaises(ValueError):
            self.store.finish_event(event, status="timeout", outcome="success", error_code="TIMEOUT")
        self.store.finish_event(event, status="timeout", error_code="TIMEOUT")
        self.assertEqual(self.store.finish_run(self.run, status="timeout", error_code="TIMEOUT")["outcome"], "unknown")

    def test_action_cannot_certify_outcome(self):
        event = self.event()
        with self.assertRaises(ValueError):
            self.store.finish_event(event, status="completed", outcome="success", evidence_ids=[self.evidence()])

    def test_verifier_requires_evidence(self):
        event = self.event("verification")
        with self.assertRaises(ValueError):
            self.store.finish_event(event, status="completed", outcome="success")

    def test_missing_and_cross_run_evidence_rejected(self):
        event = self.event("verification")
        other = self.new_run()
        for evidence in ("missing", self.evidence(other)):
            with self.assertRaises(ValueError):
                self.store.finish_event(event, status="completed", outcome="success", evidence_ids=[evidence])

    def test_cross_run_parent_and_verifier_rejected(self):
        other = self.new_run()
        parent = self.event(run=other)
        with self.assertRaises(ValueError):
            self.event(parent_event_id=parent)
        verifier = self.event("verification", run=other)
        self.store.finish_event(verifier, status="completed", outcome="success", evidence_ids=[self.evidence(other)])
        with self.assertRaises(ValueError):
            self.store.finish_run(self.run, verifier_event_id=verifier)

    def test_pending_events_prevent_close(self):
        self.event()
        with self.assertRaises(ValueError):
            self.store.finish_run(self.run)

    def test_finished_event_is_immutable_across_connections(self):
        event = self.event()
        self.store.finish_event(event, status="completed")
        with EventStore(self.path) as other:
            with self.assertRaises(ValueError):
                other.finish_event(event, status="failed", error_code="LATE_ERROR")

    def test_closed_run_cannot_accept_more_events(self):
        self.store.finish_run(self.run)
        with self.assertRaises(ValueError):
            self.event()
        with self.assertRaises(ValueError):
            self.evidence()

    def test_verified_failure_distinct_from_tool_error(self):
        event = self.event("verification")
        self.store.finish_event(event, status="completed", outcome="failure", error_code="VERIFICATION_FAILED", evidence_ids=[self.evidence()])
        result = self.store.finish_run(self.run, verifier_event_id=event)
        self.assertEqual((result["status"], result["outcome"]), ("completed", "failure"))

    def test_invalid_cost_rejected_but_explicit_local_zero_kept(self):
        event = self.event()
        for amount in (-1, float("nan"), float("inf"), True):
            with self.assertRaises(ValueError):
                self.store.finish_event(event, status="completed", cost={"amount": amount, "currency": "USD", "source": "test"})
        self.store.finish_event(event, status="completed", cost={"amount": 0, "currency": "USD", "source": "local_only"})
        self.assertEqual(self.store.events(self.run)[0]["cost"]["amount"], 0)

    def test_export_correlates_all_kinds_and_scope(self):
        evidence = self.evidence()
        parent = None
        for kind in ("observation", "action", "memory_write", "memory_read", "answer", "evaluation", "verification"):
            event = self.event(kind, parent_event_id=parent)
            self.store.finish_event(event, status="completed", evidence_ids=[evidence], outcome="success" if kind == "verification" else "unknown")
            parent = event
        self.store.finish_run(self.run, verifier_event_id=parent)
        output = Path(self.tmp.name) / "example.jsonl"
        self.store.export_jsonl(self.run, output)
        records = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
        events = [r for r in records if r["record_type"] == "event"]
        self.assertEqual(len(events), 7)
        self.assertTrue(all(e["run_id"] == self.run and e["user_scope"] == "synthetic-user" for e in events))
        self.assertEqual(records[0]["outcome"], "success")
        self.assertEqual(records[1]["evidence_id"], evidence)


if __name__ == "__main__":
    unittest.main()
