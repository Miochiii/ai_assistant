import json
import shutil
import sys
import unittest
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from assistant_memory import MemoryError, MemoryGateway, Scope

T0 = "2026-10-30T00:00:00+00:00"
T1 = "2026-10-31T00:00:00+00:00"
T2 = "2026-11-02T00:00:00+00:00"


class ContextExposureTests(unittest.TestCase):
    def setUp(self):
        self.tmp = ROOT / "runtime" / "memory-tests" / ("exposure-" + uuid4().hex)
        self.tmp.mkdir(parents=True)
        self.addCleanup(self.cleanup)
        self.memory = MemoryGateway(self.tmp / "memory.sqlite3", Scope("u", "p"), clock=lambda: T0)
        self.addCleanup(self.memory.close)
        self.counter = 0

    def cleanup(self):
        target = self.tmp.resolve()
        if not target.is_relative_to((ROOT / "runtime" / "memory-tests").resolve()):
            raise RuntimeError("test cleanup escaped workspace")
        shutil.rmtree(target)

    def source(self):
        self.counter += 1
        return self.memory.record_event(event_id=f"e-{self.counter}", session_id="s", channel="test",
                                        origin="user", content="synthetic")

    def remember(self, key="k", **kwargs):
        return self.memory.remember(kind="fact", key=key, content="synthetic memory",
                                    source_event_ids=[self.source()], **kwargs)

    def test_exposure_is_idempotent_metadata_only_and_clean(self):
        mid = self.remember()
        first = self.memory.register_exposure(session_id="s", request_id="r", memory_ids=[mid])
        second = self.memory.register_exposure(session_id="s", request_id="r", memory_ids=[mid],
                                               stage="submitted_to_adapter")
        self.assertEqual(first["exposure_id"], second["exposure_id"])
        self.assertEqual(second["stage"], "submitted_to_adapter")
        state = self.memory.context_state(session_id="s")
        self.assertEqual((state["status"], state["revision"]), ("clean", 0))
        row = self.memory.db.execute("SELECT * FROM memory_context_exposures").fetchone()
        self.assertNotIn("content", row.keys())
        self.assertEqual(json.loads(row["memory_ids"]), [mid])

    def test_promote_marks_prepared_exposure_before_submission(self):
        mid = self.remember()
        self.memory.register_exposure(session_id="s", request_id="r", memory_ids=[mid])
        promoted = self.memory.promote_exposures(session_id="s")
        self.assertEqual(promoted["promoted"], 1)
        row = self.memory.db.execute("SELECT stage FROM memory_context_exposures").fetchone()
        self.assertEqual(row["stage"], "submitted_to_adapter")

    def test_revoke_marks_only_exposing_session_needs_refresh(self):
        mid = self.remember()
        self.memory.register_exposure(session_id="s1", request_id="r1", memory_ids=[mid])
        self.memory.register_exposure(session_id="s2", request_id="r2", memory_ids=[self.remember(key="k2")])
        self.memory.revoke(mid)
        self.assertEqual(self.memory.context_state(session_id="s1")["status"], "needs_refresh")
        self.assertEqual(self.memory.context_state(session_id="s2")["status"], "clean")
        with self.assertRaisesRegex(MemoryError, "CONTEXT_NEEDS_REFRESH"):
            self.memory.register_exposure(session_id="s1", request_id="r1", memory_ids=[mid])

    def test_delete_marks_exposure_invalidated(self):
        mid = self.remember()
        self.memory.register_exposure(session_id="s", request_id="r", memory_ids=[mid])
        self.memory.forget(memory_id=mid)
        state = self.memory.context_state(session_id="s")
        self.assertEqual(state["status"], "needs_refresh")
        row = self.memory.db.execute("SELECT stage,invalidated_at FROM memory_context_exposures").fetchone()
        self.assertEqual(row["stage"], "invalidated")
        self.assertTrue(row["invalidated_at"])

    def test_expiry_is_detected_at_context_check_not_just_filtered(self):
        mid = self.remember(valid_to=T1)
        self.memory.register_exposure(session_id="s", request_id="r", memory_ids=[mid])
        self.memory.clock = lambda: T2
        state = self.memory.context_state(session_id="s")
        self.assertEqual(state["status"], "needs_refresh")
        self.assertEqual(state["invalidation_event_ids"][-1], "memory_not_active")

    def test_unknown_memory_or_bad_generation_does_not_register(self):
        with self.assertRaisesRegex(MemoryError, "MEMORY_UNAVAILABLE"):
            self.memory.register_exposure(session_id="s", request_id="r", memory_ids=["missing"])
        with self.assertRaisesRegex(MemoryError, "INVALID_CONTEXT_GENERATION"):
            self.memory.register_exposure(session_id="s", request_id="r", generation=0,
                                          memory_ids=[self.remember()])

    def test_refresh_context_bumps_generation_and_clears_stale_state(self):
        mid = self.remember()
        self.memory.register_exposure(session_id="s", request_id="r", memory_ids=[mid])
        self.memory.revoke(mid)
        self.assertEqual(self.memory.context_state(session_id="s")["status"], "needs_refresh")
        self.assertEqual(self.memory.context_generation(session_id="s")["generation"], 1)
        refreshed = self.memory.refresh_context(session_id="s", generation=1, reason="test_refresh")
        self.assertEqual((refreshed["generation"], refreshed["status"]), (2, "clean"))
        self.assertEqual(self.memory.context_state(session_id="s")["status"], "needs_refresh")
        self.assertEqual(self.memory.context_state(session_id="s", generation=2)["status"], "clean")
        self.assertEqual(self.memory.context_generation(session_id="s")["generation"], 2)
        audit = [row["operation"] for row in self.memory.db.execute(
            "SELECT operation FROM memory_audit ORDER BY rowid")]
        self.assertIn("context_refreshed", audit)
        new_mid = self.remember(key="after-refresh")
        exposure = self.memory.register_exposure(session_id="s", request_id="r2",
                                                 generation=2, memory_ids=[new_mid])
        self.assertEqual(exposure["generation"], 2)

    def test_refresh_after_delete_does_not_resurrect_old_content(self):
        mid = self.remember()
        self.memory.register_exposure(session_id="s", request_id="r", memory_ids=[mid])
        self.memory.forget(memory_id=mid)
        refreshed = self.memory.refresh_context(session_id="s", reason="after_delete")
        self.assertEqual((refreshed["generation"], refreshed["status"]), (2, "clean"))
        self.assertEqual(self.memory.context_state(session_id="s", generation=2)["status"], "clean")
        with self.assertRaisesRegex(MemoryError, "MEMORY_UNAVAILABLE"):
            self.memory.register_exposure(session_id="s", request_id="r3",
                                          generation=2, memory_ids=[mid])


if __name__ == "__main__":
    unittest.main()
