"""Content-bound program proof.

The proof is an HMAC over the program content, visual-basis hashes, template
hashes, executor/verifier versions and verification-run hashes. The key lives
outside the program inventory. This is a local trust boundary: external JSON
or tool input cannot mint a proof without the verifier component and key.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
from pathlib import Path

PROOF_VERSION = 1
VERIFIER_VERSION = "b03-visual-template-v1"
KEY_BYTES = 32


class ProofError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _canonical(value) -> bytes:
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def program_content(program) -> dict:
    return {"schema_version": program.schema_version, "program_id": program.program_id,
            "program_version": program.program_version, "task": program.task,
            "executor_version": program.executor_version,
            "steps": [step.to_dict() for step in program.steps],
            "created_at": program.created_at}


def _template_hashes(root: Path, program) -> dict:
    hashes = {}
    for step in program.steps:
        expected = step.expected or {}
        template = expected.get("template")
        if not isinstance(template, str) or not template:
            raise ProofError("PROGRAM_TEMPLATE_MISSING", "Every step needs an expected template")
        path = Path(template)
        if not path.is_absolute():
            path = root / path
        try:
            path = path.resolve(strict=True)
        except OSError:
            raise ProofError("PROGRAM_TEMPLATE_MISSING", "Expected template does not exist") from None
        if not path.is_relative_to((root / "runtime" / "templates").resolve()):
            raise ProofError("PROGRAM_TEMPLATE_PATH_INVALID",
                             "Expected templates must stay under runtime/templates")
        try:
            relative = str(path.relative_to(root.resolve())).replace("\\", "/")
        except ValueError:
            raise ProofError("PROGRAM_TEMPLATE_PATH_INVALID", "Template must stay inside the project") from None
        hashes[relative] = _sha256(path.read_bytes())
    return hashes


def _basis_hashes(program) -> list[str]:
    hashes = []
    for step in program.steps:
        value = (step.visual_basis or {}).get("image_sha256")
        if not isinstance(value, str) or len(value) != 64:
            raise ProofError("PROGRAM_BASIS_HASH_MISSING", "Every step needs a visual-basis image hash")
        hashes.append(value.lower())
    return hashes


def _run_hashes(program) -> list[str]:
    runs = (program.verification or {}).get("runs")
    if not isinstance(runs, list) or not runs:
        raise ProofError("PROGRAM_RUNS_MISSING", "A verified program needs verification runs")
    return [_sha256(_canonical(run)) for run in runs]


def _key(root: Path) -> bytes:
    path = root / "runtime" / "keys" / "program-proof.key"
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file():
        key = path.read_bytes()
        if len(key) < KEY_BYTES:
            raise ProofError("PROGRAM_PROOF_KEY_INVALID", "Program proof key is too short")
        return key
    key = os.urandom(KEY_BYTES)
    try:
        with path.open("xb") as file:
            file.write(key)
    except FileExistsError:
        key = path.read_bytes()
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return key


def make_proof(root: Path, program) -> dict:
    if (program.verification or {}).get("status") != "verified":
        raise ProofError("PROGRAM_NOT_VERIFIED", "Only a verified program can be proven")
    payload = {"proof_version": PROOF_VERSION, "verifier_version": VERIFIER_VERSION,
               "executor_version": program.executor_version,
               "program_sha256": _sha256(_canonical(program_content(program))),
               "basis_sha256": _basis_hashes(program),
               "template_sha256": _template_hashes(root, program),
               "run_sha256": _run_hashes(program)}
    signature = hmac.new(_key(root), _canonical(payload), hashlib.sha256).hexdigest()
    return {**payload, "hmac": signature}


def verify_proof(root: Path, program) -> None:
    if (program.verification or {}).get("status") != "verified":
        raise ProofError("PROGRAM_NOT_VERIFIED", "Program is not verified")
    proof = (program.verification or {}).get("proof")
    if not isinstance(proof, dict):
        raise ProofError("PROGRAM_PROOF_MISSING", "Verified program has no proof")
    payload = {key: proof[key] for key in
               ("proof_version", "verifier_version", "executor_version", "program_sha256",
                "basis_sha256", "template_sha256", "run_sha256") if key in proof}
    signature = proof.get("hmac")
    if not isinstance(signature, str):
        raise ProofError("PROGRAM_PROOF_INVALID", "Program proof has no signature")
    expected = hmac.new(_key(root), _canonical(payload), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        raise ProofError("PROGRAM_PROOF_INVALID", "Program proof signature does not match")
    if payload.get("proof_version") != PROOF_VERSION or payload.get("verifier_version") != VERIFIER_VERSION:
        raise ProofError("PROGRAM_PROOF_INVALID", "Program proof version is unsupported")
    if payload.get("executor_version") != program.executor_version:
        raise ProofError("PROGRAM_PROOF_INVALID", "Program proof executor version changed")
    if payload.get("program_sha256") != _sha256(_canonical(program_content(program))):
        raise ProofError("PROGRAM_PROOF_INVALID", "Program content changed after verification")
    if payload.get("basis_sha256") != _basis_hashes(program):
        raise ProofError("PROGRAM_PROOF_INVALID", "Visual basis hashes changed")
    if payload.get("run_sha256") != _run_hashes(program):
        raise ProofError("PROGRAM_PROOF_INVALID", "Verification runs changed")
    if payload.get("template_sha256") != _template_hashes(root, program):
        raise ProofError("PROGRAM_PROOF_INVALID", "Template files changed after verification")
