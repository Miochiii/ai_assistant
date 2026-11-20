import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from '../plugins/dsh-desktop-observe/bridge.js';
import { clickArgs, comboArgs, createChorder, createClicker, createDragger, createKeyer,
  createScroller, createTexter, dragArgs, imageCenter, keyArgs, renderClick, scrollArgs,
  textArgs } from '../plugins/dsh-desktop-observe/action.js';
import { runExecutor } from '../scripts/run_desktop_executor.mjs';

const SHA = 'a'.repeat(64);

function execution() {
  return { agent: { session: { header: { cwd: root, id: 'action-test' } } },
    signal: new AbortController().signal };
}

async function fixture() {
  const folder = await mkdtemp(join(root, 'results', 'vision', 'test-action-'));
  const observationPath = join(folder, 'observation.json');
  const window = { hwnd: 1, pid: 2, class_name: 'Notepad', title: 'test.txt - 记事本', rect: [0, 0, 800, 600] };
  const manifest = { schema_version: 1, observation_id: 'obs-test',
    captured_at: new Date().toISOString(), coordinate_space: 'physical_desktop_pixels', monitor_index: 1,
    capture_bounds: { left: 355, top: 63, width: 800, height: 600 },
    image: { path: join(folder, 'screen.png'), width: 800, height: 600, sha256: SHA, resized: false } };
  await writeFile(observationPath, JSON.stringify(manifest));
  await writeFile(join(folder, 'screen.png'), 'fake');
  await writeFile(join(folder, 'source.rgb'), 'fake-rgb');
  await writeFile(join(folder, 'click-binding.json'), JSON.stringify({ source_sha256: SHA, rgb_sha256: 'b'.repeat(64),
    window, foreground: 1, last_input_tick: 1,
    focus: { available: true, active_hwnd: 1, focus_hwnd: 1, focus_root_hwnd: 1,
      capture_hwnd: 0, menu_owner_hwnd: 0, caret_hwnd: 0 } }));
  await writeFile(join(folder, 'model-image.json'), JSON.stringify({ schema_version: 1, observation_id: 'obs-test',
    model_image: { attachment: { attachmentId: 'sha256:x', mediaType: 'image/png', bytes: 80, width: 400, height: 300 },
      source_sha256: SHA } }));
  const grantId = randomUUID();
  const grantFolder = join(root, 'runtime', 'authorizations');
  await mkdir(grantFolder, { recursive: true });
  await writeFile(join(grantFolder, `${grantId}.json`), JSON.stringify({
    schema_version: 1, grant_id: grantId, created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3600_000).toISOString(), task: 'action test',
    harness_session: 'action-test', windows_session: 1, windows: [window],
    actions: ['activate', 'observe', 'click', 'scroll', 'key', 'text', 'chord', 'drag'], program_ids: null,
  }));
  return { folder, observationPath, manifest, grantId, grantPath: join(grantFolder, `${grantId}.json`) };
}

test('click arguments reject unknown or malformed input', () => {
  assert.throws(() => clickArgs({ observation: 'x', label: 'y', center: [1, 2], command: 'calc' }), /Unknown/);
  assert.throws(() => clickArgs({ observation: 'x', label: 'y', center: [1, -1] }), /center/);
  assert.throws(() => clickArgs({ observation: 'x', label: '', center: [1, 2] }), /label/);
  assert.deepEqual(clickArgs({ observation: 'x', label: 'y', center: [1, 2], coordinate_space: 'image' }),
    { observation: 'x', label: 'y', center: [1, 2], coordinateSpace: 'image', expected: '' });
});

test('scroll arguments stay bounded and do not accept click fields', () => {
  assert.throws(() => scrollArgs({ observation: 'x', label: 'y', center: [1, 2], notches: 0 }), /notches/);
  assert.throws(() => scrollArgs({ observation: 'x', label: 'y', center: [1, 2], notches: 4 }), /notches/);
  assert.throws(() => scrollArgs({ observation: 'x', label: 'y', center: [1, 2], notches: -1, button: 'left' }), /Unknown/);
  assert.deepEqual(scrollArgs({ observation: 'x', label: 'y', center: [1, 2], notches: -2 }),
    { observation: 'x', label: 'y', center: [1, 2], coordinateSpace: 'attachment', notches: -2, expected: '' });
});

