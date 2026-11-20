"""PreAct-facing replay adapter.

PreAct should call this adapter (or the CLI) instead of assembling its own
window/observation/click logic. It keeps the same four boundaries:

- Activate the target window (focus only, no mouse/keyboard).
- Take a fresh action-ready observation.
- Localize the stored target on the fresh image (target-patch match).
- Execute through ActionClient / the fixed executor, then verify with B03.

Any mismatch returns replan_required/stopped; there is no automatic retry.
"""
from __future__ import annotations

import hashlib
import inspect
import json
from contextlib import nullcontext
from pathlib import Path
from time import perf_counter
from typing import Callable

import desktop_click_trial
import window_activate
from desktop_adapter.action_client import ActionClient
from desktop_adapter.authorization import GrantError, check_grant, load_grant, select_grant
from desktop_adapter.inventory import ProgramRefused, replay, verify_program
from desktop_adapter.locate import locate_patch
from desktop_adapter.single_click import Win32Desktop
from desktop_adapter.verify import compare_template


def find_basis_image(root: Path, observation_id: str) -> Path:
    for manifest_path in (root / "results/vision").glob("*/observation.json"):
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if manifest.get("observation_id") == observation_id:
            return Path(manifest["image"]["path"])
    raise FileNotFoundError("Visual-basis observation image not found")


