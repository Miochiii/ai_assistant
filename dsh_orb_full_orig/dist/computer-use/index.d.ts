import { _ as ScrollInput, a as DesktopBackend, b as createPlatformBackend, c as FOCUS_FALLBACK_FOREGROUND, d as LongPressInput, f as OpenAppInput, g as ScreenInfo, h as OpenInFinderInput, i as CopyImageToClipboardInput, l as FOCUS_NOTE, m as OpenInBrowserInput, n as ClickButton, o as DesktopForeground, p as OpenAppResult, r as ClickInput, s as DragInput, t as CapturedScreen, u as HotkeyInput, v as TypeInput, y as UNFOCUSED_WINDOW_NOTE } from "./backend-BPKFhD__.js";
import z from "@deepseek-ai/schemastery";
import { ContextFormed } from "@deepseek-ai/dsh-llm";
import { Session } from "@deepseek-ai/dsh-session";
import { z as z$1 } from "zod";
import { Context } from "@deepseek-ai/cordis";
//#region src/config.d.ts
/** Loader-accepted Computer Use configuration. */
interface Config {
  /**
   * Milliseconds to wait after a GUI action before inspect and pixel capture, so open menus are listed.
   * Default: 600.
   */
  readonly postActionWaitMs?: number;
}
/** Config after defaults and load-time validation. */
interface ResolvedComputerUseConfig {
  readonly postActionWaitMs: number;
}
/** Loader schema for the Computer Use plugin. */
declare const Config: z<Config>;
/**
 * Apply defaults and reject invalid tunables at load.
 * @param config - plugin config, possibly partial.
 * @returns resolved tunables.
 */
declare function resolveComputerUseConfig(config?: Config): ResolvedComputerUseConfig;
//#endregion
//#region src/fake.d.ts
/** 1×1 red PNG used as the fixture desktop image. */
declare const FAKE_DESKTOP_PNG: Buffer<ArrayBuffer>;
/** Recorded fake-desktop action for assertions. */
type FakeDesktopAction = {
  readonly type: 'click';
  readonly input: ClickInput;
} | {
  readonly type: 'typeText';
  readonly input: TypeInput;
} | {
  readonly type: 'scroll';
  readonly input: ScrollInput;
} | {
  readonly type: 'hotkey';
  readonly input: HotkeyInput;
} | {
  readonly type: 'longPress';
  readonly input: LongPressInput;
} | {
  readonly type: 'drag';
  readonly input: DragInput;
} | {
  readonly type: 'openApp';
  readonly input: OpenAppInput;
} | {
  readonly type: 'openInBrowser';
  readonly input: OpenInBrowserInput;
} | {
  readonly type: 'openInFinder';
  readonly input: OpenInFinderInput;
} | {
  readonly type: 'copyImageToClipboard';
  readonly input: CopyImageToClipboardInput;
};
/** Fake backend that records HID calls and returns a fixture PNG. */
interface FakeDesktopBackend extends DesktopBackend {
  /** Actions in call order. */
  readonly actions: readonly FakeDesktopAction[];
}
/** Options for {@link createFakeDesktopBackend}. */
interface FakeDesktopOptions {
  /** Encoded PNG returned by every capture. Default: {@link FAKE_DESKTOP_PNG}. */
  readonly png?: Uint8Array;
  /** Observation surface list. Default: one 1000×800 logical window. */
  readonly screens?: readonly ScreenInfo[];
  /** Foreground metadata. Default: Pages with no Finder folder. */
  readonly foreground?: DesktopForeground;
  /** Running regular app names. Default: Pages and Safari. */
  readonly apps?: readonly string[];
  /** Thrown from {@link DesktopBackend.openApp} when set. */
  readonly openAppError?: Error;
  /** Result of a successful {@link DesktopBackend.openApp}. Default: activated as the requested name. */
  readonly openAppResult?: OpenAppResult;
}
/**
 * Construct a fake desktop that records actions and returns a fixture PNG.
 * @param options - optional screens, PNG bytes, and foreground metadata.
 * @returns a test/snapshot backend.
 */
