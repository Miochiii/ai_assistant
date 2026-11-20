import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {OrbWatch, installOrbWatch} from '../plugins/dsh-assistant-host/orb-watch.js';

const tempRoot = fileURLToPath(new URL('../runtime/', import.meta.url));
const frame = (value = 0, left = 0) => ({raw: Buffer.alloc(64 * 36 * 3, value),
  png: Buffer.from('synthetic image fixture'), width: 64, height: 36,
  bounds: {left, top: 0, width: 64, height: 36}, captured_at: new Date().toISOString()});
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tempRoot, 'watch-test-'));
  const watch = new OrbWatch({root, capture: async () => frame(),
    startDelayMs: 60000, intervalMs: 60000, ...options});
  t.after(async () => {await watch.dispose(); await rm(root, {recursive: true, force: true});});
  return watch;
}

test('idle has no capture; commands exact; start is idempotent; unchanged images discarded', async t => {
  let calls = 0;
  const watch = await fixture(t, {capture: async () => {calls++; return frame();}});
  assert.equal(watch.handles('开始观察'), true);
  assert.equal(watch.handles('请解释“开始观察”'), false);
  await watch.tick(); assert.equal(calls, 0);
  await watch.start('one'); const id = watch.run.id;
  await watch.start('one'); assert.equal(watch.run.id, id);
  await watch.tick(); await watch.tick();
  assert.equal(watch.run.frames.length, 1); assert.equal(watch.run.samples, 2);
  await watch.stop(); await watch.tick(); assert.equal(calls, 2);
  const saved = JSON.parse(await readFile(join(watch.run.directory, 'manifest.json')));
  assert.equal(saved.status, 'stopped'); assert.equal(saved.model_calls, 0);
  assert.equal(saved.semantic_analysis, 'not_run'); assert.equal(saved.memory_written, false);
});

test('changes and geometry create new frames; frame cap stops automatically', async t => {
  const frames = [frame(0), frame(255), frame(255, 2)];
  const watch = await fixture(t, {capture: async () => frames.shift(), maxFrames: 3});
  await watch.start('one'); await watch.tick(); await watch.tick(); await watch.tick();
  assert.equal(watch.active(), false); assert.equal(watch.run.frames.length, 3);
  assert.equal(watch.run.reason, '已达保留帧上限');
});

test('storage cap and capture errors stop without pretending a frame was saved', async t => {
  const watch = await fixture(t, {maxBytes: 1});
  await watch.start('one'); await watch.tick();
  assert.equal(watch.run.frames.length, 0); assert.equal(watch.active(), false);
  const broken = await fixture(t, {capture: async () => {throw new Error('fixture failure');}});
  await broken.start('two'); await broken.tick();
  assert.equal(broken.active(), false); assert.match(broken.run.reason, /失败/);
});

test('stop aborts in-flight capture, waits for drainage and rejects late output; tick is single-flight', async t => {
  let release, signal, calls = 0;
  const watch = await fixture(t, {capture: async args => {
    calls++; signal = args.signal; return new Promise(resolve => {release = resolve;});
  }});
  await watch.start('one'); const ticking = watch.tick(); await watch.tick();
  assert.equal(calls, 1);
  const stopping = watch.stop(); assert.equal(signal.aborted, true);
  release(frame()); await ticking; await stopping;
  assert.equal(watch.run.frames.length, 0);
  assert.deepEqual(await readdir(watch.run.directory), ['manifest.json']);
  await watch.start('two'); assert.equal(watch.active(), true);
});

test('duration deadline ends watch even while no timer sample ran', async t => {
  const watch = await fixture(t, {maxDurationMs: 20});
  await watch.start('one');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(watch.active(), false); assert.equal(watch.run.samples, 0);
});

test('host controls stay local; new task, session switch, halt and disposal stop capture', async t => {
  const root = await mkdtemp(join(tempRoot, 'watch-host-test-'));
  let cleanup, sessionSwitches = 0, halted = 0;
  const blocks = [];
  const ctx = {get: () => ({get: () => ({status: 'idle'})}), effect: fn => {cleanup = fn();}};
  const runtime = {sessionId: 'one', turnRunning: false,
    ensureSession: async () => runtime.sessionId, agentRegistry: () => ({list: () => []}),
    block: (...args) => blocks.push(args), newSession: async () => {sessionSwitches++; runtime.sessionId = 'two';},
    openSession: async id => {runtime.sessionId = id;}, halt: () => {halted++;}, stopTurn: async () => {}};
  const watch = installOrbWatch(ctx, runtime, {root, capture: async () => frame(), startDelayMs: 60000});
  t.after(async () => {await cleanup(); await rm(root, {recursive: true, force: true});});
  const api = runtime.observationWatch;
  runtime.turnRunning = true;
  assert.match(await api.control('开始观察'), /先结束任务/); assert.equal(watch.run, null);
  runtime.turnRunning = false;
  assert.match(await api.control('开始观察', 'lasso'), /纯文本/);
  await api.control('开始观察'); await api.beforePrompt(); assert.equal(watch.active(), false);
  await api.control('开始观察'); await runtime.newSession();
  assert.equal(sessionSwitches, 1); assert.equal(watch.active(), false);
  await api.control('开始观察'); runtime.halt();
  assert.equal(halted, 1); assert.equal(watch.active(), false);
  await api.control('停止观察');
  assert.ok(blocks.length > 0);
});

test('actual Orb prompt and interjection entry intercept controls without model submission', async () => {
  const source = await readFile(new URL('../dsh_orb_full_orig/dist/host/index.js', import.meta.url), 'utf8');
  const prompt = source.slice(source.indexOf('\tasync onPrompt(text, lassoId) {'),
    source.indexOf('\t/** Start one new turn on the current session.'));
  const interject = source.slice(source.indexOf('\tasync onInterject(text) {'),
    source.indexOf('\t/** Start the command waiting for the old turn'));
  const methods = new Function('randomUUID', `return {${prompt},${interject}}`)(randomUUID);
  let submitted = 0, stopped = 0, controls = 0;
  const runtime = {...methods, ctx: {get: () => undefined}, block() {},
    preempt: async () => {submitted++;}, observationWatch: {
      handles: text => text === '开始观察' || text === '停止观察',
      control: async () => {controls++; return 'local fixture reply';},
      beforePrompt: async () => {stopped++;},
    }};
  await runtime.onPrompt('开始观察'); await runtime.onInterject('停止观察');
  assert.equal(controls, 2); assert.equal(submitted, 0); assert.equal(stopped, 0);
  await runtime.onPrompt('打开 PyCharm');
  assert.equal(stopped, 1); assert.equal(submitted, 1);
});
