"""Program inventory: verified sequences, not hard-coded click coordinates.

A stored program keeps the visual basis, preconditions, action intent, expected
result and the executor version. Coordinates from an old observation are
evidence only; replay re-localizes the target on a fresh observation and stops
on any state mismatch instead of reusing the old point.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
import json
from pathlib import Path
import re
from uuid import uuid4

from .action_contract import EXECUTOR_VERSION, SCHEMA_VERSION
from .proof import ProofError, make_proof, verify_proof

_PROGRAM_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_HEX64 = re.compile(r"^[0-9a-f]{64}$")


class ProgramRefused(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class ProgramStep:
    step_id: str
    target_label: str
    visual_basis: dict
    preconditions: dict
    action: dict
    expected: dict

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class ProgramRecord:
    program_id: str
    program_version: int
    task: str
    executor_version: str
    steps: tuple[ProgramStep, ...]
    verification: dict
    created_at: str
    schema_version: int = SCHEMA_VERSION

    def to_dict(self) -> dict:
        return {"schema_version": self.schema_version, "program_id": self.program_id,
                "program_version": self.program_version, "task": self.task,
                "executor_version": self.executor_version,
                "steps": [step.to_dict() for step in self.steps],
                "verification": self.verification, "created_at": self.created_at}


def _require(condition, code: str, message: str) -> None:
    if not condition:
        raise ProgramRefused(code, message)


def _int(value, code: str, message: str) -> int:
    _require(type(value) is int, code, message)
    return value


def _str(value, code: str, message: str) -> str:
    _require(isinstance(value, str) and bool(value), code, message)
    return value


def _sha(value, code: str) -> str:
    text = _str(value, code, f"{code} must be a SHA-256 hex string").lower()
    _require(bool(_HEX64.match(text)), code, "SHA-256 must be 64 lowercase hex characters")
    return text


def _windows_path(root: Path, program_id: str, version: int) -> Path:
    _require(bool(_PROGRAM_ID.match(program_id)), "PROGRAM_ID_INVALID", "program_id contains unsupported characters")
    _require(type(version) is int and 1 <= version <= 100_000, "PROGRAM_VERSION_INVALID", "program_version is invalid")
    base = (root / "runtime" / "programs" / program_id).resolve()
    _require(base.is_relative_to((root / "runtime" / "programs").resolve()), "PROGRAM_PATH_INVALID",
             "Program path escapes runtime/programs")
    return base / f"v{version}.json"


def parse_program(payload: dict, *, allow_verified: bool = False) -> ProgramRecord:
    _require(isinstance(payload, dict), "PROGRAM_INVALID", "program must be an object")
    _require(_int(payload.get("schema_version"), "PROGRAM_INVALID", "schema_version is required") == SCHEMA_VERSION,
             "PROGRAM_INVALID", f"schema_version must be {SCHEMA_VERSION}")
    program_id = _str(payload.get("program_id"), "PROGRAM_INVALID", "program_id is required")
    _require(bool(_PROGRAM_ID.match(program_id)), "PROGRAM_ID_INVALID", "program_id contains unsupported characters")
    version = _int(payload.get("program_version"), "PROGRAM_INVALID", "program_version is required")
    _require(1 <= version <= 100_000, "PROGRAM_VERSION_INVALID", "program_version is invalid")
    task = _str(payload.get("task"), "PROGRAM_INVALID", "task is required")
    executor_version = _str(payload.get("executor_version"), "PROGRAM_INVALID", "executor_version is required")
    created_at = _str(payload.get("created_at"), "PROGRAM_INVALID", "created_at is required")
    steps_raw = payload.get("steps")
    _require(isinstance(steps_raw, list) and steps_raw, "PROGRAM_INVALID", "steps must be a non-empty list")
    steps = []
    seen = set()
    for raw in steps_raw:
        _require(isinstance(raw, dict), "PROGRAM_INVALID", "each step must be an object")
        step_id = _str(raw.get("step_id"), "PROGRAM_INVALID", "step_id is required")
        _require(step_id not in seen, "PROGRAM_INVALID", "step_id values must be unique")
        seen.add(step_id)
        target_label = _str(raw.get("target_label"), "PROGRAM_INVALID", "target_label is required")
        basis = raw.get("visual_basis")
        _require(isinstance(basis, dict), "PROGRAM_INVALID", "visual_basis is required")
        _str(basis.get("observation_id"), "PROGRAM_INVALID", "visual_basis.observation_id is required")
        _sha(basis.get("image_sha256"), "PROGRAM_INVALID")
        _require(isinstance(basis.get("capture_bounds"), dict), "PROGRAM_INVALID",
                 "visual_basis.capture_bounds is required")
        center = basis.get("target_center")
        _require(isinstance(center, list) and len(center) == 2 and all(type(v) is int for v in center),
                 "PROGRAM_INVALID", "visual_basis.target_center must be [x, y]")
        preconditions = raw.get("preconditions")
        _require(isinstance(preconditions, dict), "PROGRAM_INVALID", "preconditions are required")
        action = raw.get("action")
        _require(isinstance(action, dict), "PROGRAM_INVALID", "action is required")
        _require(action.get("type") == "click" and action.get("target_label") == target_label,
                 "PROGRAM_INVALID", "action must be a click on target_label")
        for forbidden in ("center", "screen_point", "point", "x", "y"):
            _require(forbidden not in action, "COORDINATE_IN_ACTION",
                     "Stored actions must not contain reusable coordinates")
        expected = raw.get("expected")
        _require(isinstance(expected, dict), "PROGRAM_INVALID", "expected is required")
        _str(expected.get("description"), "PROGRAM_INVALID", "expected.description is required")
        steps.append(ProgramStep(step_id, target_label, basis, preconditions, action, expected))
    verification = payload.get("verification")
    _require(isinstance(verification, dict), "PROGRAM_INVALID", "verification is required")
    _require(verification.get("status") in ("draft", "verified"), "PROGRAM_INVALID",
             "verification.status must be draft or verified")
    if verification.get("status") == "verified" and not allow_verified:
        raise ProgramRefused("PROGRAM_VERIFICATION_NOT_ACCEPTED",
                             "External input can only create a draft; verify it through the verifier component")
    return ProgramRecord(program_id, version, task, executor_version, tuple(steps), verification, created_at)


def save_program(root: Path | str, program: ProgramRecord) -> Path:
    """Persist only a re-run verified program. Drafts and coordinator mismatches never enter the inventory."""
    root = Path(root).resolve()
    program = parse_program(program.to_dict(), allow_verified=True)
    try:
        verify_proof(root, program)
    except ProofError as error:
        raise ProgramRefused(error.code, error.message) from None
    _require(program.executor_version == EXECUTOR_VERSION, "PROGRAM_EXECUTOR_VERSION_MISMATCH",
             "Program was created by a different executor version; re-verify it")
    verification = program.verification
    _require(verification.get("status") == "verified", "PROGRAM_NOT_VERIFIED",
             "Only a verified program can be stored")
    _require(verification.get("executor_version") == EXECUTOR_VERSION, "PROGRAM_EXECUTOR_VERSION_MISMATCH",
             "Verification used a different executor version")
    runs = verification.get("runs")
    _require(isinstance(runs, list) and runs, "PROGRAM_NOT_VERIFIED", "A verified program needs at least one run")
    for run in runs:
        _require(isinstance(run, dict), "PROGRAM_NOT_VERIFIED", "verification run is invalid")
        _require(run.get("ok") is True and run.get("expected_matched") is True
                 and run.get("fresh_observation") is True, "PROGRAM_NOT_VERIFIED",
                 "Every verification run must succeed on a fresh observation and matched expectation")
        _require(run.get("executor_version") == EXECUTOR_VERSION, "PROGRAM_EXECUTOR_VERSION_MISMATCH",
                 "Run used a different executor version")
        ids = run.get("observation_ids")
        _require(isinstance(ids, list) and len(ids) == len(program.steps), "PROGRAM_NOT_VERIFIED",
                 "Run must record one fresh observation per step")
        for step, observation_id in zip(program.steps, ids):
            _require(observation_id != step.visual_basis["observation_id"], "PROGRAM_NOT_VERIFIED",
                     "Verification reused the original observation instead of a fresh one")
    path = _windows_path(root, program.program_id, program.program_version)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("x", encoding="utf-8") as file:
            json.dump(program.to_dict(), file, ensure_ascii=False, indent=2)
    except FileExistsError:
        raise ProgramRefused("PROGRAM_ALREADY_STORED", "This program version is already stored") from None
    return path


def load_program(root: Path | str, program_id: str, version: int) -> ProgramRecord:
    root = Path(root).resolve()
    path = _windows_path(root, program_id, version)
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        raise ProgramRefused("PROGRAM_NOT_FOUND", "Program is not stored") from None
    program = parse_program(payload, allow_verified=True)
    _require(program.program_id == program_id and program.program_version == version,
             "PROGRAM_INVALID", "Stored program identity does not match its path")
    try:
        verify_proof(root, program)
    except ProofError as error:
        raise ProgramRefused(error.code, error.message) from None
    return program


def check_preconditions(step: ProgramStep, observation: dict) -> None:
    """Stop on any identity mismatch. Never auto-remap to a new window."""
    _require(isinstance(observation, dict) and isinstance(observation.get("window"), dict),
             "OBSERVATION_INVALID", "Replay needs a bound observation window")
    expected = step.preconditions.get("window")
    if expected is None:
        return
    _require(isinstance(expected, dict), "PROGRAM_INVALID", "preconditions.window must be an object")
    actual = observation["window"]
    for key, value in expected.items():
        _require(key in actual and actual[key] == value, "STATE_MISMATCH",
                 f"Window precondition changed: {key}")


def replay(program: ProgramRecord, *, observe, locate, client, verify, allow_draft: bool = False,
           root: Path | str | None = None, require_proof: bool = False) -> dict:
    """Re-run with fresh observations; stop or replan on any mismatch. No retry."""
    status = program.verification.get("status")
    if status != "verified" and not allow_draft:
        return {"status": "refused", "reason": "PROGRAM_NOT_VERIFIED"}
    if status not in ("draft", "verified"):
        return {"status": "refused", "reason": "PROGRAM_NOT_VERIFIED"}
    if status == "verified" and require_proof:
        if root is None:
            return {"status": "refused", "reason": "PROGRAM_PROOF_ROOT_MISSING"}
        try:
            verify_proof(Path(root).resolve(), program)
        except ProofError as error:
            return {"status": "refused", "reason": error.code, "message": error.message}
    if program.executor_version != EXECUTOR_VERSION:
        return {"status": "replan_required", "reason": "EXECUTOR_VERSION_CHANGED"}
    observation_ids = []
    receipts = []

    def _stop(payload: dict) -> dict:
        return {**payload, "receipts": receipts, "observation_ids": observation_ids}

    for step in program.steps:
        try:
            observation = observe(step)
        except ProgramRefused as error:
            return _stop({"status": "stopped", "reason": error.code, "step_id": step.step_id,
                          "message": error.message})
        except Exception as error:
            return _stop({"status": "stopped", "reason": "OBSERVATION_FAILED", "step_id": step.step_id,
                          "message": f"{type(error).__name__}: {str(error)[:200]}"})
        try:
            check_preconditions(step, observation)
        except ProgramRefused as error:
            return _stop({"status": "replan_required", "reason": error.code, "step_id": step.step_id,
                          "message": error.message})
        fresh_id = observation.get("observation_id")
        if not isinstance(fresh_id, str) or not fresh_id:
            return _stop({"status": "replan_required", "reason": "OBSERVATION_INVALID",
                          "step_id": step.step_id})
        if fresh_id == step.visual_basis["observation_id"]:
            return _stop({"status": "replan_required", "reason": "OBSERVATION_NOT_FRESH",
                          "step_id": step.step_id})
        try:
            center = locate(step, observation)
        except Exception as error:
            return _stop({"status": "stopped", "reason": "LOCATE_FAILED", "step_id": step.step_id,
                          "message": type(error).__name__})
        if center is None:
            return _stop({"status": "replan_required", "reason": "TARGET_NOT_FOUND",
                          "step_id": step.step_id})
        try:
            request = client.build(observation["manifest"], step.target_label, center,
                                   step.expected.get("description", ""))
        except Exception as error:
            return _stop({"status": "stopped", "reason": "REQUEST_BUILD_FAILED", "step_id": step.step_id,
                          "message": type(error).__name__})
        try:
            receipt = client.execute(request)
        except Exception as error:
            return _stop({"status": "stopped", "reason": "EXECUTOR_LAUNCH_FAILED",
                          "step_id": step.step_id, "message": type(error).__name__})
        if not isinstance(receipt, dict) or not receipt.get("ok"):
            return _stop({"status": "stopped", "reason": receipt.get("error_code", "EXECUTOR_REFUSED")
                          if isinstance(receipt, dict) else "EXECUTOR_REFUSED",
                          "step_id": step.step_id, "receipt": receipt})
        if receipt.get("observation_id") != fresh_id:
            return _stop({"status": "stopped", "reason": "OBSERVATION_ID_MISMATCH",
                          "step_id": step.step_id, "receipt": receipt})
        try:
            verdict = verify(step, receipt, observation)
        except Exception as error:
            return _stop({"status": "stopped", "reason": "VERIFY_FAILED", "step_id": step.step_id,
                          "message": type(error).__name__})
        if not isinstance(verdict, dict) or verdict.get("status") not in ("passed", "failed", "unknown"):
            return _stop({"status": "stopped", "reason": "VERIFIER_PROTOCOL_INVALID",
                          "step_id": step.step_id, "verification": verdict})
        if verdict["status"] != "passed":
            return _stop({"status": "stopped",
                          "reason": "EXPECTED_UNKNOWN" if verdict["status"] == "unknown" else "EXPECTED_NOT_VERIFIED",
                          "step_id": step.step_id, "verification": verdict, "receipt": receipt})
        observation_ids.append(fresh_id)
        receipts.append(receipt)
    return {"status": "completed", "receipts": receipts,
            "run": {"run_id": str(uuid4()), "started_at": datetime.now(timezone.utc).isoformat(),
                    "ok": True, "expected_matched": True, "fresh_observation": True,
                    "executor_version": EXECUTOR_VERSION, "observation_ids": observation_ids,
                    "receipts": receipts}}


def verify_program(program: ProgramRecord, *, observe, locate, client, verify,
                   root: Path | str | None = None) -> dict:
    """Run the replay; on success return a verified record with a content-bound proof."""
    result = replay(program, observe=observe, locate=locate, client=client, verify=verify, allow_draft=True)
    if result.get("status") != "completed":
        return result
    if root is None:
        return {"status": "stopped", "reason": "PROOF_ROOT_REQUIRED"}
    candidate = replace(program, verification={"status": "verified", "executor_version": EXECUTOR_VERSION,
                                               "runs": [result["run"]]})
    try:
        proof = make_proof(Path(root).resolve(), candidate)
    except ProofError as error:
        return {"status": "stopped", "reason": error.code, "message": error.message}
    verified = replace(candidate, verification={**candidate.verification, "proof": proof})
    return {**result, "program": verified}
