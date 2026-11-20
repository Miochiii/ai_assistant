import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {OrbCompanion, installOrbCompanion, companionPixels} from '../plugins/dsh-assistant-host/orb-companion.js';
import {DEFAULTS, validateSettings, settingsStore} from '../plugins/dsh-assistant-host/companion-settings.js';

const root = fileURLToPath(new URL('../runtime/', import.meta.url));
const frame = (n = 0) => ({raw: Buffer.alloc(64 * 36 * 3, n), width: 64, height: 36});
const yes = text => JSON.stringify({speak: true, text, reason: 'fixture'});
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(root, 'companion-test-'));
  let now = 0, value = 0;
  const replies = [], notices = [], requests = [], images = [];
  const ctx = {get: () => ({saveImage: async args => {images.push(args); return {attachmentId: 'fixture', mediaType: 'image/png'};}})};
  const companion = new OrbCompanion({ctx, root: directory, autoSchedule: false,
    now: () => now, capture: async () => frame(value), reply: text => replies.push(text), notice: text => notices.push(text),
    stream: async (_ctx, args) => {requests.push(args); return yes('看到一个新场景');}, ...options});
  t.after(async () => {await companion.dispose(); await rm(directory, {recursive: true, force: true});});
  return {companion, ctx, directory, replies, notices, requests, images, set: (t, v = value) => {now = t; value = v;},
    tick: async () => {await companion.tick(); await companion.run?.modelTask;}};
}

test('upstream pipeline first view, static dedup, image bounds and automatic cadence', async t => {
  const f = await fixture(t), c = f.companion;
  await c.tick(); assert.equal(f.images.length, 0);
  await c.start('one'); await f.tick(); f.set(2000); await f.tick();
  assert.equal(c.run.calls, 1); assert.equal(f.replies.length, 1);
  assert.equal(f.images[0].data.subarray(1, 4).toString(), 'PNG');
  for (let time = 4000; time < 120000; time += 2000) {f.set(time); await f.tick();}
  assert.equal(c.run.calls, 1, 'static desktop never triggers periodic model requests');
  f.set(120000, 255); await f.tick(); f.set(122000); await f.tick();
  assert.equal(c.run.calls, 2);
  f.set(124000, 0); await f.tick(); f.set(126000); await f.tick();
  assert.equal(c.run.calls, 2, 'hard scene changes cannot bypass the minimum interval');
  // 陪伴每句现在被角色卡的 30 字上限兜住，输出预算随之降到 192
  // （30 个汉字 + JSON 外壳约 70 token，192 足够；撞上限时整条会被丢弃，所以不能给太紧）。
  assert.equal(f.requests[0].maxTokens, 192);
  assert.equal(f.requests[0].content[1].type, 'image');
});

test('silence backs off, direct user question gets fresh frame and bounded conversation context', async t => {
  let speak = false;
  const f = await fixture(t, {stream: async () => speak ? yes('回答当前提问') : JSON.stringify({speak: false})});
  const c = f.companion; await c.start('one'); await f.tick(); f.set(2000); await f.tick();
  assert.equal(f.replies.length, 0); assert.equal(c.run.cooldown, 60000);
  speak = true;
  for (let i = 0; i < 6; i++) {f.set(3000 + i); await c.ask(`问题 ${i}`); await c.run.modelTask;}
  assert.equal(c.run.calls, 7); assert.equal(c.run.history.length, 8);
  assert.equal(f.replies.length, 6);
});

test('stop cancels pending model and drops its late reply; restart isolates old request', async t => {
  let release, signal;
  const f = await fixture(t, {stream: async (_ctx, args) => {signal = args.signal; return new Promise(r => {release = r;});}});
  const c = f.companion; await c.start('old'); await c.ask('第一问');
  await new Promise(r => setImmediate(r));
  const oldTask = c.run.modelTask; await c.stop(); assert.equal(signal.aborted, true);
  await c.start('new'); release(yes('迟到回复')); await oldTask;
  assert.deepEqual(f.replies, []); assert.equal(c.run.sessionId, 'new'); assert.equal(c.run.calls, 0);
});

test('latest interjection wins and aborts the previous model response', async t => {
  const pending = [];
  const f = await fixture(t, {stream: async (_ctx, args) => new Promise(resolve => pending.push({resolve, args}))});
  const c = f.companion; await c.start('one'); await c.ask('旧问题'); await new Promise(r => setImmediate(r));
  const oldTask = c.run.modelTask;
  await c.ask('新问题'); await new Promise(r => setImmediate(r));
  assert.equal(pending[0].args.signal.aborted, true);
  pending[0].resolve(yes('旧回答')); await oldTask;
  pending[1].resolve(yes('新回答')); await c.run.modelTask;
  assert.deepEqual(f.replies, ['新回答']);
});

