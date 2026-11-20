# Coach Overlay PoC

2026-11-03：常驻 `resident_panel.py` 已改为透明窗口内的双消息气泡＋蓝粉渐变圆角输入条，
指导控件合并显示，空闲自动收起；独立 Coach/鲸鱼预览入口保持原样。
行为见 [紧凑界面记录](../../log/2026-11-03-resident-compact-ui-update.md)，最新外观与验收见 [蓝粉气泡记录](../../log/2026-11-03-resident-blue-pink-glass.md)。

Display-only transparent overlay for Coach mode.

It draws:

- a highlighted rectangle around a target,
- a callout with an arrow,
- one short Chinese step,
- a small "preview only" caption.

It never sends mouse/keyboard input, never reads application content, and never
calls the executor.

## Status

Prototype. This is not integrated into the Harness tool surface and is not a
verified production component.

### Visual update — 2026-11-02

- Whale mode shows `STEP n / total`, centered body text (at most two measured
  lines), and a separate opaque 144×40 rounded Next window. Physical font
  sizes: body 24→20px, progress 16px, button 18px. Excess text is explicitly
  ellipsized; the source state is unchanged.
- Next has hover/pressed feedback. Close is a separate 32×32 window outside
  the bubble. Both retain `WS_EX_NOACTIVATE`; whale artwork is click-through.
- Placement tries bottom-right, bottom-left, top-right, top-left, avoiding
  target and short-arrow bounds. A 26px margin preserves at least 20px during
  the entrance rise. If no corner fits, the whale hides and the original
  callout is used. Whale mode hides the duplicate full-text callout.
- Entrance lasts about 168ms. Step transitions animate only text, keeping the
  image and button stationary. Unchanged canvas content is reused; Next no
  longer starts additional polling loops.
- The bundled chroma image's near-black matte is normalized to the exact
  Win32 color key once in memory. Asset files are unchanged; no dependency
  was added. The user confirmed that the black fragments disappeared.
- Capture exclusion is also requested for whale, Next, Close and panel
  windows. Failure is reported. **This expanded exclusion behavior has not
  been reverified end-to-end.** Earlier mss results below describe the prior
  implementation.

Four local geometry/font/native-style tests passed. An actual Next click
advanced step 1→2 and retained the mock target as foreground. The user also
confirmed manual advancement and Close; the preview process exited. No target
application received input, no action grants were created, and no API was called.

Actual 2560×1440 captures of a local mock page:

- [Step 1](../../results/coach-visual-20261102/step-1.png)
- [Step 2 after Next](../../results/coach-visual-20261102/step-2.png)

Reusable checks (Python 3.12, no added dependency):

```powershell
E:\python\python.exe -B tools\coach_overlay\test_layout.py
E:\python\python.exe -B tools\coach_overlay\preview.py
```

The mock preview closes after five minutes. `preview.py --exclude-capture`
supports a later capture-backend check. QA screenshots were saved with the
project's existing mss because the desktop tool's window-capture backend timed
out. Sound playback, mixed DPI, arbitrary replacement artwork and the expanded
capture exclusion remain unverified. Temporary debug logs were removed.

### Earlier PoC checks

Tested locally on Windows 11 with Python 3.12 + tkinter:

- visible rectangle/arrow/Chinese text,
- click-through (`WindowFromPoint` returned the underlying Notepad `Edit`),
- foreground remained Notepad (no focus steal after startup restoration),
- hidden when the target window was no longer foreground,
- shown again when the target returned,
- state-file rectangle/text updates,
- multi-step `steps`/`step_index` rendering,
- control panel: next advanced 2/3 → 3/3; pause hid the overlay and changed to
  “继续”; resume changed back to “暂停”,
- `window_rect` mismatch hides the overlay and restores when correct,
- observation bbox → physical rect conversion with a live action-ready
  observation and bbox [20,20,200,100],
- whale bubble `DSniang02` displayed at bottom-right; `下一步` advanced
  1/3 → 2/3 and the main rectangle/text updated,
- Host OCR loop: target `新会话` → `插件`, fresh capture, OCR text match, state
  generation 2, whale `STEP 2 / 3`; no bbox/reference required,
- Host patch loop: bounded relocation of `新会话` → `插件` using a reference
  screenshot (earlier prototype),
- `--exclude-capture`: overlay window stayed visible and click-through, but
  mss screenshots omitted the rectangle/arrow,
