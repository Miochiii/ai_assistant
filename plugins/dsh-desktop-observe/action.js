// One guarded click on an action-ready observation. Planning and replay share
// the same executor; this module only builds the contract request and relays
// the receipt. It never sends Win32 input itself.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buildChordRequest, buildDragRequest, buildKeyRequest, buildRequest, buildScrollRequest, buildTextRequest, runExecutor } from '../../scripts/run_desktop_executor.mjs';
import { selectGrant } from './authorization.js';
import { evidencePath, requireSession } from './bridge.js';
import { attachObservation, imageRoute, readDeliveryPolicy } from './image-delivery.js';

const CLICK_KEYS = new Set(['observation', 'label', 'center', 'coordinate_space', 'expected']);
const SCROLL_KEYS = new Set(['observation', 'label', 'center', 'coordinate_space', 'notches', 'expected']);
const KEY_KEYS = new Set(['observation', 'label', 'center', 'coordinate_space', 'key', 'expected']);
const TEXT_KEYS = new Set(['observation', 'label', 'center', 'coordinate_space', 'text', 'expected']);
const COMBO_KEYS = new Set(['observation', 'label', 'center', 'coordinate_space', 'combo', 'expected']);
const COMBOS = new Set(['Ctrl+Left', 'Ctrl+Right']);
const DRAG_KEYS = new Set(['observation', 'label', 'start', 'end', 'coordinate_space', 'expected']);
const NAV_KEYS = ['Left', 'Right', 'Up', 'Down', 'Home', 'End'];

export const clickParameters = {
  type: 'object', additionalProperties: false,
  required: ['observation', 'label', 'center'],
  properties: {
    observation: { type: 'string', description: 'Absolute observation_path returned by desktop_observe with hwnd (action-ready observation).' },
    label: { type: 'string', description: 'Target label for the receipt, for example 文件(F).' },
    center: { type: 'array', items: { type: 'integer' },
      description: 'Target center [x, y] in the attached image pixels, not desktop pixels.' },
    coordinate_space: { type: 'string', enum: ['attachment', 'image'],
      description: 'attachment (default) uses the model image size; image uses the original observation pixels.' },
    expected: { type: 'string', description: 'What should be true after the click; the executor does not certify it.' },
  },
};

export const scrollParameters = {
  type: 'object', additionalProperties: false,
  required: ['observation', 'label', 'center', 'notches'],
  properties: {
    observation: { type: 'string', description: 'Absolute observation_path returned by desktop_observe with hwnd (action-ready observation).' },
    label: { type: 'string', description: 'Anchor label for the receipt, for example 编辑区.' },
    center: { type: 'array', items: { type: 'integer' },
      description: 'Anchor [x, y] in attached image pixels; the executor moves there before one wheel gesture.' },
    coordinate_space: { type: 'string', enum: ['attachment', 'image'],
      description: 'attachment (default) uses the model image size; image uses original observation pixels.' },
    notches: { type: 'integer', enum: [-3, -2, -1, 1, 2, 3],
      description: 'Vertical wheel notches; positive is up, negative is down; non-zero.' },
    expected: { type: 'string', description: 'Expected visible/scroll effect; the executor does not certify task success.' },
  },
};

export function scrollArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Expected object arguments');
  if (Object.keys(args).some(key => !SCROLL_KEYS.has(key))) throw new Error('Unknown argument');
  if (typeof args.observation !== 'string' || !args.observation) throw new Error('observation must be a path');
  if (typeof args.label !== 'string' || !args.label || args.label.length > 128) throw new Error('label is invalid');
  if (!Array.isArray(args.center) || args.center.length !== 2
    || !args.center.every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('center must be [x, y] in image pixels');
  }
  const coordinateSpace = args.coordinate_space ?? 'attachment';
  if (!['attachment', 'image'].includes(coordinateSpace)) throw new Error('coordinate_space is invalid');
  if (!Number.isSafeInteger(args.notches) || args.notches === 0
    || args.notches < -3 || args.notches > 3) {
    throw new Error('notches must be a non-zero integer in -3..3');
  }
  const expected = args.expected ?? '';
  if (typeof expected !== 'string' || expected.length > 500) throw new Error('expected is invalid');
  return { observation: args.observation, label: args.label, center: args.center,
    coordinateSpace, notches: args.notches, expected };
}

export const keyParameters = {
  type: 'object', additionalProperties: false,
  required: ['observation', 'label', 'center', 'key'],
  properties: {
    observation: { type: 'string', description: 'Absolute observation_path returned by desktop_observe with hwnd (action-ready observation with focus evidence).' },
    label: { type: 'string', description: 'Focus context label for the receipt, for example 编辑区.' },
    center: { type: 'array', items: { type: 'integer' },
      description: 'Focus anchor [x, y] in attached image pixels; it is not a mouse target.' },
    coordinate_space: { type: 'string', enum: ['attachment', 'image'],
      description: 'attachment (default) uses the model image size; image uses original observation pixels.' },
    key: { type: 'string', enum: NAV_KEYS,
      description: 'One short navigation key. No modifiers, Enter, text or repeat.' },
    expected: { type: 'string', description: 'Expected focus/selection effect; the executor does not certify task success.' },
  },
};

export function keyArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Expected object arguments');
  if (Object.keys(args).some(key => !KEY_KEYS.has(key))) throw new Error('Unknown argument');
  if (typeof args.observation !== 'string' || !args.observation) throw new Error('observation must be a path');
  if (typeof args.label !== 'string' || !args.label || args.label.length > 128) throw new Error('label is invalid');
  if (!Array.isArray(args.center) || args.center.length !== 2
    || !args.center.every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('center must be [x, y] in image pixels');
  }
  const coordinateSpace = args.coordinate_space ?? 'attachment';
  if (!['attachment', 'image'].includes(coordinateSpace)) throw new Error('coordinate_space is invalid');
  if (!NAV_KEYS.includes(args.key)) throw new Error('key must be a short navigation key');
  const expected = args.expected ?? '';
  if (typeof expected !== 'string' || expected.length > 500) throw new Error('expected is invalid');
  return { observation: args.observation, label: args.label, center: args.center,
    coordinateSpace, key: args.key, expected };
}

