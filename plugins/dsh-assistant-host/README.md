# dsh-assistant-host (RH01-RH04 offline/mss slice)

Resident assistant Host protocol, message channel, compact display shell and
observation service. The capture path is one-shot mss; ffmpeg/See Now is not
started.

Current scope:

- versioned user event / UI state contracts
- file-based inbox, acks, outbox and state
- single instance lock, event ID dedupe, atomic writes
- one active task, task A → chat → task B
- pause/close and late-result rejection
- `/assistant-check` offline slash command
- RH03 compact display shell:
  - `tools/coach_overlay/resident_compact.py`
  - `tools/coach_overlay/resident_panel.py`
  - `tools/coach_overlay/resident_channel.py`
  - `plugins/dsh-assistant-host/ui-process.js`
  - `scripts/run_resident_ui_demo.mjs`
- RH04 observation:
  - `observation-service.js`: scope/geometry, freshness, pause/resume, bounded
    cache and summaries; synthetic frames are tested
  - `mss-adapter.js` + `tools/coach_overlay/capture_once.py`: one-shot real
    desktop capture without ffmpeg, used only when explicitly inserted into Host
  - `mss-observation-runner.js`: explicit low-rate (default 2s) capture loop,
    one capture at a time; pause/stop clears the timer
  - `frame-analysis.js`: local change bbox and 320×180 thumbnail
  - `scene-wake.js`: See Now-style ticker; one wake per new accepted frame,
    8s autonomous gap, 3s user-interjection cooldown, retry and idle stop
  - `wake-model-adapter.js`: wake → model port; publishes suggestions, returns
    any `action_request` without executing it. `OfflineWakeModel` is a
    deterministic local placeholder; the DSH session adapter replaces it later.
  - `preact-gate.js`: action_request → explicit grant → one injected replay
    attempt → completed/failed/replan/unknown. No retry, no coordinate fallback,
    no input driver.
  - `action-request-bridge.js`: model action_request → permission request,
    separate authorize, single execute and status publication.
  - `exploration-flow.js`: no existing PreAct program → exploration grant →
    low-risk steps continuous; risky steps need a separate risk grant; only
    verified steps are appended; whole sequence can be recorded.
  - `program-draft.js`: converts a verified exploration sequence into a
    PreAct-shaped **draft** ProgramRecord (visual basis/preconditions/action
    intent/expected, no coordinates in action), and writes drafts under
    `runtime/program-drafts/`. It does not claim verified/proof or call
    inventory.save_program.
  - `dsh-session-model.js` / `dsh-model-bridge.js`: current DSH session model
    port using sessionController, attachments and session/event; wakes the
    current session with text + frame image and collects the assistant reply.
  - `speech-bus.js`: See Now-style speech event bus and SpeechPort. Core only
    emits `due`; a future TTS adapter subscribes, plays, and emits `spoken`.
    No TTS engine is bundled.
  - `model-check.js` + `/assistant-model-check`: submit one frame through
    `companion-stream.js` to the configured LLM service with an independent
    request ID and no tools. `/assistant-model-status` reads its local result.
    No automatic capture, input or action.
  - `model-watch.js` + `/assistant-model-watch`: explicit mss observation +
    SceneWake pacing + async model wake; `/assistant-model-stop` stops it.
    It still never executes desktop input.
  - `candidate-gate.js`: local pre-model gate (change score/ratio/region),
    configurable cooldown, exponential silent backoff (does not automatically
    stop the resident loop), strong-scene reset. Low-change frames never reach
    the model.
  - `panel-session.js` + `/assistant-open` / `/assistant-close`: explicitly
    launches/stops the compact panel with a local Host/channel. WDA capture
    exclusion is off by default because it made the panel invisible on this
    host; see the WDA note below. No automatic launch.
  - `panel-model.js`: panel chats retain up to four exchanges (8 KiB) and the
    latest published observation. Closing the panel clears this model context.
    `记住，内容` and `查记忆：关键词` use the workspace memory service locally.
    For teaching style, `指导时使用：一次只说一步` or `指导时使用：先给概览`
    opts in for this workspace. Inspect with `查看指导偏好`, disable with
    `停用指导偏好`. Start a guidance turn with `教我…` or `指导：…`.
    `交给主会话：任务` queues only the specified task in the launching session.
  - `highlight-controller.js` + `highlight_locator.py` +
    `/assistant-highlight <target>`: display-only OCR-located Coach overlay.
    Guidance replies may append `[[HIGHLIGHT:visible short text]]`; the Host
    resolves it locally and draws one click-through box. No input or action.
    `/assistant-highlight-clear` hides it; task end/pause/close also clear it.
    Explicit user sentences such as `教我点击“新会话”` also provide a local
    target hint, so the model does not ask for a screen location it cannot see.
  - `scripts/preact_draft_verify.py`: loads a draft, runs the existing
    ProgramReplayAdapter on fresh observations (activate/observe/re-localize/
    fixed executor/B03), and calls inventory.verify_program to mint a proof.
    It still does not save to the inventory. Must run under the Medium base
    Python; draft `expected` must contain template metadata for proof.
  - `scripts/prepare_draft_from_program.py`: safely copy an existing verified
    program into a draft under runtime/program-drafts for a controlled live
    draft-replay test. It removes verification runs/proof and never executes.
  - `vendor/see-now/`: small Apache-2.0 modules vendored from dsh-see-now 0.0.7
    for HSV 64×36 scoring, cover scaling and pure-JS PNG encoding (NOTICE and
    LICENSE included); no ffmpeg or See Now runtime
  - `see-now-adapter.js`: explicit refusal when ffmpeg is unavailable