declare function createFakeDesktopBackend(options?: FakeDesktopOptions): FakeDesktopBackend;
//#endregion
//#region src/plugin.d.ts
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'computer-use': {
      kind: 'computer-use';
    } & ContextFormed;
  }
}
/** Cordis plugin name used as the first-frame notice producer id. */
declare const PLUGIN_NAME = "tool-computer-use";
/** Prompt section sort order: after PTY guidance, before web search. */
declare const POLICY_SECTION_ORDER = 1750;
/**
 * Register the exclusive GUI tools, the policy section, and first-frame screenshot attachment.
 * @param ctx - registration scope; requires `tools`, `systemPrompt`, and `attachments`.
 * @param backend - desktop capture and input.
 * @param config - resolved tunables.
 */
declare function applyComputerUse(ctx: Context, backend: DesktopBackend, config: ResolvedComputerUseConfig): void;
//#endregion
//#region src/coordinate-mode.d.ts
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'computer-use': {
      kind: 'computer-use';
    } & ContextFormed;
  }
}
/** Click encoding recorded on a Computer Use session. */
type CoordinateMode = 'millifraction' | 'pixel';
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Click encoding for this Computer Use session: millifraction 0–1000 or
     * attached-raster pixels. Whole-value replace; the last event wins. A log
     * with none folds to millifraction. Written `ignorable: true` whenever the
     * host catalog does not know the type (official harnesses refuse a log
     * carrying an unknown required event outright); the coordinate contract is
     * also echoed in every GUI tool result's text, so a reader that skips this
     * event can still recover the space from the log.
     */
    'computer-use/coordinate-mode': {
      mode: CoordinateMode;
    };
    /** V3→V4 migration alias of the same record (unknown ignorable events are namespaced `plugin:`). */
    'plugin:computer-use/coordinate-mode': {
      mode: CoordinateMode;
    };
  }
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Folded Computer Use click encoding. */
    computerUseCoordinateMode: {
      mode: CoordinateMode;
    };
  }
}
//#endregion
//#region src/policy.d.ts
/**
 * Computer Use policy for one session encoding.
 * @param mode - millifraction 0–1000 or attached-raster pixels.
 * @returns the assembled policy section text.
 */
declare function policyFor(mode: CoordinateMode): string;
/**
 * Policy section text for a ball conversation the panel does not currently show.
 *
 * The desktop belongs to the conversation the user is looking at: a completion notice may wake any
 * conversation, and only that one may move the mouse. The model still gets the full delegation and
 * coordination rules — it can answer, search, ask, and hand work to a background Code session — so
 * this replaces the capability sentences instead of dropping the policy. See `screen-owner.ts` for
 * the matching execution-time guard.
 * @returns the assembled background policy section text.
 */
declare function backgroundPolicyFor(): string;
/**
 * Stable millifraction Computer Use policy text. Assemblies without an agent
 * and Headless/Web sessions without a coordinate-mode event use this text.
 */
declare const POLICY: string;
//#endregion
//#region src/screen-owner.d.ts
/**
 * Which Computer Use session currently owns the desktop.
 *
 * The ball panel shows exactly one conversation at a time, but every ball conversation stays a live
 * agent: a `code_agent` completion notice wakes its caller even while the user watches another chat.
 * Only the conversation the panel currently shows may touch the screen — the rest stay on the
 * non-GUI tools (search, questions, further background work) so a session nobody is looking at can
 * never move the mouse.
 *
 * The owner is published by the orb host, which is the only component that knows which session the
 * panel displays. State lives on `globalThis` under a `Symbol.for` key, so the host plugin and the
 * preset's tool layer — separate packages composed into one process — share one record, mirroring
 * the process-global screen mutex in `gui-lock.ts`.
 *
 * An absent owner means unrestricted: `dsh web`, the CLI, and a ball that is switched off keep the
 * full tool surface.
 * @module @dsh-orb/computer-use/src/screen-owner
 */
/**
 * Agent preset of a floating ball conversation. The overlay in `cordis.patch.yml` registers it and
 * the orb host creates every ball session with it, so it is what separates a ball conversation from
 * the main window's chats and from the standard-preset Code sessions the ball delegates to.
 */