- `WDA_EXCLUDEFROMCAPTURE` was verified with mss on this machine; other capture
  backends (OBS, DWM thumbnails, some remote tools) still need separate checks.

Not yet tested:

- mixed-DPI multi-monitor placement,
- exclusive fullscreen games,
- RDP,
- long multi-step sessions,
- whale bubble close button and audible sound on every run.

## Requirement

Use a Python that has tkinter:

```powershell
E:\python\python.exe --version
E:\python\python.exe -c "import tkinter; print(tkinter.TkVersion)"
```

The project `.venv` does not currently have tkinter, so the PoC uses
`E:\python\python.exe`. It has no third-party dependency.

## Usage

Static one-step overlay:

```powershell
E:\python\python.exe tools\coach_overlay\coach_overlay.py `
  --rect 850 150 300 180 `
  --text "点击这里：开始新任务" `
  --target-hwnd 1247658 `
  --seconds 20
```

Coordinates are physical desktop pixels.

Observation-driven overlay:

```powershell
E:\python\python.exe tools\coach_overlay\coach_overlay.py `
  --observation results\vision\<id>\observation.json `
  --bbox 20 20 200 100 `
  --text "从观察框生成提示" `
  --seconds 20
```

`--bbox` is in observation image pixels. The bridge:

- checks the manifest's `capture_bounds`, image size and `window.hwnd`,
- converts bbox to physical desktop pixels,
- uses the observation's `observed_at` and defaults to a 30-second
  `--max-age`,
- refuses a stale or malformed observation before showing anything.

State-file mode for a host/assistant to update the overlay:

```powershell
E:\python\python.exe tools\coach_overlay\coach_overlay.py `
  --state-file runtime\tmp\coach-state.json `
  --seconds 60
```

State JSON for multiple steps:

```json
{
  "visible": true,
  "target_hwnd": 1247658,
  "window_rect": [1218, 86, 2058, 715],
  "generation": 3,
  "observed_at": "2026-11-02T14:25:35+00:00",
  "step_index": 0,
  "steps": [
    {"rect": [1250, 190, 300, 120], "text": "第 1 步：点击文件菜单"},
    {"rect": [1250, 340, 300, 120], "text": "第 2 步：选择保存"},
    {"rect": [1250, 490, 300, 120], "text": "第 3 步：确认导出"}
  ]
}
```

`window_rect` pins the observed target window geometry. If the window moves or
resizes, the overlay hides instead of drawing a stale rectangle.

The control panel is shown by default:

- `◀` / `▶`: previous/next step (when `steps` has more than one item)
- `暂停` / `继续`: hide/restore the overlay without exiting
- `关闭`: exit

Use `--no-panel` for headless/static captures.

State JSON:

```json
{
  "visible": true,
  "rect": [850, 150, 300, 180],
  "text": "第一步：点击这里",
  "target_hwnd": 1247658,
  "generation": 3,
  "observed_at": "2026-11-02T14:25:35+00:00"
}
```

The file is polled about every 150 ms. UTF-8 with or without BOM is accepted.
`visible:false`, missing/invalid state, `observed_at` older than `--max-age`, a
lower `generation` than the last shown state, or a non-foreground target hides
the overlay. Switching back to the target restores it.

Optional:

```text
--exclude-capture   try SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)
--event-file PATH   write next/finish/closed events for a host
--host-paced        emit next events, wait for host state updates
--no-panel          hide the pause/prev/next/close control panel
--debug             print state/geometry decisions to stderr
--color #00E5FF     highlight color
```

## Host closed-loop prototype

`coach_host.py` is the first host-side loop. It is still display-only: it never
clicks the target and never calls the executor.

```text
whale Next
  -> overlay writes event.json
  -> host captures a fresh screen
  -> OCR (default) or bounded patch locator finds the next target
  -> host writes state.json
  -> overlay redraws the rectangle / whale bubble
```

Run it with the project `.venv` (mss/numpy) and let it launch the overlay with
the tkinter Python:

```powershell
.\.venv\Scripts\python.exe -B tools\coach_overlay\coach_host.py `
  --plan runtime\coach_demo\plan-ocr.json `
  --state-file runtime\coach_demo\state-ocr.json `
  --event-file runtime\coach_demo\event-ocr.json `
  --run-dir runtime\coach_demo\run-ocr `
  --locator ocr `
  --seconds 120
```