export const textParameters = {
  type: 'object', additionalProperties: false,
  required: ['observation', 'label', 'center', 'text'],
  properties: {
    observation: { type: 'string', description: 'Absolute observation_path returned by desktop_observe with hwnd (action-ready observation with focus evidence).' },
    label: { type: 'string', description: 'Focus/receiver context label for the receipt.' },
    center: { type: 'array', items: { type: 'integer' },
      description: 'Focus anchor [x, y] in attached image pixels; it is not a mouse target.' },
    coordinate_space: { type: 'string', enum: ['attachment', 'image'],
      description: 'attachment (default) uses the model image size; image uses original observation pixels.' },
    text: { type: 'string',
      description: 'Short single-line literal text, at most 16 Unicode scalars. No CR/LF/Tab/control characters, no Enter, no clipboard.' },
    expected: { type: 'string', description: 'Expected visible insertion effect; the executor does not certify task success.' },
  },
};

export const dragParameters = {
  type: 'object', additionalProperties: false,
  required: ['observation', 'label', 'start', 'end'],
  properties: {
    observation: { type: 'string', description: 'Absolute observation_path returned by desktop_observe with hwnd (action-ready observation).' },
    label: { type: 'string', description: 'Drag context label for the receipt.' },
    start: { type: 'array', items: { type: 'integer' },
      description: 'Start [x, y] in image pixels.' },
    end: { type: 'array', items: { type: 'integer' },
      description: 'End [x, y] in the same image. Must differ from start and stay inside the same authorized window.' },
    coordinate_space: { type: 'string', enum: ['attachment', 'image'],
      description: 'attachment (default) uses the model image size; image uses original observation pixels.' },
    expected: { type: 'string', description: 'Expected visible drag effect; the executor does not certify task success.' },
  },
};

export const comboParameters = {
  type: 'object', additionalProperties: false,
  required: ['observation', 'label', 'center', 'combo'],
  properties: {
    observation: { type: 'string', description: 'Absolute observation_path returned by desktop_observe with hwnd (action-ready observation with focus evidence).' },
    label: { type: 'string', description: 'Focus context label for the receipt.' },
    center: { type: 'array', items: { type: 'integer' },
      description: 'Focus anchor [x, y] in attached image pixels; it is not a mouse target.' },
    coordinate_space: { type: 'string', enum: ['attachment', 'image'],
      description: 'attachment (default) uses the model image size; image uses original observation pixels.' },
    combo: { type: 'string', enum: ['Ctrl+Left', 'Ctrl+Right'],
      description: 'One fixed Ctrl+Left or Ctrl+Right chord. No arbitrary modifiers or keys.' },
    expected: { type: 'string', description: 'Expected focus/navigation effect; the executor does not certify task success.' },
  },
};

export function textArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Expected object arguments');
  if (Object.keys(args).some(key => !TEXT_KEYS.has(key))) throw new Error('Unknown argument');
  if (typeof args.observation !== 'string' || !args.observation) throw new Error('observation must be a path');
  if (typeof args.label !== 'string' || !args.label || args.label.length > 128) throw new Error('label is invalid');
  if (!Array.isArray(args.center) || args.center.length !== 2
    || !args.center.every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('center must be [x, y] in image pixels');
  }
  const coordinateSpace = args.coordinate_space ?? 'attachment';
  if (!['attachment', 'image'].includes(coordinateSpace)) throw new Error('coordinate_space is invalid');
  if (typeof args.text !== 'string' || args.text.length < 1 || [...args.text].length > 16) {
    throw new Error('text must be 1..16 Unicode scalars');
  }
  if ([...args.text].some(char => char.codePointAt(0) < 0x20 || char.codePointAt(0) === 0x7f)) {
    throw new Error('text must not contain control characters');
  }
  const expected = args.expected ?? '';
  if (typeof expected !== 'string' || expected.length > 500) throw new Error('expected is invalid');
  return { observation: args.observation, label: args.label, center: args.center,
    coordinateSpace, text: args.text, expected };
}

export function dragArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Expected object arguments');
  if (Object.keys(args).some(key => !DRAG_KEYS.has(key))) throw new Error('Unknown argument');
  if (typeof args.observation !== 'string' || !args.observation) throw new Error('observation must be a path');
  if (typeof args.label !== 'string' || !args.label || args.label.length > 128) throw new Error('label is invalid');
  for (const name of ['start', 'end']) {
    const point = args[name];
    if (!Array.isArray(point) || point.length !== 2
      || !point.every(value => Number.isSafeInteger(value) && value >= 0)) {
      throw new Error(`${name} must be [x, y] in image pixels`);
    }
  }
  if (Math.abs(args.end[0] - args.start[0]) + Math.abs(args.end[1] - args.start[1]) < 8) {
    throw new Error('start and end are too close');
  }
  const coordinateSpace = args.coordinate_space ?? 'attachment';
  if (!['attachment', 'image'].includes(coordinateSpace)) throw new Error('coordinate_space is invalid');
  const expected = args.expected ?? '';
  if (typeof expected !== 'string' || expected.length > 500) throw new Error('expected is invalid');
  return { observation: args.observation, label: args.label, start: args.start, end: args.end,
    coordinateSpace, expected };
}

export function comboArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Expected object arguments');
  if (Object.keys(args).some(key => !COMBO_KEYS.has(key))) throw new Error('Unknown argument');
  if (typeof args.observation !== 'string' || !args.observation) throw new Error('observation must be a path');
  if (typeof args.label !== 'string' || !args.label || args.label.length > 128) throw new Error('label is invalid');
  if (!Array.isArray(args.center) || args.center.length !== 2
    || !args.center.every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('center must be [x, y] in image pixels');
  }
  const coordinateSpace = args.coordinate_space ?? 'attachment';
  if (!['attachment', 'image'].includes(coordinateSpace)) throw new Error('coordinate_space is invalid');
  if (!COMBOS.has(args.combo)) throw new Error('combo must be Ctrl+Left or Ctrl+Right');
  const expected = args.expected ?? '';
  if (typeof expected !== 'string' || expected.length > 500) throw new Error('expected is invalid');
  return { observation: args.observation, label: args.label, center: args.center,
    coordinateSpace, combo: args.combo, expected };
}

export function clickArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Expected object arguments');
  if (Object.keys(args).some(key => !CLICK_KEYS.has(key))) throw new Error('Unknown argument');
  if (typeof args.observation !== 'string' || !args.observation) throw new Error('observation must be a path');
  if (typeof args.label !== 'string' || !args.label || args.label.length > 128) throw new Error('label is invalid');
  if (!Array.isArray(args.center) || args.center.length !== 2
    || !args.center.every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('center must be [x, y] in image pixels');
  }
  const coordinateSpace = args.coordinate_space ?? 'attachment';
  if (!['attachment', 'image'].includes(coordinateSpace)) throw new Error('coordinate_space is invalid');
  const expected = args.expected ?? '';
  if (typeof expected !== 'string' || expected.length > 500) throw new Error('expected is invalid');
  return { observation: args.observation, label: args.label, center: args.center,
    coordinateSpace, expected };
}

