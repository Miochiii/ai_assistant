"""Shared action client for planning and replay.

DeepSeek planning and future PreAct replay must call this client instead of
calling Win32 input directly. It launches the fixed executor with a
Medium-integrity Python taken from the venv's pyvenv.cfg and passes one
contract request over stdin.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
from typing import Callable
from uuid import uuid4

from .action_contract import EXECUTOR_VERSION, build_action_request
from .executor import INTEGRITY_MEDIUM, integrity_name, token_integrity


class ExecutorError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def resolve_base_python(root: Path | str) -> Path:
    """Read the venv's recorded base interpreter; never use the Low-labeled venv exe."""
    root = Path(root).resolve()
    config = root / ".venv" / "pyvenv.cfg"
    try:
        text = config.read_text(encoding="utf-8-sig")
    except OSError:
        text = ""
    for line in text.splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.strip() != "base-executable":
            continue
        candidate = Path(value.strip().strip('"'))
        if candidate.is_file():
            return candidate
    fallback = os.environ.get("DSH_BASE_PYTHON")
    if fallback and Path(fallback).is_file():
        return Path(fallback)
    raise ExecutorError("EXECUTOR_PYTHON_MISSING",
                        "Cannot resolve the base Python from .venv/pyvenv.cfg or DSH_BASE_PYTHON")


class ActionClient:
    """One restricted action interface; no other component should send input."""

    def __init__(self, root: Path | str, *, runner: Callable[[dict], dict] | None = None,
                 timeout: float = 120.0, grant_id: str | None = None,
                 harness_session: str | None = None):
        self.root = Path(root).resolve()
        self.runner = runner
        self.timeout = timeout
        self.grant_id = grant_id
        self.harness_session = harness_session if harness_session is not None else os.environ.get("DSH_SESSION_ID")

    def build(self, manifest: Path | str, label: str, center, expected: str = "") -> dict:
        return build_action_request(manifest, label, center, expected, root=self.root,
                                    grant_id=self.grant_id)

    def _client_integrity_refusal(self) -> dict | None:
        """A Low client cannot create a Medium child; refuse before spawning."""
        rid = token_integrity(os.getpid())
        if rid == INTEGRITY_MEDIUM:
            return None
        return {"ok": False, "error_code": "CLIENT_INTEGRITY_NOT_MEDIUM",
                "client_integrity": integrity_name(rid),
                "message": "The action client must run in the Medium-integrity Harness process"}

    def execute(self, request: dict) -> dict:
        if self.runner is not None:
            return self.runner(request)
        refusal = self._client_integrity_refusal()
        if refusal is not None:
            raise ExecutorError(refusal["error_code"], refusal["message"])
        python = resolve_base_python(self.root)
        script = self.root / "scripts" / "desktop_executor.py"
        if not script.is_file():
            raise ExecutorError("EXECUTOR_SCRIPT_MISSING", "desktop_executor.py is missing")
        command = [str(python), "-B", str(script), "--request", "-"]
        cancellation = self.root / "runtime" / "cancellations" / f"{uuid4()}.cancel"
        cancellation.parent.mkdir(parents=True, exist_ok=True)
        env = {**os.environ, "DSH_EXECUTOR_CANCEL_FILE": str(cancellation),
               "DSH_SESSION_ID": self.harness_session or ""}
        try:
            process = subprocess.Popen(
                command, cwd=self.root, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", env=env,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except OSError as error:
            raise ExecutorError("EXECUTOR_LAUNCH_FAILED", type(error).__name__) from None
        try:
            try:
                stdout, stderr = process.communicate(
                    input=json.dumps(request, ensure_ascii=False), timeout=self.timeout)
            except subprocess.TimeoutExpired:
                try:
                    cancellation.write_text("cancel", encoding="utf-8")
                except OSError:
                    pass
                try:
                    process.communicate(timeout=1.5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate()
                raise ExecutorError("EXECUTOR_TIMEOUT",
                                    "Executor timed out; outcome unknown, no retry") from None
        finally:
            try:
                cancellation.unlink(missing_ok=True)
            except OSError:
                pass
        try:
            result = json.loads(stdout)
        except ValueError:
            raise ExecutorError("EXECUTOR_BAD_OUTPUT",
                                f"Executor returned no JSON (exit {process.returncode})") from None
        if not isinstance(result, dict):
            raise ExecutorError("EXECUTOR_BAD_OUTPUT", "Executor returned a non-object")
        result.setdefault("exit_code", process.returncode)
        result.setdefault("stderr_tail", (stderr or "")[-2000:])
        return result

    def click(self, manifest: Path | str, label: str, center, expected: str = "") -> dict:
        return self.execute(self.build(manifest, label, center, expected))

    def self_check(self) -> dict:
        if self.runner is not None:
            return {"ok": True, "executor_version": EXECUTOR_VERSION, "fixture": True}
        refusal = self._client_integrity_refusal()
        if refusal is not None:
            return {**refusal, "executor_version": EXECUTOR_VERSION,
                    "client_integrity_rid": token_integrity(os.getpid())}
        python = resolve_base_python(self.root)
        script = self.root / "scripts" / "desktop_executor.py"
        try:
            completed = subprocess.run(
                [str(python), "-B", str(script), "--self-check"], cwd=self.root,
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                timeout=30, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except (OSError, subprocess.TimeoutExpired) as error:
            raise ExecutorError("EXECUTOR_LAUNCH_FAILED", type(error).__name__) from None
        try:
            result = json.loads(completed.stdout)
        except ValueError:
            raise ExecutorError("EXECUTOR_BAD_OUTPUT", "Self-check returned no JSON") from None
        result.setdefault("exit_code", completed.returncode)
        return result
