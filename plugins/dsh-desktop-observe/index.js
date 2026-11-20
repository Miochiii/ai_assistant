import { activateWindow, monitors, windows } from './bridge.js';
import { activeGrants, selectGrantForHwnd } from './authorization.js';
import { createObserver, renderObservation } from './image-delivery.js';
import { clickParameters, comboParameters, createChorder, createClicker, createDragger,
  createKeyer, createScroller, createTexter, dragParameters, keyParameters, renderClick,
  renderCombo, renderDrag, renderKey, renderScroll, renderText, scrollParameters,
  textParameters } from './action.js';
import { createRunLedgerClient } from './runs.js';
import { memoryRuntime } from './memory-runtime.js';
import { createReplayTool, renderReplay } from './replay.js';
import { hostCheckCommand } from './host-check.js';
import { sessionTrialCommand, sessionOfflineCommand } from './session-trial.js';

export const name = 'dsh-desktop-observe';
export const inject = ['tools', 'commands'];

// Registry-ready ToolDefinition uses the JSON Schema contract of DSH 0.2.1-rc.2.
// No startup capture, native input library, model client or auto-download.
export function definitions(ctx = {}) {
  return [
    {
      name: 'desktop_monitors',
      description: 'List monitors and physical pixel bounds for the assistant workspace. Does not capture pixels or operate applications.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      execute: monitors,
    },
    {
      name: 'desktop_windows',
      description: 'List visible top-level windows with hwnd, pid, class, title and physical rect. Read-only: no capture, activation or input. Use the hwnd only for desktop_observe with hwnd.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      execute: async (args, exec) => {
        const result = await windows(args, exec);
        const session = String(exec?.agent?.session?.header?.id ?? 'harness-local-session');
        return { ...result, authorization_grants: activeGrants({ session }).map(grant => ({
          grant_id: grant.grant_id, task: grant.task, expires_at: grant.expires_at,
          actions: grant.actions, windows: grant.windows, program_ids: grant.program_ids })) };
      },
    },
    {
      name: 'desktop_activate',
      description: 'Bring one visible window to the foreground without mouse or keyboard input. Checks executor/target integrity, refuses elevated targets, restores minimized windows and verifies the resulting foreground window. Use it before desktop_observe when the target is not foreground; it does not click or type and does not bypass the observation/window checks.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['hwnd'],
        properties: { hwnd: { type: 'integer', description: 'Visible window HWND from desktop_windows.' } },
      },
      execute: async (args, exec) => {
        const session = String(exec?.agent?.session?.header?.id ?? 'harness-local-session');
        selectGrantForHwnd({ hwnd: args.hwnd, action: 'activate', session });
        return activateWindow(args, exec);
      },
    },
    {
      name: 'desktop_observe',
      description: 'Capture one current visible desktop image, optionally a region or an action-ready bound window, only when the user requests screen observation. Without hwnd it is read-only. With hwnd from desktop_windows it also writes a window binding and RGB baseline for exactly one later desktop_click. If the target is not foreground, call desktop_activate first; this capture does not activate or raise windows. include_image=true additionally returns a native Harness image to the current image-capable model, but only when the local image-delivery policy is enabled. No inference, click or typing is performed by this capture. Never infer task success from capture success.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          monitor: { type: 'integer', description: 'One-based monitor index from desktop_monitors; default 1. Cannot be combined with hwnd.' },
          region: { type: 'array', items: { type: 'integer' }, description: 'Optional [LEFT, TOP, WIDTH, HEIGHT], physical desktop pixels. Without hwnd it must fit the chosen monitor; with hwnd it must fit the bound window.' },
          hwnd: { type: 'integer', description: 'Optional visible window HWND from desktop_windows. Creates an action-ready observation for desktop_click; region defaults to the whole client area.' },
          region_space: { type: 'string', enum: ['client', 'window', 'explicit'], description: 'Region space with hwnd. Defaults to client when region is omitted, explicit when region is supplied. client/window capture from the current client/window origin without a fixed margin.' },
          include_image: { type: 'boolean', description: 'Default false. Prepare an image content block for the current model; requires enabled local policy and an image-capable route.' },
        },
      },
      execute: async (args, exec) => {
        if (args?.hwnd !== undefined) {
          const session = String(exec?.agent?.session?.header?.id ?? 'harness-local-session');
          selectGrantForHwnd({ hwnd: args.hwnd, action: 'observe', session });
        }
        return createObserver(ctx)(args, exec);
      },
    },
    {
      name: 'desktop_click',
      description: 'Execute exactly one guarded left click on an action-ready observation from desktop_observe with hwnd. center is in the attached image pixels; the fixed executor verifies observation ID, image hash, size, origin, window/foreground/input state and pixels, maps the point, verifies pointer movement, sends one click, and captures a post-action screenshot. The target window must already be foreground; call desktop_activate first if needed. The executor refuses covered or background targets and never retries. Input delivery is not task success; inspect the returned screenshot or delta before claiming success.',
      parameters: clickParameters,
      execute: createClicker(ctx, { runs: createRunLedgerClient(), memory: memoryRuntime }),
    },
    {
      name: 'desktop_scroll',
      description: 'Execute one guarded, bounded vertical scroll on an action-ready observation from desktop_observe with hwnd. The anchor is in attached image pixels; the fixed executor checks observation/window/foreground/input state, moves to the anchor, sends 1–3 wheel notches (positive up, negative down), and captures a post-action screenshot. Requires an explicit scroll grant. API acceptance is not receiver consumption or task success; observe again and never retry blindly.',
      parameters: scrollParameters,
      execute: createScroller(ctx, { runs: createRunLedgerClient(), memory: memoryRuntime }),
    },
    {
      name: 'desktop_key',
      description: 'Send one short navigation key (Left/Right/Up/Down/Home/End) using host-captured focus evidence and an explicit key grant. No modifiers, Enter, text, repeat or hold are accepted. The fixed executor verifies focus/window/foreground, sends one keydown/keyup, records release evidence and captures a post-action screenshot. API acceptance is not focus verification or task success; observe again.',
      parameters: keyParameters,
      execute: createKeyer(ctx, { runs: createRunLedgerClient(), memory: memoryRuntime }),
    },
    {
      name: 'desktop_text',
      description: 'Insert one short single-line literal text (at most 16 Unicode scalars) into a focus-verified action-ready observation, with an explicit text grant. No CR/LF/Tab/control characters, Enter, clipboard, IME composition or modifiers. The fixed executor sends paired UTF-16 key events in bounded batches and captures a post-action screenshot; it does not store the text body in the receipt. API acceptance is not inserted-text verification or task success; inspect the receiver.',
      parameters: textParameters,
      execute: createTexter(ctx, { runs: createRunLedgerClient(), memory: memoryRuntime }),
    },
    {
      name: 'desktop_combo',
      description: 'Send one fixed Ctrl+Left or Ctrl+Right chord using focus evidence and an explicit chord grant. No arbitrary modifiers, Ctrl+A/C/V/X, Alt/Win, Enter, clipboard or repeat are accepted. The fixed executor sends one complete ctrl-down/key-down/key-up/ctrl-up batch and captures a post-action screenshot. API acceptance is not focus verification or task success; observe again.',
      parameters: comboParameters,
      execute: createChorder(ctx, { runs: createRunLedgerClient(), memory: memoryRuntime }),
    },
    {
      name: 'desktop_drag',
      description: 'Send one bounded left-button drag from start to end inside a single authorized window, using an explicit drag grant. Both points must come from the same action-ready observation; the fixed executor preflights every interpolated point, sends a left-button down/move/up sequence and bounded release cleanup. No cross-window, file-drop, modifier, repeat or retry semantics are accepted. API acceptance is not receiver verification or task success; inspect the post-action screenshot.',
      parameters: dragParameters,
      execute: createDragger(ctx, { runs: createRunLedgerClient(), memory: memoryRuntime }),
    },
    {
      name: 'desktop_replay',
      description: 'Run one proof-bound verified program as a single host call. The host performs each program step internally with fresh observation, local relocation, the fixed executor, bounded verification and the desktop input lease; failed/unknown steps stop without retry. Only program_id and version are accepted; no arbitrary coordinates, code or action arrays. Up to 8 verified steps are accepted; no rollback is performed for earlier steps. This result covers only the program\'s declared postcondition, not general task success.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['program_id'],
        properties: {
          program_id: { type: 'string', description: 'Verified program identifier, for example notepad-open-file-menu.' },
          version: { type: 'integer', description: 'Verified program version, default 2.' },
        },
      },
      execute: createReplayTool({ memory: memoryRuntime, runs: createRunLedgerClient() }),
    },
  ].map(tool => ({
    ...tool, timeoutMs: tool.name === 'desktop_click' || tool.name === 'desktop_scroll'
      || tool.name === 'desktop_key' || tool.name === 'desktop_text'
      || tool.name === 'desktop_combo' || tool.name === 'desktop_drag' ? 60000
      : tool.name === 'desktop_replay' ? 120000 : 25000,
    output: { schema: { type: 'object', additionalProperties: true },
      render: tool.name === 'desktop_observe' ? renderObservation
        : tool.name === 'desktop_click' ? renderClick
          : tool.name === 'desktop_scroll' ? renderScroll
            : tool.name === 'desktop_key' ? renderKey
              : tool.name === 'desktop_text' ? renderText
                : tool.name === 'desktop_combo' ? renderCombo
                  : tool.name === 'desktop_drag' ? renderDrag
                    : tool.name === 'desktop_replay' ? renderReplay
                      : (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => false,
    presentCall: args => ({ card: 'generic', title: tool.name,
      kind: ['desktop_click', 'desktop_scroll', 'desktop_key', 'desktop_text', 'desktop_combo', 'desktop_drag', 'desktop_activate', 'desktop_replay'].includes(tool.name) ? 'action' : 'read',
      rawInput: tool.name === 'desktop_text'
        ? { ...args, text: `[redacted: ${typeof args?.text === 'string' ? [...args.text].length : 0} scalars]` }
        : args }),
  }));
}

export function apply(ctx) {
  const disposers = [];
  try {
    for (const tool of definitions(ctx)) disposers.push(ctx.tools.register(tool));
    disposers.push(ctx.commands.register(hostCheckCommand(ctx)));
    disposers.push(ctx.commands.register(sessionTrialCommand(ctx)));
    disposers.push(ctx.commands.register(sessionOfflineCommand(ctx)));
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    throw error;
  }
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