async function modelImage(observationPath, manifest) {
  try {
    const value = JSON.parse(await readFile(join(dirname(observationPath), 'model-image.json'), 'utf8'));
    const image = value?.model_image;
    if (value?.observation_id !== manifest.observation_id
      || image?.source_sha256 !== manifest.image.sha256
      || !Number.isSafeInteger(image?.attachment?.width) || image.attachment.width <= 0
      || !Number.isSafeInteger(image?.attachment?.height) || image.attachment.height <= 0) return null;
    return image.attachment;
  } catch {
    return null;
  }
}

export function imageCenter(manifest, attachment, center, coordinateSpace) {
  const width = manifest.image.width;
  const height = manifest.image.height;
  if (coordinateSpace === 'image') {
    if (center[0] >= width || center[1] >= height) throw new Error('Target is outside the observation image');
    return [center[0], center[1]];
  }
  if (!attachment) throw new Error('Attachment coordinates require a delivered model image; use coordinate_space=image only for local planning');
  if (center[0] >= attachment.width || center[1] >= attachment.height) {
    throw new Error('Target is outside the attached image');
  }
  const x = Math.floor(center[0] * width / attachment.width);
  const y = Math.floor(center[1] * height / attachment.height);
  if (x < 0 || x >= width || y < 0 || y >= height) throw new Error('Mapped target is outside the observation image');
  return [x, y];
}

export function createClicker(ctx, { run = runExecutor, policy = readDeliveryPolicy,
  route = imageRoute, attach = attachObservation, runs = null, memory = null } = {}) {
  return async (args, exec) => {
    requireSession(exec);
    const input = clickArgs(args);
    const observationPath = evidencePath(input.observation);
    const folder = dirname(observationPath);
    if (!existsSync(join(folder, 'click-binding.json')) || !existsSync(join(folder, 'source.rgb'))) {
      throw new Error('Observation is read-only; call desktop_observe with hwnd to create an action-ready observation');
    }
    const manifest = JSON.parse(await readFile(observationPath, 'utf8'));
    if (typeof manifest.observation_id !== 'string' || !manifest.image || !manifest.capture_bounds) {
      throw new Error('Observation manifest is incomplete');
    }
    const binding = JSON.parse(await readFile(join(folder, 'click-binding.json'), 'utf8'));
    const session = requireSession(exec);
    const grant = selectGrant({ window: binding.window, action: 'click', session });
    const attachment = await modelImage(observationPath, manifest);
    const center = imageCenter(manifest, attachment, input.center, input.coordinateSpace);
    const request = buildRequest(observationPath, input.label, center, input.expected, grant.grant_id);
    exec.signal?.throwIfAborted();

    let ledgerRun = null;
    let memoryContext = null;
    async function finish(termination, inputDelivery, verification, operation, executorState = 'unknown', facts = []) {
      if (!ledgerRun || !runs) return null;
      let record;
      try {
        record = await runs.end({ run_id: ledgerRun.run_id, operation_id: operation,
          termination_reason: termination, input_delivery: inputDelivery,
          verification, executor_state: executorState, checkpoint_facts: facts,
          checkpoint_write: memoryContext ? { status: 'pending' }
            : { status: 'skipped', reason: 'automation_disabled_or_unavailable' } });
      } catch (error) {
        return { error: String(error?.message ?? 'RUN_LEDGER_END_FAILED').slice(0, 200) };
      }
      if (memoryContext && memory) {
        try {
          const result = await memory.checkpoint(exec.agent.session, ledgerRun.run_id);
          if (['skipped', 'failed'].includes(result?.status) && runs.checkpointResult) {
            await runs.checkpointResult({ run_id: ledgerRun.run_id, result: { status: result.status,
              ...(result.reason ? { reason: result.reason } : {}),
              ...(result.error_code ? { error_code: result.error_code } : {}) } });
          }
          record = runs.get ? await runs.get(ledgerRun.run_id) : { ...record, checkpoint_write: result };
        } catch (error) {
          const result = { status: 'failed', error_code: String(error?.code ?? 'CHECKPOINT_WRITE_FAILED').slice(0, 128) };
          try {
            record = runs.checkpointResult ? await runs.checkpointResult({ run_id: ledgerRun.run_id, result })
              : { ...record, checkpoint_write: result };
          } catch { record = { ...record, checkpoint_write: result }; }
        }
      }
      return record;
    }

    if (runs) {
      try { memoryContext = await memory?.context(exec.agent.session) ?? null; } catch { /* optional memory */ }
      // Fail closed: an authorized click is not sent without a durable run record.
      ledgerRun = await runs.start({ task_id: `desktop-click:${manifest.observation_id}`,
        request_id: memoryContext?.memory_context?.request_id ?? session,
        ...(memoryContext ?? {}), policy_version: 'desktop-click-v1' });
    }

    let receipt;
    try {
      receipt = await run(request, { signal: exec.signal, harnessSession: session });
    } catch (error) {
      const termination = error?.code === 'EXECUTOR_TIMEOUT' ? 'timeout'
        : error?.code === 'EXECUTOR_CANCELLED' || exec.signal?.aborted ? 'cancelled' : 'error';
      const runRecord = await finish(termination, 'unknown', { status: 'unknown', reason: 'executor_error' }, 'click-error');
      if (error?.code === 'EXECUTOR_CANCELLED' || exec.signal?.aborted) {
        return { ok: false, outcome: 'cancelled_unknown', error_code: 'CANCELLED',
          cancelled: true, cancellation: 'unknown_after_launch',
          observation_path: observationPath, expected: input.expected,
          target_image_pixels: center, task_success_verified: false,
          run_id: ledgerRun?.run_id ?? null,
          run_record: runRecord,
          notice: 'Cancelled after launch; whether input was delivered is unknown. No retry; inspect the observation/existing receipt.' };
      }
      throw new Error(`Executor failed (${error?.code ?? 'EXECUTOR_FAILED'}): ${error?.message ?? 'unknown'}; no automatic retry; checkpoint_write=${runRecord?.checkpoint_write?.status ?? 'unavailable'}`);
    }
    const inputDelivery = receipt?.input_delivered === true || receipt?.input_delivery_observed === true
      ? 'sent'
      : receipt?.input_delivered === false || receipt?.input_delivery_observed === false ? 'not_sent' : 'unknown';
    const runRecord = await finish(receipt?.cancelled ? 'cancelled' : receipt?.ok ? 'completed' : 'stopped', inputDelivery,
      { status: 'unknown', reason: 'no_independent_task_verification' }, 'click-finish', 'stopped',
      inputDelivery === 'sent' ? [{ step: 1, input_delivery: 'sent', verification: 'unknown' }] : []);
    const output = { ...receipt, observation_path: observationPath, expected: input.expected,
      target_image_pixels: center, task_success_verified: false,
      observation_timings: manifest.timings ?? null,
      run_id: ledgerRun?.run_id ?? null,
      ...(runRecord && !runRecord.error ? { run_record: runRecord } : {}),
      ...(runRecord?.error ? { run_ledger_error: runRecord.error } : {}),
      notice: 'Input delivery is not task success. Inspect the post-action screenshot or delta; this tool does not retry.' };
    if (receipt?.after_observation) {
      output.after_observation_path = receipt.after_observation;
      try {
        if ((await policy())?.image_attachment_enabled === true) {
          const afterManifest = JSON.parse(await readFile(evidencePath(receipt.after_observation), 'utf8'));
          const afterRoute = await route(ctx, exec);
          const attached = await attach(ctx, afterManifest, afterRoute, exec);
          output.after_model_image = attached.model_image;
          output.after_image_attached = true;
        } else {
          output.after_image_attached = false;
          output.after_image_policy = 'disabled';
        }
      } catch (error) {
        output.after_image_attached = false;
        output.after_image_error = String(error?.message ?? 'IMAGE_ATTACH_FAILED').slice(0, 200);
      }
    }
    return output;
  };
}