test('scroll tool builds one bounded request and does not claim task success', async () => {
  const fixtureValue = await fixture();
  let seen;
  try {
    const scroller = createScroller({}, { run: async request => {
      seen = request;
      return { ok: true, outcome: 'input_api_accepted', input_events_sent: 2,
        input_delivery_observed: false, task_success_verified: false };
    } });
    const result = await scroller({ observation: fixtureValue.observationPath, label: '编辑区',
      center: [200, 150], notches: -1, expected: 'content scrolls down' }, execution());
    assert.equal(seen.action.type, 'scroll');
    assert.equal(seen.action.axis, 'vertical');
    assert.equal(seen.action.notches, -1);
    assert.equal(seen.authorization_grant, fixtureValue.grantId);
    assert.equal(result.task_success_verified, false);
    assert.equal(result.scroll_notches, -1);
    assert.match(result.notice, /not receiver consumption or task success/);
  } finally {
    await rm(fixtureValue.grantPath, { force: true });
    await rm(fixtureValue.folder, { recursive: true, force: true });
  }
});

test('key tool forwards one navigation key and does not claim task success', async () => {
  const fixtureValue = await fixture();
  let seen;
  try {
    const keyer = createKeyer({}, { run: async request => {
      seen = request;
      return { ok: true, outcome: 'input_api_accepted', input_events_sent: 2,
        input_delivery_observed: false, task_success_verified: false };
    } });
    const result = await keyer({ observation: fixtureValue.observationPath, label: '编辑区',
      center: [200, 150], key: 'Left', expected: 'caret moves left' }, execution());
    assert.equal(seen.action.type, 'key');
    assert.equal(seen.action.key, 'Left');
    assert.equal(seen.authorization_grant, fixtureValue.grantId);
    assert.deepEqual(result.key, { key: 'Left' });
    assert.equal(result.task_success_verified, false);
  } finally {
    await rm(fixtureValue.grantPath, { force: true });
    await rm(fixtureValue.folder, { recursive: true, force: true });
  }
});

test('key arguments reject modifiers, text and unknown keys', () => {
  assert.throws(() => keyArgs({ observation: 'x', label: 'y', center: [1, 2], key: 'A' }), /navigation/);
  assert.throws(() => keyArgs({ observation: 'x', label: 'y', center: [1, 2], key: 'Enter' }), /navigation/);
  assert.throws(() => keyArgs({ observation: 'x', label: 'y', center: [1, 2], key: 'Left', text: 'x' }), /Unknown/);
  assert.deepEqual(keyArgs({ observation: 'x', label: 'y', center: [1, 2], key: 'Home' }),
    { observation: 'x', label: 'y', center: [1, 2], coordinateSpace: 'attachment', key: 'Home', expected: '' });
});

test('text arguments are short single-line and reject controls', () => {
  assert.throws(() => textArgs({ observation: 'x', label: 'y', center: [1, 2], text: '' }), /1\.\.16/);
  assert.throws(() => textArgs({ observation: 'x', label: 'y', center: [1, 2], text: 'x'.repeat(17) }), /1\.\.16/);
  assert.throws(() => textArgs({ observation: 'x', label: 'y', center: [1, 2], text: 'a\nb' }), /control/);
  assert.throws(() => textArgs({ observation: 'x', label: 'y', center: [1, 2], text: 'abc', clip: true }), /Unknown/);
  assert.deepEqual(textArgs({ observation: 'x', label: 'y', center: [1, 2], text: 'abc' }),
    { observation: 'x', label: 'y', center: [1, 2], coordinateSpace: 'attachment', text: 'abc', expected: '' });
});

test('text tool does not return the text body', async () => {
  const fixtureValue = await fixture();
  let seen;
  try {
    const texter = createTexter({}, { run: async request => {
      seen = request;
      return { ok: true, outcome: 'input_api_accepted', input_events_sent: 6,
        input_delivery_observed: false, task_success_verified: false, text: { utf16_units: 3 } };
    } });
    const result = await texter({ observation: fixtureValue.observationPath, label: '编辑区',
      center: [200, 150], text: 'abc' }, execution());
    assert.equal(seen.action.type, 'text');
    assert.equal(seen.action.text, 'abc');
    assert.equal(seen.authorization_grant, fixtureValue.grantId);
    assert.deepEqual(result.text_summary, { scalars: 3, utf16_units: 3 });
    assert.equal(JSON.stringify(result).includes('"abc"'), false);
    assert.equal(result.text_stored, false);
  } finally {
    await rm(fixtureValue.grantPath, { force: true });
    await rm(fixtureValue.folder, { recursive: true, force: true });
  }
});