declare const BALL_PRESET = "computer-use";
interface ScreenOwnerState {
  /** Session id of the conversation the ball currently shows, or empty when unrestricted. */
  ownerId: string;
}
/**
 * Tool-visible failure text. The model reads this as an isError result, so it carries the rule and
 * the way out instead of a bare denial.
 */
declare const NOT_SCREEN_OWNER_MESSAGE: string;
/** The shared record; exported so tests can observe and reset it. */
declare function screenOwnerState(): ScreenOwnerState;
/** Publish the session the ball panel shows; an empty string leaves every session unrestricted. */
declare function setScreenOwner(sessionId: string | undefined): void;
/** The session that currently owns the desktop, or `undefined` when nothing is restricted. */
declare function screenOwnerId(): string | undefined;
/** Whether this tool name reaches the shared desktop or the shell. */
declare function isDesktopTool(name: string): boolean;
/**
 * Denial reason for one pending call, or `undefined` when it may run.
 *
 * The rule is narrow on purpose: **only the floating ball's own conversations are gated, and only
 * the background ones.** A ball conversation the panel currently shows owns the desktop; every other
 * ball conversation may only talk. Nothing else in the process is affected — the main window's own
 * chats keep their tools, and so do the standard-preset Code sessions a ball conversation delegates
 * to, which need the shell to do the work they were handed.
 *
 * Four states are deliberately permissive, and each one is a door that must not lock:
 * - no owner at all (a host without a ball),
 * - a call with no agent (internal dispatch),
 * - a session that is not a ball conversation (the main window, a delegated Code session),
 * - the owner's own calls.
 * @param agentId - calling agent id, or undefined when the call carries no agent.
 * @param toolName - tool name as registered.
 * @param preset - the calling session's agent preset, or undefined when it cannot be read.
 * @returns the model-facing denial, or undefined to leave the call allowed.
 */
declare function desktopToolDenial(agentId: string | undefined, toolName: string, preset: string | undefined): string | undefined;
/**
 * Agent preset of a live agent, or undefined when it cannot be read.
 *
 * Undefined reads as "not a ball conversation" everywhere it is consumed, so an unreadable header
 * widens access instead of closing it. Locking the wrong session out of the shell is far worse than
 * leaving one ball conversation ungated.
 * @param agent - calling agent from the execution, if the call carried one.
 * @returns the preset name, or undefined.
 */
declare function presetOf(agent: unknown): string | undefined;
//#endregion
//#region src/overlay-guard.d.ts
/**
 * Overlay window ids to omit from one capture.
 * macOS values are CGWindowIDs. Windows values are HWNDs. Desktop Host fills this from Electron's overlay-guard ack; CLI leaves it empty.
 */
interface OverlayCaptureSession {
  readonly excludeWindowIds: readonly number[];
}
/** Logical global rectangle for the Computer Use observation-frame overlay. */
interface ObservationFrameBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
/** Overlay-exclude ScreenCaptureKit JPEG request. Desktop Host fills this over IPC. */
interface OverlayExcludedRegionCaptureInput {
  readonly region: string;
  readonly excludeWindowIds: readonly number[];
  readonly output: string;
}
/**
 * Cloak host chrome for the duration of one capture or HID call.
 * Desktop Host provides this; Web and CLI compositions omit it.
 */