export function createScroller(ctx, { run = runExecutor, runs = null, memory = null, policy = readDeliveryPolicy } = {}) {
  return async (args, exec) => {
    requireSession(exec);
    const input = scrollArgs(args);
    const observationPath = evidencePath(input.observation);
    const folder = dirname(observationPath);
    if (!existsSync(join(folder, 'click-binding.json')) || !existsSync(join(folder, 'source.rgb'))) {
      throw new Error('Observation is read-only; call desktop_observe with hwnd to create an action-ready observation');
    }
    const manifest = JSON.parse(await readFile(observationPath, 'utf8'));
    if (typeof manifest.observation_id !== 'string' || !manifest.image || !manifest.capture_bounds) {
      throw new Error('Observation manifest is incomplete');
    }
    const binding = JSON.parse(await readFile(join(folder, 'click-binding.json'), 'utf8'));
    const session = requireSession(exec);
    const grant = selectGrant({ window: binding.window, action: 'scroll', session });
    const attachment = await modelImage(observationPath, manifest);
    const center = imageCenter(manifest, attachment, input.center, input.coordinateSpace);
    const request = buildScrollRequest(observationPath, input.label, center, input.notches,
      input.expected, grant.grant_id);
    exec.signal?.throwIfAborted();

    let ledgerRun = null;
    let memoryContext = null;
    async function finish(termination, inputDelivery, verification, operation, executorState = 'unknown', facts = []) {
      if (!ledgerRun || !runs) return null;
      let record;
      try {
        record = await runs.end({ run_id: ledgerRun.run_id, operation_id: operation,
          termination_reason: termination, input_delivery: inputDelivery,
          verification, executor_state: executorState, checkpoint_facts: facts,
          checkpoint_write: memoryContext ? { status: 'pending' }
            : { status: 'skipped', reason: 'automation_disabled_or_unavailable' } });
      } catch (error) {
        return { error: String(error?.message ?? 'RUN_LEDGER_END_FAILED').slice(0, 200) };
      }
      if (memoryContext && memory) {
        try {
          const checkpoint = await memory.checkpoint(exec.agent.session, ledgerRun.run_id);
          if (['skipped', 'failed'].includes(checkpoint?.status) && runs.checkpointResult) {
            await runs.checkpointResult({ run_id: ledgerRun.run_id, result: { status: checkpoint.status,
              ...(checkpoint.reason ? { reason: checkpoint.reason } : {}),
              ...(checkpoint.error_code ? { error_code: checkpoint.error_code } : {}) } });
          }
          record = runs.get ? await runs.get(ledgerRun.run_id) : { ...record, checkpoint_write: checkpoint };
        } catch (error) {
          const result = { status: 'failed', error_code: String(error?.code ?? 'CHECKPOINT_WRITE_FAILED').slice(0, 128) };
          try {
            record = runs.checkpointResult ? await runs.checkpointResult({ run_id: ledgerRun.run_id, result })
              : { ...record, checkpoint_write: result };
          } catch { record = { ...record, checkpoint_write: result }; }
        }
      }
      return record;
    }

    if (runs) {
      try { memoryContext = await memory?.context(exec.agent.session) ?? null; } catch { /* optional memory */ }
      ledgerRun = await runs.start({ task_id: `desktop-scroll:${manifest.observation_id}`,
        request_id: memoryContext?.memory_context?.request_id ?? session,
        ...(memoryContext ?? {}), policy_version: 'desktop-scroll-v1' });
    }

    let receipt;
    try {
      receipt = await run(request, { signal: exec.signal, harnessSession: session });
    } catch (error) {
      const termination = error?.code === 'EXECUTOR_TIMEOUT' ? 'timeout'
        : error?.code === 'EXECUTOR_CANCELLED' || exec.signal?.aborted ? 'cancelled' : 'error';
      const runRecord = await finish(termination, 'unknown', { status: 'unknown', reason: 'executor_error' },
        'scroll-error');
      if (error?.code === 'EXECUTOR_CANCELLED' || exec.signal?.aborted) {
        return { ok: false, outcome: 'cancelled_unknown', error_code: 'CANCELLED',
          cancelled: true, cancellation: 'unknown_after_launch', observation_path: observationPath,
          expected: input.expected, target_image_pixels: center, task_success_verified: false,
          run_id: ledgerRun?.run_id ?? null, run_record: runRecord,
          notice: 'Cancelled after launch; whether wheel input was delivered is unknown. No retry.' };
      }
      throw new Error(`Executor failed (${error?.code ?? 'EXECUTOR_FAILED'}): ${error?.message ?? 'unknown'}; no automatic retry`);
    }
    const sent = Number(receipt?.input_events_sent ?? 0) > 0;
    const inputDelivery = sent ? 'sent' : 'unknown';
    const runRecord = await finish(receipt?.cancelled ? 'cancelled' : receipt?.ok ? 'completed' : 'stopped',
      inputDelivery, { status: 'unknown', reason: 'no_independent_task_verification' },
      'scroll-finish', 'stopped',
      sent ? [{ step: 1, input_delivery: 'sent', verification: 'unknown' }] : []);
    return { ...receipt, observation_path: observationPath, expected: input.expected,
      target_image_pixels: center, task_success_verified: false,
      scroll_notches: input.notches, input_delivery_observed: false,
      run_id: ledgerRun?.run_id ?? null,
      ...(runRecord && !runRecord.error ? { run_record: runRecord } : {}),
      ...(runRecord?.error ? { run_ledger_error: runRecord.error } : {}),
      notice: 'Wheel/API acceptance is not receiver consumption or task success. Observe again; this tool does not retry.' };
  };
}