test('stop during capture prevents image submission and samples do not resume', async t => {
  let release, signal;
  const f = await fixture(t, {capture: async args => {signal = args.signal; return new Promise(r => {release = r;});}});
  const c = f.companion; await c.start('one'); const sampling = c.tick(); const stopping = c.stop();
  assert.equal(signal.aborted, true); release(frame()); await sampling; await stopping; await c.tick();
  assert.equal(c.run.samples, 0); assert.equal(f.images.length, 0);
  assert.deepEqual(await readdir(join(f.directory, 'runtime/companion')), []);
});

test('capture failure stops; two model failures stop without automatic endless retry', async t => {
  const f = await fixture(t, {stream: async () => {throw new Error('offline fixture');}});
  const c = f.companion; await c.start('one'); await c.ask('a'); await c.run.modelTask;
  assert.equal(c.active(), true); await c.ask('b'); await c.run.modelTask;
  assert.equal(c.active(), false); assert.equal(c.run.calls, 2);
  const g = await fixture(t, {capture: async () => {throw new Error('capture fixture');}});
  await g.companion.start('two'); await g.tick(); assert.equal(g.companion.active(), false);
});

test('letterbox keeps full portrait scene instead of cropping edges', () => {
  const raw = Buffer.alloc(10 * 20 * 3, 255);
  const result = companionPixels({raw, width: 10, height: 20});
  assert.equal(result.length, 800 * 450 * 3);
  assert.equal(result[0], 20); assert.equal(result[(200 * 800 + 400) * 3], 255);
});

test('real Orb prompt/interjection methods route chat locally only while companion active', async t => {
  const f = await fixture(t); let cleanup, submissions = 0, cloaks = 0;
  const source = await readFile(new URL('../dsh_orb_full_orig/dist/host/index.js', import.meta.url), 'utf8');
  const prompt = source.slice(source.indexOf('\tasync onPrompt(text, lassoId) {'), source.indexOf('\t/** Start one new turn on the current session.'));
  const interject = source.slice(source.indexOf('\tasync onInterject(text) {'), source.indexOf('\t/** Start the command waiting for the old turn'));
  const methods = new Function('randomUUID', `return {${prompt},${interject}}`)(randomUUID);
  const ctx = {...f.ctx, effect: fn => {cleanup = fn();}};
  const runtime = {...methods, ctx, sessionId: 'one', block() {},
    overlay: {withCapture: async (fn, signal) => {cloaks++; assert(signal instanceof AbortSignal); return fn();}},
    ensureSession: async () => 'one', agentRegistry: () => ({list: () => []}),
    preempt: async () => {submissions++;}, halt() {}, newSession: async () => {runtime.sessionId = 'two';}};
  // The old memory service is absent, as on the installed Evolve profile.
  ctx.get = key => key === 'attachments' ? f.ctx.get(key) : undefined;
  const c = installOrbCompanion(ctx, runtime, {root: f.directory, autoSchedule: false,
    capture: async () => frame(), stream: async () => yes('陪伴回答')});
  t.after(() => cleanup());
  await runtime.onPrompt('开始陪伴'); assert.equal(c.active(), true);
  await runtime.onInterject('你看到什么了');
  await new Promise(r => setImmediate(r)); await c.run.modelTask;
  assert.equal(submissions, 0); assert.equal(c.run.spoken, 1);
  assert.equal(cloaks, 1);
  await runtime.companionSettings.save({...DEFAULTS, captureSeconds: 3, lookSeconds: 20, speakSeconds: 45});
  assert.equal(c.run.state, 'paused');
  assert.equal((await runtime.companionSettings.read()).lookSeconds, 20);
  await runtime.onPrompt('暂停陪伴'); assert.equal(c.run.state, 'paused');
  await runtime.onPrompt('你还在吗'); assert.equal(submissions, 0);
  await runtime.onPrompt('继续陪伴'); assert.equal(c.active(), true);
  assert.equal(c.intervalMs, 3000); assert.equal(c.run.gap, 20000); assert.equal(c.speakGapMs, 45000);
  assert.equal(c.run.history.length, 2);
  await runtime.newSession(); assert.equal(c.active(), false);
  await runtime.onPrompt('打开 PyCharm'); assert.equal(submissions, 1);
});

test('an external operation pauses the automatic loop before another capture', async t => {
  let busy = false;
  const f = await fixture(t, {isBusy: () => busy});
  await f.companion.start('one'); busy = true; await f.tick();
  assert.equal(f.companion.active(), false); assert.equal(f.companion.run.samples, 0);
});

