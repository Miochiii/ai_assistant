import hashlib
import tempfile
import unittest
from pathlib import Path

from desktop_adapter.action_contract import EXECUTOR_VERSION
from desktop_adapter.inventory import parse_program, verify_program
from desktop_adapter.proof import verify_proof


def draft_payload(root: Path):
    template = root / "runtime" / "templates" / "menu.png"
    template.parent.mkdir(parents=True, exist_ok=True)
    template.write_bytes(b"template")
    return {
        "schema_version": 1,
        "program_id": "offline-draft-proof",
        "program_version": 1,
        "task": "offline draft proof",
        "executor_version": EXECUTOR_VERSION,
        "steps": [{
            "step_id": "step-1",
            "target_label": "Menu",
            "visual_basis": {
                "observation_id": "basis-1",
                "image_sha256": "a" * 64,
                "capture_bounds": {"left": 0, "top": 0, "width": 100, "height": 80},
                "target_center": [10, 12],
            },
            "preconditions": {},
            "action": {"type": "click", "target_label": "Menu"},
            "expected": {
                "description": "menu opened",
                "template": "runtime/templates/menu.png",
                "region": [0, 0, 100, 80],
            },
        }],
        "verification": {"status": "draft"},
        "created_at": "2026-11-03T12:00:00+00:00",
    }


class DraftProofTests(unittest.TestCase):
    def test_fresh_replay_generates_proof_without_saving(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            program = parse_program(draft_payload(root))
            receipts = []

            def observe(_step):
                return {"observation_id": "fresh-1", "manifest": "fresh.json", "window": {"hwnd": 1}}

            def locate(_step, _observation):
                return [11, 13]

            class Client:
                def build(self, manifest, target_label, center, description):
                    return {"manifest": manifest, "label": target_label,
                            "center": center, "description": description}
                def execute(self, request):
                    receipts.append(request)
                    return {"ok": True, "observation_id": "fresh-1",
                            "after_observation": "after.json"}

            result = verify_program(
                program,
                observe=observe,
                locate=locate,
                client=Client(),
                verify=lambda *_: {"status": "passed"},
                root=root,
            )
            self.assertEqual(result["status"], "completed")
            self.assertEqual(len(receipts), 1)
            verified = result["program"]
            self.assertEqual(verified.verification["status"], "verified")
            self.assertIn("proof", verified.verification)
            verify_proof(root, verified)
            self.assertFalse((root / "runtime" / "programs").exists())

    def test_failed_verification_does_not_generate_proof(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            program = parse_program(draft_payload(root))
            class Client:
                def build(self, *_args):
                    return {}
                def execute(self, _request):
                    return {"ok": True, "observation_id": "fresh-1"}
            result = verify_program(
                program,
                observe=lambda _step: {"observation_id": "fresh-1", "manifest": "fresh.json", "window": {"hwnd": 1}},
                locate=lambda *_: [11, 13],
                client=Client(),
                verify=lambda *_: {"status": "failed"},
                root=root,
            )
            self.assertEqual(result["status"], "stopped")
            self.assertNotIn("program", result)


if __name__ == "__main__":
    unittest.main()