export function renderScroll(_args, value) {
  return [{ type: 'text', text: `Scroll: ${value.status ?? value.outcome ?? 'unknown'}\n${JSON.stringify(value)}` }];
}

export function createKeyer(ctx, { run = runExecutor, runs = null, memory = null } = {}) {
  return async (args, exec) => {
    requireSession(exec);
    const input = keyArgs(args);
    const observationPath = evidencePath(input.observation);
    const folder = dirname(observationPath);
    if (!existsSync(join(folder, 'click-binding.json')) || !existsSync(join(folder, 'source.rgb'))) {
      throw new Error('Observation is read-only; call desktop_observe with hwnd to create an action-ready observation');
    }
    const manifest = JSON.parse(await readFile(observationPath, 'utf8'));
    if (typeof manifest.observation_id !== 'string' || !manifest.image || !manifest.capture_bounds) {
      throw new Error('Observation manifest is incomplete');
    }
    const binding = JSON.parse(await readFile(join(folder, 'click-binding.json'), 'utf8'));
    if (!binding.focus) throw new Error('Observation has no focus evidence; observe the target again');
    const session = requireSession(exec);
    const grant = selectGrant({ window: binding.window, action: 'key', session });
    const attachment = await modelImage(observationPath, manifest);
    const center = imageCenter(manifest, attachment, input.center, input.coordinateSpace);
    const request = buildKeyRequest(observationPath, input.label, center, input.key,
      input.expected, grant.grant_id);
    exec.signal?.throwIfAborted();

    let ledgerRun = null;
    let memoryContext = null;
    async function finish(termination, inputDelivery, verification, operation, executorState = 'unknown', facts = []) {
      if (!ledgerRun || !runs) return null;
      let record;
      try {
        record = await runs.end({ run_id: ledgerRun.run_id, operation_id: operation,
          termination_reason: termination, input_delivery: inputDelivery,
          verification, executor_state: executorState, checkpoint_facts: facts,
          checkpoint_write: memoryContext ? { status: 'pending' }
            : { status: 'skipped', reason: 'automation_disabled_or_unavailable' } });
      } catch (error) {
        return { error: String(error?.message ?? 'RUN_LEDGER_END_FAILED').slice(0, 200) };
      }
      if (memoryContext && memory) {
        try {
          const checkpoint = await memory.checkpoint(exec.agent.session, ledgerRun.run_id);
          if (['skipped', 'failed'].includes(checkpoint?.status) && runs.checkpointResult) {
            await runs.checkpointResult({ run_id: ledgerRun.run_id, result: { status: checkpoint.status,
              ...(checkpoint.reason ? { reason: checkpoint.reason } : {}),
              ...(checkpoint.error_code ? { error_code: checkpoint.error_code } : {}) } });
          }
          record = runs.get ? await runs.get(ledgerRun.run_id) : { ...record, checkpoint_write: checkpoint };
        } catch (error) {
          const result = { status: 'failed', error_code: String(error?.code ?? 'CHECKPOINT_WRITE_FAILED').slice(0, 128) };
          try {
            record = runs.checkpointResult ? await runs.checkpointResult({ run_id: ledgerRun.run_id, result })
              : { ...record, checkpoint_write: result };
          } catch { record = { ...record, checkpoint_write: result }; }
        }
      }
      return record;
    }

    if (runs) {
      try { memoryContext = await memory?.context(exec.agent.session) ?? null; } catch { /* optional memory */ }
      ledgerRun = await runs.start({ task_id: `desktop-key:${manifest.observation_id}`,
        request_id: memoryContext?.memory_context?.request_id ?? session,
        ...(memoryContext ?? {}), policy_version: 'desktop-key-v1' });
    }

    let receipt;
    try {
      receipt = await run(request, { signal: exec.signal, harnessSession: session });
    } catch (error) {
      const termination = error?.code === 'EXECUTOR_TIMEOUT' ? 'timeout'
        : error?.code === 'EXECUTOR_CANCELLED' || exec.signal?.aborted ? 'cancelled' : 'error';
      const runRecord = await finish(termination, 'unknown', { status: 'unknown', reason: 'executor_error' },
        'key-error');
      if (error?.code === 'EXECUTOR_CANCELLED' || exec.signal?.aborted) {
        return { ok: false, outcome: 'cancelled_unknown', error_code: 'CANCELLED',
          cancelled: true, cancellation: 'unknown_after_launch', observation_path: observationPath,
          expected: input.expected, target_image_pixels: center, task_success_verified: false,
          run_id: ledgerRun?.run_id ?? null, run_record: runRecord,
          notice: 'Cancelled after launch; whether key input was delivered is unknown. No retry.' };
      }
      throw new Error(`Executor failed (${error?.code ?? 'EXECUTOR_FAILED'}): ${error?.message ?? 'unknown'}; no automatic retry`);
    }
    const sent = Number(receipt?.input_events_sent ?? 0) > 0;
    const inputDelivery = sent ? 'sent' : 'unknown';
    const runRecord = await finish(receipt?.cancelled ? 'cancelled' : receipt?.ok ? 'completed' : 'stopped',
      inputDelivery, { status: 'unknown', reason: 'no_independent_task_verification' },
      'key-finish', 'stopped',
      sent ? [{ step: 1, input_delivery: 'sent', verification: 'unknown' }] : []);
    return { ...receipt, observation_path: observationPath, expected: input.expected,
      target_image_pixels: center, task_success_verified: false, key: { key: input.key },
      input_delivery_observed: false, run_id: ledgerRun?.run_id ?? null,
      ...(runRecord && !runRecord.error ? { run_record: runRecord } : {}),
      ...(runRecord?.error ? { run_ledger_error: runRecord.error } : {}),
      notice: 'Key/API acceptance is not focus verification or task success. Observe again; this tool does not retry.' };
  };
}