test('combo arguments are limited to Ctrl+Left/Right', () => {
  for (const combo of ['Ctrl+Left', 'Ctrl+Right']) {
    assert.equal(comboArgs({ observation: 'x', label: 'y', center: [1, 2], combo }).combo, combo);
  }
  for (const combo of ['Ctrl+A', 'Alt+Left', 'Shift+Left', 'Ctrl+C']) {
    assert.throws(() => comboArgs({ observation: 'x', label: 'y', center: [1, 2], combo }), /Ctrl\+Left/);
  }
  assert.throws(() => comboArgs({ observation: 'x', label: 'y', center: [1, 2],
    combo: 'Ctrl+Left', text: 'x' }), /Unknown/);
});

test('combo tool forwards one fixed chord and does not claim success', async () => {
  const fixtureValue = await fixture();
  let seen;
  try {
    const chorder = createChorder({}, { run: async request => {
      seen = request;
      return { ok: true, outcome: 'input_api_accepted', input_events_sent: 4,
        input_delivery_observed: false, task_success_verified: false };
    } });
    const result = await chorder({ observation: fixtureValue.observationPath, label: '编辑区',
      center: [200, 150], combo: 'Ctrl+Left' }, execution());
    assert.equal(seen.action.type, 'chord');
    assert.deepEqual(seen.action.modifiers, ['ctrl']);
    assert.equal(seen.action.key, 'Left');
    assert.equal(seen.authorization_grant, fixtureValue.grantId);
    assert.equal(result.combo, 'Ctrl+Left');
    assert.equal(result.task_success_verified, false);
  } finally {
    await rm(fixtureValue.grantPath, { force: true });
    await rm(fixtureValue.folder, { recursive: true, force: true });
  }
});

test('drag arguments require two distant image points', () => {
  assert.equal(dragArgs({ observation: 'x', label: 'y', start: [1, 2], end: [20, 20] }).coordinateSpace,
    'attachment');
  assert.throws(() => dragArgs({ observation: 'x', label: 'y', start: [1, 2], end: [2, 3] }),
    /too close/);
  assert.throws(() => dragArgs({ observation: 'x', label: 'y', start: [1, 2], end: [20, 20], text: 'x' }),
    /Unknown/);
});

test('drag tool forwards one bounded drag and does not claim success', async () => {
  const fixtureValue = await fixture();
  let seen;
  try {
    const dragger = createDragger({}, { run: async request => {
      seen = request;
      return { ok: true, outcome: 'input_api_accepted', input_events_sent: 15,
        input_delivery_observed: false, task_success_verified: false };
    } });
    const result = await dragger({ observation: fixtureValue.observationPath, label: '页面',
      start: [200, 150], end: [260, 180], coordinate_space: 'image' }, execution());
    assert.equal(seen.action.type, 'drag');
    assert.deepEqual(seen.action.end, [260, 180]);
    assert.equal(seen.authorization_grant, fixtureValue.grantId);
    assert.deepEqual(result.drag_summary, { start: [200, 150], end: [260, 180] });
    assert.equal(result.task_success_verified, false);
  } finally {
    await rm(fixtureValue.grantPath, { force: true });
    await rm(fixtureValue.folder, { recursive: true, force: true });
  }
});

test('attachment pixels map to the original observation image', () => {
  const manifest = { image: { width: 800, height: 600 } };
  assert.deepEqual(imageCenter(manifest, { width: 400, height: 300 }, [200, 150], 'attachment'), [400, 300]);
  assert.deepEqual(imageCenter(manifest, null, [34, 51], 'image'), [34, 51]);
  assert.throws(() => imageCenter(manifest, { width: 400, height: 300 }, [400, 0], 'attachment'), /attached/);
  assert.throws(() => imageCenter(manifest, null, [0, 0], 'attachment'), /delivered model image/);
});