test('ordinary model text is delivered; broken JSON is skipped without stopping companion', async t => {
  let raw = '这个镜头转场挺快的，你平时也看这个系列吗？';
  const f = await fixture(t, {stream: async () => raw});
  await f.companion.start('one'); await f.companion.ask('一起看'); await f.companion.run.modelTask;
  assert.equal(f.replies[0], raw);
  raw = '{"speak":true,"text":';
  for (let i = 0; i < 3; i++) {await f.companion.ask('继续'); await f.companion.run.modelTask;}
  assert.equal(f.companion.active(), true); assert.equal(f.companion.run.formatSkips, 3);
  assert.equal(f.companion.run.failures, 0); assert.equal(f.replies.length, 1);
});

test('settings validate ranges and persist across store instances', async t => {
  const f = await fixture(t), path = join(f.directory, 'settings.json');
  const store = settingsStore(path);
  assert.deepEqual(await store.read(), DEFAULTS);
  for (const patch of [{mode: 'automatic'}, {mode: null}, {captureSeconds: 0}, {lookSeconds: 9}, {speakSeconds: 301}, {backoff: 'false'}, {proactive: null}]) {
    assert.throws(() => validateSettings({...DEFAULTS, ...patch}));
  }
  const next = {...DEFAULTS, lookSeconds: 15, speakSeconds: 60, proactive: false};
  await store.save(next); assert.deepEqual(await settingsStore(path).read(), next);
  const {mode, ...legacy} = next;
  assert.equal(validateSettings(legacy).mode, 'screen');
});

test('manual video selection routes native controls and releases screen interception', async t => {
  const f = await fixture(t); let cleanup, pluginLoaded = true;
  const source = await readFile(new URL('../dsh_orb_full_orig/dist/host/index.js', import.meta.url), 'utf8');
  const prompt = source.slice(source.indexOf('\tasync onPrompt(text, lassoId) {'), source.indexOf('\t/** Start one new turn on the current session.'));
  const interject = source.slice(source.indexOf('\tasync onInterject(text) {'), source.indexOf('\t/** Start the command waiting for the old turn'));
  const methods = new Function('randomUUID', `return {${prompt},${interject}}`)(randomUUID);
  const submissions = [], notices = [];
  const ctx = {...f.ctx, effect: fn => {cleanup = fn();}, get: key => key === 'tools'
    ? {get: () => pluginLoaded ? {} : undefined} : undefined};
  const runtime = {...methods, ctx, sessionId: 'one', block: (...args) => notices.push(args[2]),
    ensureSession: async () => 'one', agentRegistry: () => ({list: () => []}),
    preempt: async text => submissions.push(text)};
  const c = installOrbCompanion(ctx, runtime, {root: f.directory, autoSchedule: false, capture: async () => frame()});
  t.after(() => cleanup());
  await runtime.onPrompt('开始陪伴'); assert(c.active());
  await runtime.companionSettings.save({...DEFAULTS, mode: 'video'});
  assert.equal(c.run.state, 'stopped');
  assert.equal(runtime.observationWatch.handles('这一段是什么意思'), false);
  assert.equal((await runtime.companionSettings.read()).mode, 'video');
  await runtime.onPrompt('开始陪伴'); assert.match(submissions.at(-1), /watch_together/); assert(!c.active());
  await runtime.onInterject('陪伴状态'); assert.match(submissions.at(-1), /statusOnly: true/);
  await runtime.onInterject('停止陪伴'); assert.match(submissions.at(-1), /stopLoop: true/);
  await runtime.onPrompt('这一段是什么意思'); assert.equal(submissions.at(-1), '这一段是什么意思');
  const before = submissions.length;
  pluginLoaded = false; await runtime.onPrompt('开始陪伴');
  assert.equal(submissions.length, before); assert.match(notices.at(-1), /尚未加载/); assert(!c.active());
  runtime.turnRunning = true;
  await assert.rejects(runtime.companionSettings.save(DEFAULTS), /先停止/);
  assert.equal((await runtime.companionSettings.read()).mode, 'video');
  runtime.turnRunning = false;
  await runtime.companionSettings.save(DEFAULTS);
  await runtime.onPrompt('开始陪伴'); assert(c.active());
  assert.equal(submissions.length, before);
});