export function renderKey(_args, value) {
  return [{ type: 'text', text: `Key: ${value.outcome ?? value.status ?? 'unknown'}\n${JSON.stringify(value)}` }];
}

export function createTexter(ctx, { run = runExecutor, runs = null, memory = null } = {}) {
  return async (args, exec) => {
    requireSession(exec);
    const input = textArgs(args);
    const observationPath = evidencePath(input.observation);
    const folder = dirname(observationPath);
    if (!existsSync(join(folder, 'click-binding.json')) || !existsSync(join(folder, 'source.rgb'))) {
      throw new Error('Observation is read-only; call desktop_observe with hwnd to create an action-ready observation');
    }
    const manifest = JSON.parse(await readFile(observationPath, 'utf8'));
    if (typeof manifest.observation_id !== 'string' || !manifest.image || !manifest.capture_bounds) {
      throw new Error('Observation manifest is incomplete');
    }
    const binding = JSON.parse(await readFile(join(folder, 'click-binding.json'), 'utf8'));
    if (!binding.focus) throw new Error('Observation has no focus evidence; observe the target again');
    const session = requireSession(exec);
    const grant = selectGrant({ window: binding.window, action: 'text', session });
    const attachment = await modelImage(observationPath, manifest);
    const center = imageCenter(manifest, attachment, input.center, input.coordinateSpace);
    const request = buildTextRequest(observationPath, input.label, center, input.text,
      input.expected, grant.grant_id);
    exec.signal?.throwIfAborted();

    let ledgerRun = null;
    let memoryContext = null;
    async function finish(termination, inputDelivery, verification, operation, executorState = 'unknown', facts = []) {
      if (!ledgerRun || !runs) return null;
      let record;
      try {
        record = await runs.end({ run_id: ledgerRun.run_id, operation_id: operation,
          termination_reason: termination, input_delivery: inputDelivery,
          verification, executor_state: executorState, checkpoint_facts: facts,
          checkpoint_write: memoryContext ? { status: 'pending' }
            : { status: 'skipped', reason: 'automation_disabled_or_unavailable' } });
      } catch (error) {
        return { error: String(error?.message ?? 'RUN_LEDGER_END_FAILED').slice(0, 200) };
      }
      if (memoryContext && memory) {
        try {
          const checkpoint = await memory.checkpoint(exec.agent.session, ledgerRun.run_id);
          if (['skipped', 'failed'].includes(checkpoint?.status) && runs.checkpointResult) {
            await runs.checkpointResult({ run_id: ledgerRun.run_id, result: { status: checkpoint.status,
              ...(checkpoint.reason ? { reason: checkpoint.reason } : {}),
              ...(checkpoint.error_code ? { error_code: checkpoint.error_code } : {}) } });
          }
          record = runs.get ? await runs.get(ledgerRun.run_id) : { ...record, checkpoint_write: checkpoint };
        } catch (error) {
          const result = { status: 'failed', error_code: String(error?.code ?? 'CHECKPOINT_WRITE_FAILED').slice(0, 128) };
          try {
            record = runs.checkpointResult ? await runs.checkpointResult({ run_id: ledgerRun.run_id, result })
              : { ...record, checkpoint_write: result };
          } catch { record = { ...record, checkpoint_write: result }; }
        }
      }
      return record;
    }

    if (runs) {
      try { memoryContext = await memory?.context(exec.agent.session) ?? null; } catch { /* optional memory */ }
      ledgerRun = await runs.start({ task_id: `desktop-text:${manifest.observation_id}`,
        request_id: memoryContext?.memory_context?.request_id ?? session,
        ...(memoryContext ?? {}), policy_version: 'desktop-text-v1' });
    }

    let receipt;
    try {
      receipt = await run(request, { signal: exec.signal, harnessSession: session });
    } catch (error) {
      const termination = error?.code === 'EXECUTOR_TIMEOUT' ? 'timeout'
        : error?.code === 'EXECUTOR_CANCELLED' || exec.signal?.aborted ? 'cancelled' : 'error';
      const runRecord = await finish(termination, 'unknown', { status: 'unknown', reason: 'executor_error' },
        'text-error');
      if (error?.code === 'EXECUTOR_CANCELLED' || exec.signal?.aborted) {
        return { ok: false, outcome: 'cancelled_unknown', error_code: 'CANCELLED',
          cancelled: true, cancellation: 'unknown_after_launch', observation_path: observationPath,
          expected: input.expected, center, task_success_verified: false,
          run_id: ledgerRun?.run_id ?? null, run_record: runRecord,
          notice: 'Cancelled after launch; whether text input was delivered is unknown. No retry.' };
      }
      throw new Error(`Executor failed (${error?.code ?? 'EXECUTOR_FAILED'}): ${error?.message ?? 'unknown'}; no automatic retry`);
    }
    const sent = Number(receipt?.input_events_sent ?? 0) > 0;
    const inputDelivery = sent ? 'sent' : 'unknown';
    const runRecord = await finish(receipt?.cancelled ? 'cancelled' : receipt?.ok ? 'completed' : 'stopped',
      inputDelivery, { status: 'unknown', reason: 'no_independent_task_verification' },
      'text-finish', 'stopped',
      sent ? [{ step: 1, input_delivery: 'sent', verification: 'unknown' }] : []);
    return { ...receipt, observation_path: observationPath, expected: input.expected,
      target_image_pixels: center, task_success_verified: false,
      text_summary: { scalars: [...input.text].length,
        utf16_units: receipt?.text?.utf16_units ?? null },
      receiver_verification: { status: 'visual_review_required',
        method: 'post_action_screenshot', text_stored: false },
      text_stored: false, input_delivery_observed: false,
      run_id: ledgerRun?.run_id ?? null,
      ...(runRecord && !runRecord.error ? { run_record: runRecord } : {}),
      ...(runRecord?.error ? { run_ledger_error: runRecord.error } : {}),
      notice: 'Text API acceptance is not inserted-text verification or task success. Inspect the receiver and observe again; no retry.' };
  };
}