class ProgramReplayAdapter:
    """One program, per-step preflight, fresh observation and one execute/verify attempt per step."""

    def __init__(self, root: Path, program, *, desktop=None, window_source: Callable | None = None,
                 activator: Callable | None = None, observer: Callable | None = None,
                 client=None, verifier: Callable | None = None, basis_image: Path | None = None,
                 margin: int = 5, patch_size: tuple[int, int] = (64, 40),
                 tolerance: int = 16, min_similarity: float = 0.98,
                 require_proof: bool = True, grant_id: str | None = None,
                 harness_session: str | None = None, require_authorization: bool = True,
                 locator: Callable | None = None, search_radius: int = 64, stride: int = 4,
                 min_margin: float = 0.005, min_separation: int = 32,
                 allow_draft: bool = False):
        self.root = Path(root).resolve()
        self.program = program
        self.desktop = desktop if desktop is not None else Win32Desktop()
        self.window_source = window_source or self.desktop.list_windows
        self.activator = activator or window_activate.activate
        self.observer = observer or desktop_click_trial.observe
        self.client = client or ActionClient(self.root, harness_session=harness_session)
        self.verifier = verifier or compare_template
        self.margin = margin
        self.patch_size = patch_size
        self.tolerance = tolerance
        self.min_similarity = min_similarity
        self.require_proof = require_proof
        self.grant_id = grant_id
        self.harness_session = harness_session
        self.require_authorization = require_authorization
        self.grant: dict | None = None
        self.locator = locator or locate_patch
        self.search_radius = search_radius
        self.stride = stride
        self.min_margin = min_margin
        self.min_separation = min_separation
        self.allow_draft = allow_draft
        self.location: dict | None = None
        self.basis_image = Path(basis_image) if basis_image is not None else None
        self.window: dict | None = None
        self.activation: dict | None = None
        self.region: tuple[int, int, int, int] | None = None
        self.states: dict[str, dict] = {}
        self.windows: list[dict] | None = None

    def _preflight(self, step, index: int) -> dict:
        if index == 0 and self.basis_image is not None:
            basis = self.basis_image
        else:
            try:
                basis = find_basis_image(self.root, step.visual_basis["observation_id"])
            except FileNotFoundError:
                return {"status": "replan_required", "reason": "BASIS_IMAGE_MISSING"}
        if not basis.is_file():
            return {"status": "replan_required", "reason": "BASIS_IMAGE_MISSING"}
        if hashlib.sha256(basis.read_bytes()).hexdigest() != step.visual_basis["image_sha256"]:
            return {"status": "replan_required", "reason": "BASIS_IMAGE_HASH_MISMATCH"}
        basis_manifest = {}
        try:
            candidate = basis.parent / "observation.json"
            if candidate.is_file():
                basis_manifest = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            basis_manifest = {}
        if self.windows is None:
            try:
                self.windows = self.window_source()
            except Exception:
                return {"status": "stopped", "reason": "WINDOW_ENUMERATION_FAILED"}
        preconditions = step.preconditions.get("window", {})
        matches = [window for window in self.windows
                   if all(window.get(key) == value for key, value in preconditions.items())]
        if len(matches) != 1:
            return {"status": "replan_required",
                    "reason": "WINDOW_NOT_FOUND" if not matches else "WINDOW_AMBIGUOUS"}
        window = matches[0]
        grant = None
        if self.require_authorization:
            try:
                if self.grant_id:
                    grant = load_grant(self.root, self.grant_id)
                    check_grant(grant, window=window, action="replay",
                                program_id=self.program.program_id)
                else:
                    grant = select_grant(self.root, window=window, action="replay",
                                         harness_session=self.harness_session,
                                         program_id=self.program.program_id)
            except GrantError as error:
                return {"status": "stopped", "reason": error.code, "message": error.message}
        try:
            context = self.desktop.window_context(window["hwnd"])
        except Exception as error:
            context = {"available": False, "error_code": type(error).__name__}
        capture = step.visual_basis["capture_bounds"]
        width = int(capture["width"])
        height = int(capture["height"])
        space = step.visual_basis.get("region_space", "outer_margin")
        clipped = False
        if space in {"client", "window"}:
            if not context.get("geometry"):
                return {"status": "replan_required", "reason": "WINDOW_CONTEXT_UNAVAILABLE"}
            try:
                from desktop_adapter.window_context import WindowContextError, region_from_context
                left, top, width, height = region_from_context(context, space, width, height)
            except Exception as error:
                code = getattr(error, "code", "WINDOW_GEOMETRY_UNAVAILABLE")
                if code != "WINDOW_TOO_SMALL":
                    return {"status": "replan_required", "reason": code}
                # A window resize does not scale UI pixels. Capture the current
                # full client/visible frame from the same origin; the locator
                # accepts a different fresh canvas size.
                rect = (context.get("geometry", {}).get("client_rect_screen_px")
                        if space == "client"
                        else context.get("geometry", {}).get("visible_frame_rect_screen_px"))
                if not isinstance(rect, dict):
                    return {"status": "replan_required", "reason": "WINDOW_GEOMETRY_UNAVAILABLE"}
                left, top, width, height = rect["left"], rect["top"], rect["width"], rect["height"]
                clipped = True
        elif space == "outer_margin":
            left, top, right, bottom = window["rect"]
            width = min(width, right - left - 2 * self.margin)
            height = min(height, bottom - top - 2 * self.margin)
            left, top = left + self.margin, top + self.margin
        else:
            return {"status": "replan_required", "reason": "REGION_SPACE_UNSUPPORTED"}
        if width <= self.patch_size[0] or height <= self.patch_size[1]:
            return {"status": "replan_required", "reason": "WINDOW_TOO_SMALL"}
        self.states[step.step_id] = {"step_id": step.step_id, "basis": basis, "window": window,
                                     "grant": grant, "region": (left, top, width, height),
                                     "region_space": space, "clipped_to_current_window": clipped,
                                     "window_context": context,
                                     "basis_window_context": basis_manifest.get("window_context") or {}}
        return {"status": "ready"}

    def _activate(self, step) -> None:
        state = self.states[step.step_id]
        try:
            activation = self.activator(state["window"]["hwnd"])
        except Exception:
            raise ProgramRefused("ACTIVATION_FAILED", "Window activation failed") from None
        if not isinstance(activation, dict) or not activation.get("ok"):
            raise ProgramRefused(activation.get("error_code", "ACTIVATION_FAILED")
                                 if isinstance(activation, dict) else "ACTIVATION_FAILED",
                                 "Window activation was not confirmed")
        state["activation"] = activation
        self.activation = activation
        if state.get("grant") is not None and hasattr(self.client, "grant_id"):
            self.client.grant_id = state["grant"]["grant_id"]

    def _observe(self, step) -> dict:
        state = self.states[step.step_id]
        self._activate(step)
        space = state.get("region_space")
        supports_space = False
        try:
            parameters = inspect.signature(self.observer).parameters
            supports_space = ("region_space" in parameters
                              or any(p.kind is inspect.Parameter.VAR_KEYWORD
                                     for p in parameters.values()))
        except (TypeError, ValueError):
            supports_space = False
        if space in {"client", "window", "explicit"} and supports_space:
            result = self.observer(self.desktop, state["window"]["hwnd"], state["region"],
                                   region_space=space)
        else:
            result = self.observer(self.desktop, state["window"]["hwnd"], state["region"])
        manifest = json.loads(Path(result["observation"]).read_text(encoding="utf-8"))
        binding = json.loads((Path(result["observation"]).parent / "click-binding.json")
                             .read_text(encoding="utf-8"))
        timings = result.get("timings") or manifest.get("timings") or {}
        state["observe_timings"] = timings
        return {"manifest": result["observation"], "observation_id": manifest["observation_id"],
                "window": binding["window"], "image_path": manifest["image"]["path"],
                "image_size": (manifest["image"]["width"], manifest["image"]["height"]),
                "timings": timings}

    def _locate(self, step, observation) -> list[int] | None:
        state = self.states[step.step_id]
        x, y = step.visual_basis["target_center"]
        scales = step.visual_basis.get("scale_candidates")
        if scales is None:
            space = state.get("region_space")
            basis_dpi = (state.get("basis_window_context") or {}).get("geometry", {}).get(
                "target_window_dpi")
            fresh_dpi = (state.get("window_context") or {}).get("geometry", {}).get(
                "target_window_dpi")
            if space in {"client", "window"} and isinstance(basis_dpi, int) and isinstance(fresh_dpi, int) \
                    and basis_dpi > 0 and fresh_dpi > 0:
                ratio = round(fresh_dpi / basis_dpi, 3)
                candidates = [1.0]
                if ratio != 1.0:
                    candidates.extend([ratio, 0.8, 1.25, 1.5])
                scales = tuple(sorted({float(v) for v in candidates if 0.5 <= v <= 3.0}))
            else:
                scales = (1.0,)
        elif not isinstance(scales, (list, tuple)):
            scales = (1.0,)
        search_center = step.visual_basis.get("search_center")
        if search_center is not None and (not isinstance(search_center, (list, tuple))
                                          or len(search_center) != 2
                                          or any(type(v) is not int for v in search_center)):
            search_center = None
        started = perf_counter()
        locate_kwargs = {
            "target_center": [x, y],
            "patch_size": self.patch_size,
            "search_radius": self.search_radius,
            "stride": self.stride,
            "tolerance": self.tolerance,
            "min_similarity": self.min_similarity,
            "min_margin": self.min_margin,
            "min_separation": self.min_separation,
        }
        if state.get("region_space") in {"client", "window"} \
                or step.visual_basis.get("scale_candidates") is not None \
                or tuple(scales) != (1.0,):
            locate_kwargs["scales"] = tuple(scales)
        if search_center is not None:
            locate_kwargs["search_center"] = search_center
        location = self.locator(state["basis"], observation["image_path"], **locate_kwargs)
        state["locate_ms"] = round((perf_counter() - started) * 1000, 2)
        state["location"] = location
        state["scales"] = list(scales)
        self.location = location
        if location.get("status") != "found":
            return None
        return list(location["new_center"])

    def _verify(self, step, receipt, observation) -> dict:
        state = self.states[step.step_id]
        after_path = receipt.get("after_observation")
        if not after_path:
            state["verify_ms"] = 0.0
            return {"status": "unknown", "reason": "AFTER_OBSERVATION_MISSING"}
        expected = step.expected
        template = (self.root / expected["template"]).resolve()
        if not template.is_relative_to((self.root / "runtime" / "templates").resolve()):
            state["verify_ms"] = 0.0
            return {"status": "unknown", "reason": "TEMPLATE_PATH_INVALID"}
        before_path = observation.get("image_path")
        if not before_path:
            state["verify_ms"] = 0.0
            return {"status": "unknown", "reason": "BEFORE_IMAGE_MISSING"}
        started = perf_counter()
        verify_kwargs = {
            "region": expected.get("region"),
            "tolerance": expected.get("tolerance", self.tolerance),
            "min_similarity": expected.get("min_similarity", self.min_similarity),
            "critical_region": expected.get("critical_region"),
            "critical_tolerance": expected.get("critical_tolerance", 0),
            "max_critical_changed": expected.get("max_critical_changed", 0.0),
        }
        for name in ("template_region", "after_region", "template_critical_region",
                     "after_critical_region"):
            if expected.get(name) is not None:
                verify_kwargs[name] = expected[name]
        before = self.verifier(template, before_path, **verify_kwargs)
        if isinstance(before, dict) and before.get("status") == "passed":
            state["verify_ms"] = round((perf_counter() - started) * 1000, 2)
            return {"status": "unknown", "reason": "TARGET_ALREADY_SATISFIED"}
        after = json.loads(Path(after_path).read_text(encoding="utf-8"))
        check = self.verifier(template, after["image"]["path"], **verify_kwargs)
        state["verify_ms"] = round((perf_counter() - started) * 1000, 2)
        if not isinstance(check, dict):
            return {"status": "unknown", "reason": "VERIFIER_PROTOCOL_INVALID"}
        return check

    def run(self) -> dict:
        context = self.desktop.physical_pixels() if hasattr(self.desktop, "physical_pixels") else nullcontext()
        with context:
            for index, step in enumerate(self.program.steps):
                prepared = self._preflight(step, index)
                if prepared["status"] != "ready":
                    return {"status": prepared["status"], "reason": prepared["reason"],
                            "step_id": step.step_id, "window": self.window,
                            "activation": self.activation}
            if self.states:
                first = self.states[self.program.steps[0].step_id]
                last = self.states[self.program.steps[-1].step_id]
                self.window = first["window"]
                self.basis_image = first["basis"]
                self.grant = first["grant"]
                self.region = last["region"]
            result = replay(self.program, observe=self._observe, locate=self._locate,
                            client=self.client, verify=self._verify, root=self.root,
                            require_proof=self.require_proof, allow_draft=self.allow_draft)
        steps = [{"step_id": state["step_id"], "window": state["window"], "grant": state["grant"],
                  "activation": state.get("activation"), "location": state.get("location"),
                  "region": list(state["region"]),
                  "region_space": state.get("region_space"),
                  "clipped_to_current_window": state.get("clipped_to_current_window", False),
                  "scales": state.get("scales"),
                  "basis_image": str(state["basis"]),
                  "window_context": state.get("window_context"),
                  "timings": {**(state.get("observe_timings") or {}),
                              "locate_ms": state.get("locate_ms"),
                              "verify_ms": state.get("verify_ms")}}
                 for state in self.states.values()]
        return {**result, "window": self.window, "activation": self.activation,
                "grant": self.grant, "location": self.location,
                "region": list(self.region) if self.region else None,
                "basis_image": str(self.basis_image) if self.basis_image else None,
                "steps": steps}

    def verify_draft(self) -> dict:
        """Replay a draft on fresh observations and mint a verified proof.

        This is the bridge from an explored draft to a verified PreAct program.
        It does not save the program; inventory.save_program remains a separate
        explicit step. Any failed/unknown/stopped replay returns without proof.
        """
        if (self.program.verification or {}).get("status") != "draft":
            return {"status": "refused", "reason": "DRAFT_REQUIRED"}
        context = self.desktop.physical_pixels() if hasattr(self.desktop, "physical_pixels") else nullcontext()
        with context:
            for index, step in enumerate(self.program.steps):
                prepared = self._preflight(step, index)
                if prepared["status"] != "ready":
                    return {"status": prepared["status"], "reason": prepared["reason"],
                            "step_id": step.step_id, "window": self.window,
                            "activation": self.activation}
            if self.states:
                first = self.states[self.program.steps[0].step_id]
                last = self.states[self.program.steps[-1].step_id]
                self.window = first["window"]
                self.basis_image = first["basis"]
                self.grant = first["grant"]
                self.region = last["region"]
            result = verify_program(
                self.program, observe=self._observe, locate=self._locate,
                client=self.client, verify=self._verify, root=self.root,
            )
        steps = [{"step_id": state["step_id"], "window": state["window"], "grant": state["grant"],
                  "activation": state.get("activation"), "location": state.get("location"),
                  "region": list(state["region"]),
                  "region_space": state.get("region_space"),
                  "clipped_to_current_window": state.get("clipped_to_current_window", False),
                  "scales": state.get("scales"),
                  "basis_image": str(state["basis"]),
                  "window_context": state.get("window_context"),
                  "timings": {**(state.get("observe_timings") or {}),
                              "locate_ms": state.get("locate_ms"),
                              "verify_ms": state.get("verify_ms")}}
                 for state in self.states.values()]
        return {**result, "window": self.window, "activation": self.activation,
                "grant": self.grant, "location": self.location,
                "region": list(self.region) if self.region else None,
                "basis_image": str(self.basis_image) if self.basis_image else None,
                "steps": steps}
