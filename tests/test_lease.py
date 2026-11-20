from pathlib import Path
import os
import shutil
import sys
import unittest
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from desktop_adapter.lease import DesktopLeaseError, desktop_input_lease


class LeaseTests(unittest.TestCase):
    def setUp(self):
        self.root = ROOT / "runtime" / "lease-tests" / str(uuid4())
        self.root.mkdir(parents=True)
        self.addCleanup(self.cleanup)

    def cleanup(self):
        target = self.root.resolve()
        if not target.is_relative_to((ROOT / "runtime" / "lease-tests").resolve()):
            raise RuntimeError("cleanup escaped test workspace")
        shutil.rmtree(target, ignore_errors=True)

    def test_second_lease_is_refused_and_released(self):
        with desktop_input_lease(self.root, shared=False) as lease:
            self.assertEqual(lease["lease"], "desktop-input")
            with self.assertRaises(DesktopLeaseError) as context:
                with desktop_input_lease(self.root, shared=False):
                    pass
            self.assertEqual(context.exception.code, "DESKTOP_BUSY")
        with desktop_input_lease(self.root, shared=False):
            pass

    def test_lock_parent_is_created(self):
        nested = self.root / "nested"
        with desktop_input_lease(nested, shared=False):
            self.assertTrue((nested / "runtime" / "locks" / "desktop-input.lock").is_file())

    def test_shared_lease_covers_multiple_projects(self):
        previous = os.environ.get("DSH_DESKTOP_INPUT_LEASE")
        path = self.root / "shared" / "desktop-input.lock"
        os.environ["DSH_DESKTOP_INPUT_LEASE"] = str(path)
        try:
            other = self.root / "other-project"
            with desktop_input_lease(self.root) as lease:
                self.assertEqual(lease["scope"], "user")
                self.assertEqual(Path(lease["path"]), path.resolve())
                with self.assertRaises(DesktopLeaseError) as context:
                    with desktop_input_lease(other):
                        pass
                self.assertEqual(context.exception.code, "DESKTOP_BUSY")
            with desktop_input_lease(other):
                pass
        finally:
            if previous is None:
                os.environ.pop("DSH_DESKTOP_INPUT_LEASE", None)
            else:
                os.environ["DSH_DESKTOP_INPUT_LEASE"] = previous


if __name__ == "__main__":
    unittest.main()