export function renderText(_args, value) {
  return [{ type: 'text', text: `Text: ${value.outcome ?? value.status ?? 'unknown'}\n${JSON.stringify(value)}` }];
}

export function createChorder(ctx, { run = runExecutor, runs = null, memory = null } = {}) {
  return async (args, exec) => {
    requireSession(exec);
    const input = comboArgs(args);
    const observationPath = evidencePath(input.observation);
    const folder = dirname(observationPath);
    if (!existsSync(join(folder, 'click-binding.json')) || !existsSync(join(folder, 'source.rgb'))) {
      throw new Error('Observation is read-only; call desktop_observe with hwnd to create an action-ready observation');
    }
    const manifest = JSON.parse(await readFile(observationPath, 'utf8'));
    if (typeof manifest.observation_id !== 'string' || !manifest.image || !manifest.capture_bounds) {
      throw new Error('Observation manifest is incomplete');
    }
    const binding = JSON.parse(await readFile(join(folder, 'click-binding.json'), 'utf8'));
    if (!binding.focus) throw new Error('Observation has no focus evidence; observe the target again');
    const session = requireSession(exec);
    const grant = selectGrant({ window: binding.window, action: 'chord', session });
    const attachment = await modelImage(observationPath, manifest);
    const center = imageCenter(manifest, attachment, input.center, input.coordinateSpace);
    const request = buildChordRequest(observationPath, input.label, center, input.combo,
      input.expected, grant.grant_id);
    exec.signal?.throwIfAborted();

    let ledgerRun = null;
    let memoryContext = null;
    async function finish(termination, inputDelivery, verification, operation, executorState = 'unknown', facts = []) {
      if (!ledgerRun || !runs) return null;
      let record;
      try {
        record = await runs.end({ run_id: ledgerRun.run_id, operation_id: operation,
          termination_reason: termination, input_delivery: inputDelivery,
          verification, executor_state: executorState, checkpoint_facts: facts,
          checkpoint_write: memoryContext ? { status: 'pending' }
            : { status: 'skipped', reason: 'automation_disabled_or_unavailable' } });
      } catch (error) {
        return { error: String(error?.message ?? 'RUN_LEDGER_END_FAILED').slice(0, 200) };
      }
      if (memoryContext && memory) {
        try {
          const checkpoint = await memory.checkpoint(exec.agent.session, ledgerRun.run_id);
          if (['skipped', 'failed'].includes(checkpoint?.status) && runs.checkpointResult) {
            await runs.checkpointResult({ run_id: ledgerRun.run_id, result: { status: checkpoint.status,
              ...(checkpoint.reason ? { reason: checkpoint.reason } : {}),
              ...(checkpoint.error_code ? { error_code: checkpoint.error_code } : {}) } });
          }
          record = runs.get ? await runs.get(ledgerRun.run_id) : { ...record, checkpoint_write: checkpoint };
        } catch (error) {
          const result = { status: 'failed', error_code: String(error?.code ?? 'CHECKPOINT_WRITE_FAILED').slice(0, 128) };
          try {
            record = runs.checkpointResult ? await runs.checkpointResult({ run_id: ledgerRun.run_id, result })
              : { ...record, checkpoint_write: result };
          } catch { record = { ...record, checkpoint_write: result }; }
        }
      }
      return record;
    }

    if (runs) {
      try { memoryContext = await memory?.context(exec.agent.session) ?? null; } catch { /* optional memory */ }
      ledgerRun = await runs.start({ task_id: `desktop-chord:${manifest.observation_id}`,
        request_id: memoryContext?.memory_context?.request_id ?? session,
        ...(memoryContext ?? {}), policy_version: 'desktop-chord-v1' });
    }

    let receipt;
    try {
      receipt = await run(request, { signal: exec.signal, harnessSession: session });
    } catch (error) {
      const termination = error?.code === 'EXECUTOR_TIMEOUT' ? 'timeout'
        : error?.code === 'EXECUTOR_CANCELLED' || exec.signal?.aborted ? 'cancelled' : 'error';
      const runRecord = await finish(termination, 'unknown', { status: 'unknown', reason: 'executor_error' },
        'chord-error');
      if (error?.code === 'EXECUTOR_CANCELLED' || exec.signal?.aborted) {
        return { ok: false, outcome: 'cancelled_unknown', error_code: 'CANCELLED',
          cancelled: true, cancellation: 'unknown_after_launch', observation_path: observationPath,
          expected: input.expected, center, task_success_verified: false, combo: input.combo,
          run_id: ledgerRun?.run_id ?? null, run_record: runRecord,
          notice: 'Cancelled after launch; whether chord input was delivered is unknown. No retry.' };
      }
      throw new Error(`Executor failed (${error?.code ?? 'EXECUTOR_FAILED'}): ${error?.message ?? 'unknown'}; no automatic retry`);
    }
    const sent = Number(receipt?.input_events_sent ?? 0) > 0;
    const inputDelivery = sent ? 'sent' : 'unknown';
    const runRecord = await finish(receipt?.cancelled ? 'cancelled' : receipt?.ok ? 'completed' : 'stopped',
      inputDelivery, { status: 'unknown', reason: 'no_independent_task_verification' },
      'chord-finish', 'stopped',
      sent ? [{ step: 1, input_delivery: 'sent', verification: 'unknown' }] : []);
    return { ...receipt, observation_path: observationPath, expected: input.expected,
      target_image_pixels: center, task_success_verified: false, combo: input.combo,
      chord_summary: { modifiers: ['ctrl'], key: input.combo.split('+')[1] },
      input_delivery_observed: false,
      run_id: ledgerRun?.run_id ?? null,
      ...(runRecord && !runRecord.error ? { run_record: runRecord } : {}),
      ...(runRecord?.error ? { run_ledger_error: runRecord.error } : {}),
      notice: 'Chord API acceptance is not receiver verification or task success. Observe again; no retry.' };
  };
}