Plan schema for OCR-only steps:

```json
{
  "target_hwnd": 984926,
  "steps": [
    {
      "id": "new-session",
      "text": "点击“新会话”",
      "target": "新会话"
    },
    {
      "id": "plugins",
      "text": "点击“插件”",
      "target": "插件"
    }
  ]
}
```

`target` is the visible text to find. No bbox/reference is required for OCR.
For patch fallback, use this older shape:

```json
{
  "target": "插件",
  "reference": "runtime/coach_demo/reference.png",
  "bbox": [380, 360, 180, 45],
  "search_radius": 64
}
```

`--locator`:

- `ocr`: Windows OCR only; fail if the text is not found.
- `patch`: bounded patch search only; requires `reference` + `bbox`.
- `auto` (default): try OCR for steps with `target`, then patch if available.

Each Next event triggers a **fresh full-screen capture**. The locator is
content/semantic rather than a fixed UI coordinate:

- OCR matches a visible text line and returns its bounding box.
- It prefers the shortest containing line to avoid matching a long transcript
  paragraph that happens to contain the same words.
- Patch search handles movement/scroll near a known reference.
- A missing/ambiguous target hides the overlay instead of showing a stale box.

### Windows OCR details

- Engine: built-in `Windows.Media.Ocr`, language `zh-Hans-CN`.
- Helper: `ocr_windows.ps1`.
- The Host runs at **low integrity**, so the helper reads the PNG bytes and
  decodes them through an in-memory WinRT stream; it does not use
  `StorageFile`/file broker APIs that fail at low integrity.
- Installed OCR languages here: `en-US`, `ja`, `zh-Hans-CN`.
- If OCR is unavailable, use `--locator patch` with reference/bbox.

## Whale bubble prompt

`--whale` adds the reused `DSniang02.png` whale-girl thought bubble at the
bottom-right:

```powershell
E:\python\python.exe tools\coach_overlay\coach_overlay.py `
  --state-file runtime\tmp\coach-whale.json `
  --whale --no-panel `
  --max-age 0 --seconds 60
```

- the current step text is drawn inside the white thought bubble
- the `下一步` button sits inside the bubble on a small opaque, click-through-
  safe control window
- clicking next advances the local step list, plays `assets/Ya1.mp3`, and runs
  a short text transition
- the `×` button closes the overlay
- `--no-sound` disables the sound; `--whale-image` replaces the PNG

The transparent whale window uses a precomposited chroma-key copy
(`DSniang02-chroma.png`) because Tk renders raw PNG alpha as black. The
original image and sound are from `dsh-whale-widget`; see
`tools/coach_overlay/assets/README.md`.

This is still a **local step list**. Clicking next does not yet perform the
closed-loop “observe after user action, locate next target” flow; that belongs
to the host-side Coach controller.

## Window behavior

The native top-level is marked:

```text
WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW |
WS_EX_NOACTIVATE | WS_EX_TOPMOST
```

- `WS_EX_TRANSPARENT` makes the canvas click-through.
- `WS_EX_NOACTIVATE` keeps it out of the foreground.
- `WS_EX_TOOLWINDOW` keeps it out of Alt+Tab/taskbar.
- Tk briefly maps the window during startup; the PoC restores the previous
  foreground immediately. This startup traversal is a known Tk limitation.
- Target changes hide the overlay; no old rectangle is reused.

## Safety

- Display-only; there is no call into `desktop_adapter`, no SendInput, no
  clipboard, no key hook.
- It does not prove the target is correct. The host must supply a fresh
  observation/bbox and a target HWND.
- The caption is intentional: this is a preview, not verified execution.
- For screenshot/OCR pipelines, `--exclude-capture` is best-effort
  `SetWindowDisplayAffinity`; mss was verified here, other capture backends must
  be checked separately.

## Known limitations

- Full virtual-desktop sizing relies on Tk/Win32 DPI interaction; verify on
  mixed-DPI multi-monitor setups before using in production.
- The overlay is one window, one rectangle, one step. Multi-step sequencing is
  local to the panel; the host owns the authoritative step list.
- The control panel is fixed at the upper-left and is not draggable yet.
- No automatic re-anchoring after layout/scroll changes; host must send new
  state. A pinned `window_rect` only hides when the outer window geometry moves.
- The PoC uses a color-key transparent window, not per-pixel alpha; font
  antialiasing may show minor color fringes.