test('companion panel exposes real status, controls the same screen loop, and cleans up', async t => {
  const f = await fixture(t); let cleanup;
  const notices = [], submissions = [];
  const ctx = {...f.ctx, effect: fn => {cleanup = fn();},
    get: key => key === 'tools' ? {get: () => ({watch_together: {}})} : undefined};
  const runtime = {ctx, sessionId: 'one', block: (...args) => notices.push(args[2]),
    ensureSession: async () => 'one', agentRegistry: () => ({list: () => []}),
    preempt: async text => {submissions.push(text);}, voice: {haltSpeech() {}}};
  const c = installOrbCompanion(ctx, runtime, {root: f.directory, autoSchedule: false, capture: async () => frame()});
  t.after(() => cleanup());
  await runtime.companionSettings.save(DEFAULTS);

  const idle = await runtime.companionStatus();
  assert.equal(idle.selectedMode, 'screen');
  assert.equal(idle.runningMode, null);
  assert.equal(idle.phase, 'stopped');
  assert.equal(typeof idle.revision, 'number');
  assert.equal((await runtime.companionControl({action: 'stop'})).noop, true);

  await runtime.companionControl({action: 'start'});
  assert.equal(c.active(), true, '面板的启动必须真的启动同一个屏幕陪伴');
  const running = await runtime.companionStatus();
  assert.equal(running.runningMode, 'screen');
  assert.equal(running.phase, 'running');
  assert.equal(typeof running.revision, 'number');

  const stopped = await runtime.companionControl({action: 'stop'});
  assert.equal(stopped.phase, 'stopped');
  assert.equal(c.active(), false);
  assert.equal(submissions.length, 0, '屏幕模块的面板控制不该发模型请求');

  await cleanup();
  assert.equal(runtime.companionStatus, undefined);
  assert.equal(runtime.companionControl, undefined);
});

test('companion suppresses the observation frame while watching, and restores it after', async t => {
  const f = await fixture(t); let cleanup;
  const frames = [];
  const guard = {setObservationFrame: async (bounds) => { frames.push(bounds); }};
  const ctx = {...f.ctx, effect: fn => {cleanup = fn();},
    get: key => key === 'tools' ? {get: () => ({watch_together: {}})}
      : key === 'computerUseOverlayGuard' ? guard : undefined};
  const runtime = {ctx, sessionId: 'one', block() {}, ensureSession: async () => 'one',
    agentRegistry: () => ({list: () => []}), preempt: async () => {}, voice: {haltSpeech() {}}};
  installOrbCompanion(ctx, runtime, {root: f.directory, autoSchedule: false, capture: async () => frame()});
  t.after(() => cleanup());
  const bounds = {x: 0, y: 0, width: 800, height: 600};

  await guard.setObservationFrame(bounds);
  assert.deepEqual(frames.at(-1), bounds, '没在陪看时，观察框照常画');

  await runtime.companionSettings.save(DEFAULTS);
  await runtime.companionControl({action: 'start'});
  assert.equal(frames.at(-1), null, '陪看一开始就把已经挂着的框清掉');
  await guard.setObservationFrame(bounds);
  assert.equal(frames.at(-1), null, '陪看期间列屏幕不再画框（否则一轮阻塞回合结束前它不会消失）');

  await runtime.companionControl({action: 'stop'});
  await guard.setObservationFrame(bounds);
  assert.deepEqual(frames.at(-1), bounds, '停掉陪看后观察框恢复');

  await cleanup();
  await guard.setObservationFrame(bounds);
  assert.deepEqual(frames.at(-1), bounds, '插件卸载后不该继续压着别人的装饰');
});

test('陪伴回复按角色卡的上限截断（默认 30 字，按整句收尾）', async t => {
  const long = '这是一句会很长很长的陪伴回复，'.repeat(5) + '最后一句应当被保留到这里。';
  const f = await fixture(t, {stream: async () => yes(long)});
  await f.companion.start('one'); await f.tick(); f.set(2000); await f.tick();
  assert.equal(f.replies.length, 1);
  assert.ok(f.replies[0].length <= 30, `实际 ${f.replies[0].length} 字：${f.replies[0]}`);
  assert.ok(!f.replies[0].includes('最后一句应当被保留到这里'), '超长部分要被截掉');
});

test('passive mode suppresses automatic requests and still answers direct questions', async t => {
  const f = await fixture(t), c = f.companion; c.proactive = false;
  await c.start('one'); await f.tick(); f.set(2000); await f.tick();
  assert.equal(c.run.calls, 0);
  await c.ask('现在是什么画面'); await c.run.modelTask;
  assert.equal(c.run.calls, 1);
});

test('speech interval also gates automatic paid calls; direct questions bypass it', async t => {
  const f = await fixture(t), c = f.companion; c.speakGapMs = 120000;
  await c.start('one'); await f.tick(); f.set(2000); await f.tick();
  f.set(40000, 255); await f.tick(); f.set(42000); await f.tick();
  assert.equal(c.run.calls, 1);
  await c.ask('换画面了吗'); await c.run.modelTask; assert.equal(c.run.calls, 2);
});
