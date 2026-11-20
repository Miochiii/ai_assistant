import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from desktop_adapter.snapshot import Limits, collect


class FakeNode:
    pid = 10
    visible = True
    password = False

    def __init__(self, name="test", children=()):
        self.name, self.items, self.read_count = name, children, 0

    def read(self, limit):
        self.read_count += 1
        return {"name": self.name, "control_type": "Button", "automation_id": "id", "text": ""}

    def children(self):
        return iter(self.items)


class SnapshotTests(unittest.TestCase):
    identity = {"hwnd": 42, "pid": 10}

    def test_password_and_children_are_never_read(self):
        secret = FakeNode("secret", [FakeNode("also secret")])
        secret.password = True
        result = collect(FakeNode(children=[secret]), self.identity)
        self.assertEqual(secret.read_count, 0)
        self.assertNotIn("secret", str(result))
        self.assertIn("PASSWORD_SUBTREE_SKIPPED", result["issues"])

    def test_unknown_password_flag_fails_closed(self):
        class Unknown(FakeNode):
            @property
            def password(self):
                raise RuntimeError("stale")
        child = Unknown("private")
        result = collect(child, self.identity)
        self.assertEqual(child.read_count, 0)
        self.assertIn("SECURITY_STATE_UNAVAILABLE", result["issues"])

    def test_cross_process_nodes_are_skipped(self):
        other = FakeNode("other app")
        other.pid = 11
        result = collect(other, self.identity)
        self.assertEqual(result["nodes"], [])
        self.assertEqual(other.read_count, 0)

    def test_limits_bound_even_infinite_children(self):
        class Infinite(FakeNode):
            def children(self):
                while True:
                    yield FakeNode()
        result = collect(Infinite(), self.identity, Limits(max_nodes=5))
        self.assertEqual(result["visited_nodes"], 5)
        self.assertIn("NODE_LIMIT", result["issues"])

    def test_depth_bound(self):
        leaf = FakeNode("unvisited")
        result = collect(FakeNode(children=[leaf]), self.identity, Limits(max_depth=0))
        self.assertEqual(leaf.read_count, 0)
        self.assertIn("DEPTH_BOUNDARY", result["issues"])

    def test_total_text_bound(self):
        result = collect(FakeNode("a" * 1000), self.identity, Limits(max_text_chars=7))
        self.assertEqual(result["text_chars"], 7)
        self.assertEqual(len(result["nodes"][0]["name"]), 7)
        self.assertFalse(result["complete"])

    def test_new_observation_ids_with_stable_content_hash(self):
        first = collect(FakeNode(), self.identity)
        second = collect(FakeNode(), self.identity)
        self.assertNotEqual(first["observation_id"], second["observation_id"])
        self.assertNotEqual(first["nodes"][0]["element_id"], second["nodes"][0]["element_id"])
        self.assertEqual(first["interface_version"], second["interface_version"])
        self.assertFalse(first["actionable"])

    def test_partial_read_marks_incomplete(self):
        class Broken(FakeNode):
            def read(self, limit):
                raise RuntimeError("disappeared")
        result = collect(FakeNode(children=[Broken()]), self.identity)
        self.assertEqual(len(result["nodes"]), 1)
        self.assertFalse(result["complete"])
        self.assertIn("ELEMENT_READ_FAILED", result["issues"])


if __name__ == "__main__":
    unittest.main()