test('clicker builds the contract request and returns a non-success receipt', async () => {
  let seen;
  let seenSignal;
  let seenSession;
  const fixtureValue = await fixture();
  try {
    const clicker = createClicker({}, {
      run: async (request, options) => { seen = request; seenSignal = options?.signal; seenSession = options?.harnessSession;
        return { ok: true, outcome: 'input_delivered',
          after_observation: '', task_success_verified: false }; },
      policy: async () => ({ image_attachment_enabled: false }),
    });
    const exec = execution();
    const result = await clicker({ observation: fixtureValue.observationPath, label: '文件(F)',
      center: [200, 150], expected: 'menu opens' }, exec);
    assert.equal(seen.target.center[0], 400);
    assert.equal(seen.target.center[1], 300);
    assert.equal(seen.authorization_grant, fixtureValue.grantId);
    assert.equal(seenSignal, exec.signal);
    assert.equal(seenSession, 'action-test');
    assert.deepEqual(result.target_image_pixels, [400, 300]);
    assert.equal(result.task_success_verified, false);
    assert.equal(result.after_image_attached, undefined);
  } finally {
    await rm(fixtureValue.grantPath, { force: true });
    await rm(fixtureValue.folder, { recursive: true, force: true });
  }
});

test('clicker records a durable run around the executor call', async () => {
  const fixtureValue = await fixture();
  const calls = [];
  const runs = {
    start: async args => { calls.push(['start', args]); return { run_id: 'run-test' }; },
    end: async args => { calls.push(['end', args]); return { run_id: 'run-test', lifecycle: 'ended', ...args }; },
  };
  try {
    const clicker = createClicker({}, {
      runs,
      memory: {
        context: async () => ({ scope: { user: 'u', project: 'p' },
          memory_context: { request_id: 'request-1', consent_event_id: 'consent-1' } }),
        checkpoint: async (_session, runId) => {
          assert.equal(calls.at(-1)[0], 'end');
          assert.equal(runId, 'run-test');
          return { status: 'saved', memory_id: 'mem-auto' };
        },
      },
      run: async () => ({ ok: true, input_delivery_observed: true, outcome: 'input_delivered',
        task_success_verified: false }),
      policy: async () => ({ image_attachment_enabled: false }),
    });
    const result = await clicker({ observation: fixtureValue.observationPath, label: '文件(F)',
      center: [200, 150], expected: 'menu opens' }, execution());
    assert.deepEqual(calls.map(call => call[0]), ['start', 'end']);
    assert.equal(calls[0][1].task_id, 'desktop-click:obs-test');
    assert.equal(calls[1][1].input_delivery, 'sent');
    assert.equal(calls[1][1].termination_reason, 'completed');
    assert.equal(calls[1][1].verification.status, 'unknown');
    assert.equal(calls[1][1].executor_state, 'stopped');
    assert.deepEqual(calls[1][1].checkpoint_facts, [{ step: 1, input_delivery: 'sent', verification: 'unknown' }]);
    assert.equal(calls[0][1].request_id, 'request-1');
    assert.equal(result.run_record.checkpoint_write.status, 'saved');
    assert.equal(result.run_id, 'run-test');
    assert.equal(result.task_success_verified, false);
  } finally {
    await rm(fixtureValue.grantPath, { force: true });
    await rm(fixtureValue.folder, { recursive: true, force: true });
  }
});

test('checkpoint failure is reported without retrying a delivered click', async () => {
  const fixtureValue = await fixture();
  let executions = 0;
  let record;
  const runs = {
    start: async () => ({ run_id: 'run-test' }),
    end: args => (record = { ...args, lifecycle: 'ended' }),
    checkpointResult: ({ result }) => (record = { ...record, checkpoint_write: result }),
  };
  try {
    const clicker = createClicker({}, { runs,
      memory: { context: async () => ({ memory_context: { request_id: 'request-1' } }),
        checkpoint: async () => { throw Object.assign(new Error('synthetic'), { code: 'STORAGE_UNAVAILABLE' }); } },
      run: async () => { executions++; return { ok: true, input_delivered: true }; },
      policy: async () => ({ image_attachment_enabled: false }),
    });
    const result = await clicker({ observation: fixtureValue.observationPath, label: '文件(F)', center: [200, 150] }, execution());
    assert.equal(executions, 1);
    assert.equal(result.ok, true);
    assert.equal(result.run_record.termination_reason, 'completed');
    assert.equal(result.run_record.checkpoint_write.status, 'failed');
    assert.equal(result.run_record.checkpoint_write.error_code, 'STORAGE_UNAVAILABLE');
  } finally {
    await rm(fixtureValue.grantPath, { force: true });
    await rm(fixtureValue.folder, { recursive: true, force: true });
  }
});