export function createDragger(ctx, { run = runExecutor, runs = null, memory = null } = {}) {
  return async (args, exec) => {
    requireSession(exec);
    const input = dragArgs(args);
    const observationPath = evidencePath(input.observation);
    const folder = dirname(observationPath);
    if (!existsSync(join(folder, 'click-binding.json')) || !existsSync(join(folder, 'source.rgb'))) {
      throw new Error('Observation is read-only; call desktop_observe with hwnd to create an action-ready observation');
    }
    const manifest = JSON.parse(await readFile(observationPath, 'utf8'));
    if (typeof manifest.observation_id !== 'string' || !manifest.image || !manifest.capture_bounds) {
      throw new Error('Observation manifest is incomplete');
    }
    const binding = JSON.parse(await readFile(join(folder, 'click-binding.json'), 'utf8'));
    const session = requireSession(exec);
    const grant = selectGrant({ window: binding.window, action: 'drag', session });
    const attachment = await modelImage(observationPath, manifest);
    const start = imageCenter(manifest, attachment, input.start, input.coordinateSpace);
    const end = imageCenter(manifest, attachment, input.end, input.coordinateSpace);
    const request = buildDragRequest(observationPath, input.label, start, end,
      input.expected, grant.grant_id);
    exec.signal?.throwIfAborted();

    let ledgerRun = null;
    let memoryContext = null;
    async function finish(termination, inputDelivery, verification, operation, executorState = 'unknown', facts = []) {
      if (!ledgerRun || !runs) return null;
      let record;
      try {
        record = await runs.end({ run_id: ledgerRun.run_id, operation_id: operation,
          termination_reason: termination, input_delivery: inputDelivery,
          verification, executor_state: executorState, checkpoint_facts: facts,
          checkpoint_write: memoryContext ? { status: 'pending' }
            : { status: 'skipped', reason: 'automation_disabled_or_unavailable' } });
      } catch (error) {
        return { error: String(error?.message ?? 'RUN_LEDGER_END_FAILED').slice(0, 200) };
      }
      if (memoryContext && memory) {
        try {
          const checkpoint = await memory.checkpoint(exec.agent.session, ledgerRun.run_id);
          if (['skipped', 'failed'].includes(checkpoint?.status) && runs.checkpointResult) {
            await runs.checkpointResult({ run_id: ledgerRun.run_id, result: { status: checkpoint.status,
              ...(checkpoint.reason ? { reason: checkpoint.reason } : {}),
              ...(checkpoint.error_code ? { error_code: checkpoint.error_code } : {}) } });
          }
          record = runs.get ? await runs.get(ledgerRun.run_id) : { ...record, checkpoint_write: checkpoint };
        } catch (error) {
          const result = { status: 'failed', error_code: String(error?.code ?? 'CHECKPOINT_WRITE_FAILED').slice(0, 128) };
          try {
            record = runs.checkpointResult ? await runs.checkpointResult({ run_id: ledgerRun.run_id, result })
              : { ...record, checkpoint_write: result };
          } catch { record = { ...record, checkpoint_write: result }; }
        }
      }
      return record;
    }

    if (runs) {
      try { memoryContext = await memory?.context(exec.agent.session) ?? null; } catch { /* optional memory */ }
      ledgerRun = await runs.start({ task_id: `desktop-drag:${manifest.observation_id}`,
        request_id: memoryContext?.memory_context?.request_id ?? session,
        ...(memoryContext ?? {}), policy_version: 'desktop-drag-v1' });
    }

    let receipt;
    try {
      receipt = await run(request, { signal: exec.signal, harnessSession: session });
    } catch (error) {
      const termination = error?.code === 'EXECUTOR_TIMEOUT' ? 'timeout'
        : error?.code === 'EXECUTOR_CANCELLED' || exec.signal?.aborted ? 'cancelled' : 'error';
      const runRecord = await finish(termination, 'unknown', { status: 'unknown', reason: 'executor_error' },
        'drag-error');
      if (error?.code === 'EXECUTOR_CANCELLED' || exec.signal?.aborted) {
        return { ok: false, outcome: 'cancelled_unknown', error_code: 'CANCELLED',
          cancelled: true, cancellation: 'unknown_after_launch', observation_path: observationPath,
          expected: input.expected, start, end, task_success_verified: false,
          run_id: ledgerRun?.run_id ?? null, run_record: runRecord,
          notice: 'Cancelled after launch; whether drag input was delivered is unknown. No retry.' };
      }
      throw new Error(`Executor failed (${error?.code ?? 'EXECUTOR_FAILED'}): ${error?.message ?? 'unknown'}; no automatic retry`);
    }
    const sent = Number(receipt?.input_events_sent ?? 0) > 0;
    const inputDelivery = sent ? 'sent' : 'unknown';
    const runRecord = await finish(receipt?.cancelled ? 'cancelled' : receipt?.ok ? 'completed' : 'stopped',
      inputDelivery, { status: 'unknown', reason: 'no_independent_task_verification' },
      'drag-finish', 'stopped',
      sent ? [{ step: 1, input_delivery: 'sent', verification: 'unknown' }] : []);
    return { ...receipt, observation_path: observationPath, expected: input.expected,
      target_image_pixels: start, end_image_pixels: end, task_success_verified: false,
      drag_summary: { start, end }, input_delivery_observed: false,
      run_id: ledgerRun?.run_id ?? null,
      ...(runRecord && !runRecord.error ? { run_record: runRecord } : {}),
      ...(runRecord?.error ? { run_ledger_error: runRecord.error } : {}),
      notice: 'Drag API acceptance is not receiver verification or task success. Inspect the post-action screenshot; no retry.' };
  };
}

export function renderDrag(_args, value) {
  return [{ type: 'text', text: `Drag: ${value.outcome ?? value.status ?? 'unknown'}\n${JSON.stringify(value)}` }];
}

export function renderCombo(_args, value) {
  return [{ type: 'text', text: `Combo: ${value.outcome ?? value.status ?? 'unknown'} ${value.combo ?? ''}\n${JSON.stringify(value)}` }];
}

export function renderClick(_args, value) {
  const blocks = [{ type: 'text', text: JSON.stringify(value) }];
  if (value?.after_model_image?.attachment) {
    const attachment = value.after_model_image.attachment;
    blocks.push({ type: 'text', text: `Post-action screenshot: attachment pixels width=${attachment.width}, height=${attachment.height}. Compare it with expected "${value.expected ?? ''}". task_success_verified remains false; the executor only confirms input delivery. A mismatch means stop or replan; do not reuse this observation for another click.` });
    blocks.push({ type: 'image', attachment });
  } else {
    blocks.push({ type: 'text', text: `Post-action screenshot saved locally at ${value?.after_observation_path ?? 'unknown'}. Image delivery is disabled or failed; the delta is a change signal, not task success. Do not infer success from input delivery alone.` });
  }
  return blocks;
}