The Host can be constructed with `observationService`, `captureAdapter` and
`defaultObservationScope`; `resume_observation` starts observation and captures
one frame, `pause_observation` clears evidence, and close/end-task stops it.
The explicit watch command starts background observation until stopped.

`stepVerifier` enables the guidance loop: `check_step` requires a fresh frame,
runs one verifier call, advances only on `passed`, and keeps the current step on
`failed`/`unknown` without auto retry. Without a verifier, the legacy `checking`
state is preserved.

`sceneWakeScheduler` is started on resume and stopped on pause/end/close; chat
submissions are forwarded to `noteUser` so user interjections take priority.

For `kind: "window"` scopes with `bounds`, mss checks the live window rectangle
against those physical, DPI-aware bounds (tolerance 2px) and fails with
`geometry_changed` instead of silently capturing a moved window. A non-DPI-aware
rect is not valid input scope.

The compact panel and feed can use `WDA_EXCLUDEFROMCAPTURE`; with
`--exclude-capture`, mss captures no assistant UI. **On the current Windows/NVIDIA
host this also made the manual panel invisible to the user,** so
`/assistant-open` starts it without WDA exclusion by default. Run the local demo
with `--exclude-capture` only for capture-frame tests.

Run the local UI demo from the repository root:

```powershell
node scripts/run_resident_ui_demo.mjs
```

Not implemented in this phase:

- no real model/API calls
- no ffmpeg/See Now capture loop; mss is one-shot/runner only
- no desktop input or action authorization
- no plugin installation in this change

Run tests from the repository root:

```powershell
node --test tests/test_assistant_protocol.mjs tests/test_assistant_channel.mjs \
  tests/test_assistant_lifecycle.mjs tests/test_assistant_plugin.mjs \
  tests/test_assistant_ui_process.mjs tests/test_assistant_observation.mjs \
  tests/test_assistant_observation_host.mjs tests/test_assistant_observation_runner.mjs \
  tests/test_assistant_frame_analysis.mjs tests/test_assistant_scene_wake.mjs \
  tests/test_assistant_step_loop.mjs tests/test_assistant_wake_model.mjs \
  tests/test_assistant_preact_gate.mjs tests/test_assistant_action_bridge.mjs \
  tests/test_assistant_exploration_flow.mjs tests/test_assistant_program_draft.mjs \
  tests/test_assistant_speech.mjs tests/test_assistant_dsh_session_model.mjs \
  tests/test_assistant_dsh_bridge.mjs tests/test_assistant_model_check.mjs \
  tests/test_assistant_model_watch.mjs tests/test_assistant_candidate_gate.mjs \
  tests/test_assistant_panel_model.mjs tests/test_assistant_highlight.mjs
```

The plugin registers only explicit human commands. It does not auto-start a
resident loop, capture frames, or execute desktop input at load time.
# Current integration: Orb floating assistant (2026-11-07)

`/assistant-open` now opens the reused Orb Electron shell. Hover expands it;
clicking pins it; dragging moves/docks it. Enter sends, Shift+Enter inserts a
newline. Right-click opens the project menu. `/assistant-close` closes it.
The original Tk panel remains available to legacy fixtures, not as the default.

The helper runtime is Electron 44.0.0 at
`%LOCALAPPDATA%/DesktopAssistant/runtimes/electron-44.0.0/electron.exe`.
It has an independent per-instance userData directory and does not use Harness's
web authentication or cookie store. `PanelSession.executablePath` can override
the runtime path. Do not use the packaged Harness executable as a generic helper.

Plain panel chat keeps the existing bounded independent context and explicit
memory commands. Guidance starting with “教我…” attaches a fresh monitor-1 image
to the same model request and accepts normalized Orb 0–1000 coordinates for a
display-only highlight. Ambiguous/absent targets return null. Images are not kept
in panel conversation history. Local capture scratch files are released after
attachment creation; the Harness attachment store has its own retention policy.
The helper is temporarily hidden for guidance captures; existing background watch
capture still uses its own adapter and does not yet share this hide handshake.

Offline checks (no model API calls):

```powershell
node scripts/preview_orb.mjs --smoke
node --test --test-isolation=none tests/test_orb_visual_target.mjs tests/test_assistant_panel_model.mjs tests/test_assistant_highlight.mjs
```

See `vendor/orb/NOTICE.md` for provenance and the technical handoff in
`log/2026-11-07-Orb悬浮球与视觉高亮接入.md` for limitations and acceptance steps.
The sections below describe earlier milestones and their historical boundaries.