test('clicker fails closed if the run ledger cannot start', async () => {
  const fixtureValue = await fixture();
  try {
    const clicker = createClicker({}, {
      runs: { start: async () => { throw new Error('ledger unavailable'); } },
      run: async () => assert.fail('executor must not run without a run record'),
    });
    await assert.rejects(clicker({ observation: fixtureValue.observationPath, label: '文件(F)',
      center: [200, 150], expected: 'menu opens' }, execution()), /ledger unavailable/);
  } finally {
    await rm(fixtureValue.grantPath, { force: true });
    await rm(fixtureValue.folder, { recursive: true, force: true });
  }
});

test('already-aborted executor call is rejected before launch', async () => {
  await assert.rejects(runExecutor({}, { signal: AbortSignal.abort() }), { code: 'EXECUTOR_CANCELLED' });
});

test('cancelled executor launch returns unknown without retry', async () => {
  const fixtureValue = await fixture();
  try {
    const clicker = createClicker({}, {
      run: async () => { const error = new Error('cancelled'); error.code = 'EXECUTOR_CANCELLED'; throw error; },
      policy: async () => ({ image_attachment_enabled: false }),
    });
    const result = await clicker({ observation: fixtureValue.observationPath, label: '文件(F)',
      center: [200, 150], expected: 'menu opens' }, execution());
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'cancelled_unknown');
    assert.equal(result.cancellation, 'unknown_after_launch');
    assert.equal(result.task_success_verified, false);
  } finally {
    await rm(fixtureValue.grantPath, { force: true });
    await rm(fixtureValue.folder, { recursive: true, force: true });
  }
});

test('clicker refuses a read-only observation before invoking the executor', async () => {
  const folder = await mkdtemp(join(root, 'results', 'vision', 'test-readonly-'));
  const observationPath = join(folder, 'observation.json');
  try {
    await writeFile(observationPath, JSON.stringify({ observation_id: 'obs', image: { width: 1, height: 1 },
      capture_bounds: { left: 0, top: 0, width: 1, height: 1 } }));
    const clicker = createClicker({}, { run: async () => assert.fail('must not run') });
    await assert.rejects(clicker({ observation: observationPath, label: 'x', center: [0, 0] }, execution()),
      /read-only/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('enabled policy attaches the post-action image and renderer includes it', async () => {
  const fixtureValue = await fixture();
  try {
    const afterFolder = await mkdtemp(join(root, 'results', 'vision', 'test-after-'));
    const afterPath = join(afterFolder, 'observation.json');
    await writeFile(join(afterFolder, 'screen.png'), 'after');
    await writeFile(afterPath, JSON.stringify({ observation_id: 'after', image: { path: join(afterFolder, 'screen.png'),
      width: 800, height: 600, sha256: SHA, resized: false }, capture_bounds: { left: 355, top: 63, width: 800, height: 600 } }));
    const attachment = { attachmentId: 'sha256:after', mediaType: 'image/png', bytes: 80, width: 800, height: 600 };
    const clicker = createClicker({}, {
      run: async () => ({ ok: true, outcome: 'input_delivered', after_observation: afterPath,
        task_success_verified: false }),
      policy: async () => ({ image_attachment_enabled: true }),
      route: async () => ({ provider: 'test', model: 'test' }),
      attach: async () => ({ model_image: { attachment } }),
    });
    const result = await clicker({ observation: fixtureValue.observationPath, label: '文件(F)',
      center: [200, 150], expected: 'menu opens' }, execution());
    assert.equal(result.after_image_attached, true);
    assert.deepEqual(result.after_model_image.attachment, attachment);
    const blocks = renderClick({}, result);
    assert.deepEqual(blocks.filter(block => block.type === 'image'), [{ type: 'image', attachment }]);
    assert.match(blocks[1].text, /Post-action screenshot/);
    await rm(afterFolder, { recursive: true, force: true });
  } finally {
    await rm(fixtureValue.grantPath, { force: true });
    await rm(fixtureValue.folder, { recursive: true, force: true });
  }
});

test('renderer explains when no post-action image is attached', () => {
  const blocks = renderClick({}, { after_observation_path: 'results/vision/x/observation.json',
    expected: 'menu opens', task_success_verified: false });
  assert.equal(blocks.some(block => block.type === 'image'), false);
  assert.match(blocks[1].text, /Image delivery is disabled/);
});
