import json
from pathlib import Path
import shutil
import sys
import unittest
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from desktop_adapter.runs import RunLedger, RunLedgerError


class RunLedgerTests(unittest.TestCase):
    def setUp(self):
        self.root = ROOT / "runtime" / "run-tests" / str(uuid4())
        self.root.mkdir(parents=True)
        self.addCleanup(self.cleanup)
        self.ledger = RunLedger(self.root)

    def cleanup(self):
        target = self.root.resolve()
        if not target.is_relative_to((ROOT / "runtime" / "run-tests").resolve()):
            raise RuntimeError("cleanup escaped test workspace")
        shutil.rmtree(target, ignore_errors=True)

    def start(self):
        return self.ledger.start(task_id="task-1", request_id="request-1", run_id="run-1")

    def test_lifecycle_and_verified_success_are_separate(self):
        record = self.start()
        self.assertEqual(record["lifecycle"], "queued")
        self.assertFalse(self.ledger.verified_success("run-1"))
        self.ledger.transition("run-1", operation_id="op-run", lifecycle="running")
        self.ledger.transition("run-1", operation_id="op-end", lifecycle="ended",
                               termination_reason="completed",
                               input_delivery="sent",
                               verification={"status": "passed", "evidence": "receipt-1"})
        record = self.ledger.get("run-1")
        self.assertTrue(self.ledger.verified_success("run-1"))
        self.assertEqual(record["input_delivery"], "sent")
        self.assertEqual(record["verification"]["status"], "passed")

    def test_repeated_operation_is_idempotent_and_conflicts(self):
        self.start()
        first = self.ledger.transition("run-1", operation_id="op-1", lifecycle="running")
        second = self.ledger.transition("run-1", operation_id="op-1", lifecycle="running")
        self.assertEqual(first["updated_at"], second["updated_at"])
        with self.assertRaisesRegex(RunLedgerError, "RUN_OPERATION_CONFLICT"):
            self.ledger.transition("run-1", operation_id="op-1", lifecycle="waiting_user")

    def test_invalid_transition_and_termination_are_rejected(self):
        self.start()
        with self.assertRaisesRegex(RunLedgerError, "TERMINATION_REQUIRES_END"):
            self.ledger.transition("run-1", operation_id="op-2", lifecycle="running",
                                   termination_reason="completed")
        with self.assertRaisesRegex(RunLedgerError, "END_REQUIRES_TERMINATION"):
            self.ledger.transition("run-1", operation_id="op-3", lifecycle="ended")
        self.ledger.transition("run-1", operation_id="op-4", lifecycle="running")
        self.ledger.end("run-1", operation_id="op-5", termination_reason="error",
                        verification={"status": "unknown", "reason": "no-after-image"})
        self.assertFalse(self.ledger.verified_success("run-1"))
        with self.assertRaisesRegex(RunLedgerError, "RUN_ENDED"):
            self.ledger.transition("run-1", operation_id="op-6", lifecycle="running")

    def test_unfinished_runs_are_reported_not_retried(self):
        self.start()
        self.ledger.transition("run-1", operation_id="op-1", lifecycle="running")
        unfinished = self.ledger.unfinished()
        self.assertEqual([item["run_id"] for item in unfinished], ["run-1"])
        self.ledger.mark_interrupted("run-1", operation_id="op-recover")
        self.assertEqual(self.ledger.unfinished(), [])
        self.assertEqual(self.ledger.get("run-1")["termination_reason"], "interrupted")

    def test_record_is_persisted_as_json(self):
        self.start()
        self.ledger.transition("run-1", operation_id="op-1", lifecycle="running")
        path = self.root / "runtime" / "runs" / "run-1.json"
        record = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(record["task_id"], "task-1")
        self.assertEqual(record["operations"]["op-1"], self.ledger.get("run-1")["operations"]["op-1"])

    def test_checkpoint_ack_after_end_does_not_reopen_or_change_terminal_identity(self):
        self.start()
        ended = self.ledger.end("run-1", operation_id="terminal", termination_reason="completed",
                                input_delivery="sent", executor_state="stopped")
        result = self.ledger.checkpoint_result("run-1", result={"status": "failed", "error_code": "STORAGE_UNAVAILABLE"})
        self.assertEqual(result["termination_reason"], "completed")
        self.assertEqual(result["terminal_event_id"], "terminal")
        self.assertEqual(result["ended_at"], ended["ended_at"])
        self.assertEqual(result["input_delivery"], "sent")
        with self.assertRaisesRegex(RunLedgerError, "RUN_ENDED"):
            self.ledger.transition("run-1", operation_id="reopen", lifecycle="running")

    def test_checkpoint_fact_summary_rejects_coordinates_or_raw_output(self):
        self.start()
        with self.assertRaisesRegex(RunLedgerError, "INVALID_CHECKPOINT_FACTS"):
            self.ledger.end("run-1", operation_id="bad", termination_reason="completed",
                            checkpoint_facts=[{"step": 1, "input_delivery": "sent", "verification": "unknown", "coordinates": [1, 2]}])
        self.assertEqual(self.ledger.get("run-1")["lifecycle"], "queued")


if __name__ == "__main__":
    unittest.main()
