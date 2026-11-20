"""Cross-process desktop input lease.

Only the fixed executor takes this lease before sending input. It is a local
admission lock, not window authorization and not proof that the last action
completed. A crashed holder releases the OS lock, but the last input may still
have happened; callers must inspect receipts instead of replaying blindly.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import os
from pathlib import Path


class DesktopLeaseError(RuntimeError):
    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code
        self.message = message or code


def _stamp():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def _shared_lease_path() -> Path:
    override = os.environ.get("DSH_DESKTOP_INPUT_LEASE")
    if override:
        return Path(override).resolve()
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("TEMP") or str(Path.home())
    return Path(base).resolve() / "DeepSeekHarness" / "locks" / "desktop-input.lock"


@contextmanager
def desktop_input_lease(root: str | Path, *, shared: bool = True):
    """Acquire the desktop input lease.

    By default the lock is user/Windows-session-global so separate projects and
    entry points cannot send desktop input in parallel. ``shared=False`` is for
    isolated tests only and must not be used by production entry points.
    """
    root = Path(root).resolve()
    path = _shared_lease_path() if shared else root / "runtime" / "locks" / "desktop-input.lock"
    directory = path.parent
    directory.mkdir(parents=True, exist_ok=True)
    handle = open(path, "a+b")
    try:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        acquired = False
        try:
            if os.name == "nt":
                import msvcrt
                try:
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                except OSError:
                    raise DesktopLeaseError("DESKTOP_BUSY", "Another desktop input lease is active") from None
            else:
                import fcntl
                try:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                except OSError:
                    raise DesktopLeaseError("DESKTOP_BUSY", "Another desktop input lease is active") from None
            acquired = True
            yield {"lease": "desktop-input", "path": str(path),
                   "scope": "user" if shared else "project", "acquired_at": _stamp()}
        finally:
            if acquired:
                try:
                    if os.name == "nt":
                        import msvcrt
                        handle.seek(0)
                        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
                except OSError:
                    pass
    finally:
        handle.close()