interface ComputerUseOverlayGuard {
  /**
   * Exclude host overlay chrome from screen capture while `run` executes, then restore it.
   * A nested `withCapture` inside `withInput` sends no capture IPC — the enclosing input
   * interval already cloaks every chrome window — but `run` still receives the exclude ids.
   * @param run - capture implementation; receives overlay window ids from the begin ack.
   * @param signal - cooperative cancellation for the cloak handshake.
   * @returns the value `run` resolves to.
   */
  withCapture<T>(run: (session: OverlayCaptureSession) => Promise<T>, signal?: AbortSignal): Promise<T>;
  /**
   * Make host overlay chrome click-through while `run` executes, wait for posted HID events to be hit-tested, then restore hit testing.
   * @param run - HID implementation.
   * @param signal - cooperative cancellation for the cloak handshake.
   * @returns the value `run` resolves to.
   */
  withInput<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  /**
   * Show or hide the Desktop observation-frame ribbon around the current capture rectangle.
   * Pass-through hosts resolve immediately. Acks before returning so the next capture omits the frame.
   * Abort of a SHOW hides the ribbon and waits for that hide ack without the aborted signal; abort of a hide rejects the wait.
   * @param bounds - observation union in global logical points, or `null` to hide.
   * @param signal - cooperative cancellation for the SHOW ack wait. Hide acks ignore it.
   */
  setObservationFrame(bounds: ObservationFrameBounds | null, signal?: AbortSignal): Promise<void>;
  /**
   * Capture `input.region` as JPEG at `input.output`, omitting overlay CGWindowIDs in the Electron process.
   * Pass-through hosts omit this method; CLI then spawns `macos-sck-capture`.
   * @param input - region `x,y,w,h`, overlay window ids, and JPEG destination path.
   * @param signal - cooperative cancellation for the ack wait.
   */
  captureExcludedRegion?(input: OverlayExcludedRegionCaptureInput, signal?: AbortSignal): Promise<void>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Overlay cloak; Desktop Host provides it, other compositions leave it undefined. */
    computerUseOverlayGuard?: ComputerUseOverlayGuard;
  }
}
/**
 * Wrap a desktop backend so capture, foreground inspect, listScreens, HID, openApp, and withGuiTurn run inside overlay-guard intervals.
 * After `listScreens`, the wrapper waits for `setObservationFrame` so the next capture exclude list includes the ribbon.
 * When the listing signal is already aborted, the wrapper hides (`null`) without that signal instead of showing bounds.
 * `openApp` and `withGuiTurn` use `withInput` so the overlay yields key status before activate and stays click-through through recapture.
 * Desktop Host refcounts nested cloak calls so one turn sends one input begin/end.
 * `listApps`, `openInBrowser`, `openInFinder`, and `copyImageToClipboard` are unwrapped because
 * they do not capture pixels, inspect windows, post HID, or steal key status.
 * @param inner - platform or fake backend.
 * @param guard - host overlay cloak.
 * @returns a backend that cloaks around capture, inspect, listScreens, HID, openApp, and withGuiTurn.
 */
declare function wrapDesktopBackend(inner: DesktopBackend, guard: ComputerUseOverlayGuard): DesktopBackend;
//#endregion
//#region src/index.d.ts
/** Cordis plugin name. */
declare const name = "tool-computer-use";
/** Services required at apply time. Missing attachments keep the plugin pending. */
declare const inject: string[];
/**
 * Mount Computer Use with the host-platform backend.
 * When Desktop Host provides `computerUseOverlayGuard`, capture, inspect, listScreens, HID, and withGuiTurn run
 * inside overlay-guard intervals, `listScreens` waits for the observation-frame ribbon ack, and overlay-exclude
 * capture runs ScreenCaptureKit in the Electron process.
 * The guard is read on each desktop call, including when Host installs it after this plugin applies.
 * @param ctx - registration scope; `inject` must already be satisfied.
 * @param config - optional tunables; omitted fields use schema defaults.
 */
declare function apply(ctx: Context, config?: Config): void;
//#endregion
export { BALL_PRESET, type CapturedScreen, type ClickButton, type ClickInput, type ComputerUseOverlayGuard, Config, type CopyImageToClipboardInput, type DesktopBackend, type DesktopForeground, type DragInput, FAKE_DESKTOP_PNG, FOCUS_FALLBACK_FOREGROUND, FOCUS_NOTE, type FakeDesktopAction, type FakeDesktopBackend, type FakeDesktopOptions, type HotkeyInput, type LongPressInput, NOT_SCREEN_OWNER_MESSAGE, type OpenAppInput, type OpenAppResult, type OpenInBrowserInput, type OpenInFinderInput, PLUGIN_NAME, POLICY, POLICY_SECTION_ORDER, type ResolvedComputerUseConfig, type ScreenInfo, type ScrollInput, type TypeInput, UNFOCUSED_WINDOW_NOTE, apply, applyComputerUse, backgroundPolicyFor, createFakeDesktopBackend, createPlatformBackend, desktopToolDenial, inject, isDesktopTool, name, policyFor, presetOf, resolveComputerUseConfig, screenOwnerId, screenOwnerState, setScreenOwner, wrapDesktopBackend };