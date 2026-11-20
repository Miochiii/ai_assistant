from pathlib import Path
import json
import shutil
import sqlite3
import sys
import unittest
from unittest.mock import patch
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from assistant_memory import MemoryGateway, Scope, MemoryError
from assistant_memory.automation import automation_status, configure_automation, auto_checkpoint, expiry_preview
from desktop_adapter.runs import RunLedger, RunLedgerError

T0 = "2026-10-29T00:00:00+00:00"


class MemoryAutomationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = ROOT / "runtime" / "memory-tests" / ("automation-" + uuid4().hex)
        self.tmp.mkdir(parents=True)
        self.addCleanup(self.cleanup)
        self.now = T0
        self.memory = MemoryGateway(self.tmp / "memory.sqlite3", Scope("user-a", "project-a"), clock=lambda: self.now)
        self.addCleanup(self.memory.close)
        self.ledger = RunLedger(self.tmp, clock=lambda: T0)
        self.counter = 0

    def cleanup(self):
        target = self.tmp.resolve()
        if not target.is_relative_to((ROOT / "runtime" / "memory-tests").resolve()):
            raise RuntimeError("test cleanup escaped workspace")
        shutil.rmtree(target)

    def configure(self, enabled=True):
        self.counter += 1
        eid = self.memory.record_event(event_id=f"consent-{self.counter}", session_id="settings",
            channel="harness", origin="user", content="synthetic human setting")
        return configure_automation(self.memory, source_event_id=eid, auto_checkpoint=enabled,
                                    retention_days=30, acknowledge_retained_body=True)

    def create_run(self, termination="completed", *, run_id="run-1", context=True, end=True, facts=None,
            delivery="sent", executor="stopped", deps=(), task_id=None):
        settings = automation_status(self.memory)
        source = {"session_id": "session-a", "user_event_id": "opaque-user-message",
                  "request_id": "request-a", "consent_event_id": settings["consent_event_id"] or "absent",
                  "depends_on": list(deps)}
        self.ledger.start(task_id=task_id or "desktop:" + run_id, run_id=run_id, request_id="request-a",
                          scope={"user": "user-a", "project": "project-a"},
                          memory_context=source if context else None)
        if end:
            self.ledger.end(run_id, operation_id="terminal-1", termination_reason=termination,
                input_delivery=delivery, verification={"status": "unknown", "reason": "no_task_verification"},
                executor_state=executor,
                checkpoint_facts=facts if facts is not None else [{"step": 1, "input_delivery": "sent", "verification": "unknown"}])
        return run_id

    def checkpoint(self, run_id="run-1"):
        return auto_checkpoint(self.memory, self.tmp, run_id=run_id)

    def test_disabled_and_unknown_scope_write_no_memory_or_sources(self):
        self.create_run()
        self.assertEqual(self.checkpoint()["status"], "skipped")
        self.assertEqual(self.memory.export()["items"], [])
        self.assertEqual(self.memory.export()["events"], [])
        self.configure()
        with MemoryGateway(self.tmp / "memory.sqlite3", Scope("user-a", "project-b")) as other:
            self.assertFalse(automation_status(other)["auto_checkpoint"])
            self.assertEqual(auto_checkpoint(other, self.tmp, run_id="run-1")["status"], "skipped")

    def test_consent_needs_human_source_and_visible_retention(self):
        eid = self.memory.record_event(event_id="tool", session_id="s", channel="test", origin="tool", content="enable")
        with self.assertRaisesRegex(MemoryError, "EXPLICIT_USER_SOURCE_REQUIRED"):
            configure_automation(self.memory, source_event_id=eid, auto_checkpoint=True,
                                 retention_days=30, acknowledge_retained_body=True)
        with self.assertRaisesRegex(MemoryError, "RETENTION_ACK_REQUIRED"):
            configure_automation(self.memory, source_event_id=eid, auto_checkpoint=True)
        self.assertFalse(automation_status(self.memory)["auto_checkpoint"])

    def test_all_terminal_states_preserve_facts_and_sources(self):
        self.configure()
        for index, termination in enumerate(["completed", "failed", "cancelled", "timeout", "interrupted"]):
            with self.subTest(termination=termination):
                rid = self.create_run(termination, run_id=f"run-{index}", delivery="unknown", executor="unknown")
                saved = self.checkpoint(rid)
                self.assertEqual(saved["status"], "saved")
                resumed = self.memory.resume("desktop:" + rid)
                item = resumed["items"][0]
                self.assertFalse(resumed["automatic_execution"])
                self.assertFalse(resumed["task_success_verified"])
                self.assertEqual({s["origin"] for s in item["sources"]}, {"user", "tool"})
                host = next(s for s in item["sources"] if s["channel"] == "desktop_run_ledger")
                data = json.loads(host["content"])
                self.assertEqual(data["termination_reason"], termination)
                self.assertEqual(data["executor_state"], "unknown")
                receipt = json.loads(next(s for s in item["sources"] if s["channel"] == "desktop_executor_receipt")["content"])
                self.assertEqual(receipt["input_delivery"], "unknown")
                self.assertIn("text_retained", next(s for s in item["sources"] if s["origin"] == "user")["content"])

    def test_running_or_missing_source_never_triggers(self):
        self.configure()
        self.create_run(end=False)
        self.assertEqual(self.checkpoint()["reason"], "no_terminal_event")
        self.create_run(run_id="no-source", context=False)
        self.assertEqual(self.checkpoint("no-source")["status"], "skipped")
        self.assertEqual(self.memory.export()["items"], [])

    def test_old_unrecovered_run_does_not_claim_executor_stopped(self):
        self.configure()
        self.create_run(end=False)
        self.ledger.mark_interrupted("run-1", operation_id="recover")
        self.assertEqual(self.checkpoint()["reason"], "executor_recovery_required")

    def test_duplicate_terminal_delivery_and_commit_crash_are_idempotent(self):
        self.configure()
        self.create_run()
        # The SQLite commit has succeeded when the acknowledgement write fails.
        with patch.object(RunLedger, "_write", side_effect=OSError("synthetic ack failure")):
            with self.assertRaises(OSError):
                self.checkpoint()
        self.assertEqual(len(self.memory.export()["items"]), 1)
        saved = self.checkpoint()
        again = self.checkpoint()
        self.assertEqual(saved["memory_id"], again["memory_id"])
        self.assertEqual(len(self.memory.export()["items"]), 1)
        self.assertEqual(self.ledger.get("run-1")["checkpoint_write"]["status"], "saved")

    def test_same_operation_with_modified_content_is_conflict(self):
        self.configure()
        self.create_run()
        self.checkpoint()
        record = self.ledger.get("run-1")
        record["input_delivery"] = "not_sent"
        self.ledger._write(record)  # Simulate corrupt host redelivery; never overwrite memory.
        with self.assertRaisesRegex(MemoryError, "IDEMPOTENCY_CONFLICT"):
            self.checkpoint()
        self.assertEqual(len(self.memory.export()["items"]), 1)

    def test_disable_stops_queued_delivery_and_reenable_does_not_reuse_old_consent(self):
        self.configure()
        self.create_run()
        self.configure(False)
        self.assertEqual(self.checkpoint()["status"], "skipped")
        self.configure(True)
        self.assertEqual(self.checkpoint()["reason"], "disabled_or_consent_changed")
        self.assertEqual(self.memory.export()["items"], [])

    def test_duplicate_old_enable_cannot_undo_disable_or_erase_saved_ack(self):
        settings = self.configure()
        self.create_run()
        saved = self.checkpoint()
        self.configure(False)
        duplicate = configure_automation(self.memory, source_event_id=settings["consent_event_id"],
            auto_checkpoint=True, retention_days=30, acknowledge_retained_body=True)
        self.assertFalse(duplicate["auto_checkpoint"])
        skipped = self.checkpoint()
        self.assertEqual(skipped["status"], "skipped")
        self.assertEqual(skipped["already_saved_memory_id"], saved["memory_id"])
        self.assertEqual(self.ledger.get("run-1")["checkpoint_write"]["status"], "saved")

    def test_storage_failure_rolls_back_sources_and_never_changes_run_outcome(self):
        self.configure()
        self.create_run()
        with patch.object(self.memory, "_save_checkpoint_record", side_effect=sqlite3.OperationalError("synthetic")):
            with self.assertRaises(sqlite3.OperationalError):
                self.checkpoint()
        record = self.ledger.get("run-1")
        self.assertEqual(record["termination_reason"], "completed")
        self.assertEqual(record["input_delivery"], "sent")
        self.assertEqual(record["checkpoint_write"]["status"], "failed")
        self.assertEqual(len(self.memory.export()["events"]), 1)  # Only consent.
        self.assertEqual(self.checkpoint()["status"], "saved")

    def test_retry_limit_is_durable_and_does_not_execute_desktop_work(self):
        self.configure()
        self.create_run()
        with patch.object(self.memory, "_save_checkpoint_record", side_effect=sqlite3.OperationalError("synthetic")):
            for _ in range(3):
                with self.assertRaises(sqlite3.OperationalError):
                    self.checkpoint()
        self.assertTrue(self.checkpoint()["retry_exhausted"])
        self.assertEqual(self.memory.export()["items"], [])

    def test_dependency_revoke_and_delete_invalidate_and_do_not_resurrect(self):
        self.configure()
        source = self.memory.record_event(event_id="fact-src", session_id="s", channel="test", origin="user", content="value")
        fact = self.memory.remember(kind="fact", key="test.key", content="value", source_event_ids=[source])
        self.create_run(deps=[fact])
        saved = self.checkpoint()
        self.memory.revoke(fact)
        self.assertEqual(self.memory.resume("desktop:run-1")["items"], [])
        self.memory.forget(memory_id=fact)
        with self.assertRaisesRegex(MemoryError, "OPERATION_DELETED"):
            self.checkpoint()
        self.assertFalse(any(i["memory_id"] == saved["memory_id"] for i in self.memory.export()["items"]))

    def test_expiry_stops_resume_but_keeps_body_for_preview_and_explicit_delete(self):
        self.configure()
        self.create_run()
        self.checkpoint()
        self.now = "2026-11-29T00:00:00+00:00"
        self.assertEqual(self.memory.resume("desktop:run-1")["items"], [])
        history = self.memory.recall(route="history", kind="checkpoint", key="desktop:run-1")
        self.assertTrue(history["items"][0]["content"])
        preview = expiry_preview(self.memory)
        self.assertEqual(preview["expired"][0]["memory_id"], history["items"][0]["memory_id"])
        self.assertFalse(preview["automatic_delete"])
        self.assertTrue(preview["body_retained_on_disk"])

    def test_corrupt_or_deleted_consent_fails_closed(self):
        self.configure()
        self.memory.db.execute("UPDATE memory_automation SET policy_version='unknown'")
        self.assertFalse(automation_status(self.memory)["auto_checkpoint"])
        self.configure()
        self.memory.forget(event_id=automation_status(self.memory)["consent_event_id"])
        self.assertFalse(automation_status(self.memory)["auto_checkpoint"])

    def test_existing_v1_database_and_manual_checkpoint_still_work(self):
        self.memory.db.execute("DROP TABLE memory_automation")
        with MemoryGateway(self.tmp / "memory.sqlite3", self.memory.scope) as reopened:
            self.assertFalse(automation_status(reopened)["auto_checkpoint"])
            source = reopened.record_event(event_id="manual", session_id="s", channel="test", origin="model", content="context")
            mid = reopened.save_checkpoint(task_id="manual", content={"goal": "read", "completed": [],
                "next_step": "observe", "blockers": [], "status": "blocked"}, source_event_ids=[source], operation_id="old-op")
            self.assertEqual(reopened.resume("manual")["items"][0]["memory_id"], mid)


if __name__ == "__main__":
    unittest.main()
