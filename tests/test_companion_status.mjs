/**
 * 陪伴面板的状态机与契约测试（交接 03）。
 *
 * 这些用例只喂假模块：**它们证明接线和判定，不证明真实视频循环**。
 * 真实那条在 log 里单独记（重启 DSH、开视频、看面板翻成 running）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {createCompanionPanel} from '../plugins/dsh-assistant-host/companion-status.js';

const SETTINGS = {mode: 'video', captureSeconds: 2, lookSeconds: 30, speakSeconds: 30, backoff: true, proactive: true};

function loopFixture(initial = {}) {
  const state = {active: false, paused: false, session: 's1', segments: 0, spoken: 0, segment: null, reason: null, pos: null, confidence: 'none', transcript: {ready: 0, fed: 0, inflight: null, last: null}, speech: {}, ...initial};
  return {state, loopStatus: () => state};
}

function bridgeFixture({hello = null, sample = null, disabled = false} = {}) {
  return {
    readHello: async () => hello,
    readBridge: async () => sample,
    bridgeEnabled: () => !disabled,
  };
}

function panel(t, options = {}) {
  let now = 1000;
  const calls = {submit: [], stop: [], probe: 0, screen: []};
  const loop = options.loop ?? loopFixture();
  const settings = {...SETTINGS, ...(options.settings ?? {})};
  const screen = {snapshot: () => options.screenState ?? {state: 'stopped'}};
  const p = createCompanionPanel({
    store: {read: async () => settings},
    screen,
    screenControl: {
      start: async () => { calls.screen.push('start'); },
      pause: async () => { calls.screen.push('pause'); },
      resume: async () => { calls.screen.push('resume'); },
      stop: async () => { calls.screen.push('stop'); },
    },
    video: {
      available: () => options.available ?? true,
      submit: async kind => { calls.submit.push(kind); if (options.submitError) throw options.submitError; },
      // 真实的 stopWatchLoop 会把 active 置回 false —— 假模块也照这个来，
      // 否则"暂停"看起来永远还在跑。
      stop: async reason => { calls.stop.push(reason); loop.state.active = false; },
    },
    modules: async () => ({loop: options.noLoop ? null : loop, bridge: options.bridge ?? bridgeFixture()}),
    probe: async () => { calls.probe += 1; return options.service ?? false; },
    now: () => now,
  });
  t.after(() => p.dispose());
  return {panel: p, loop, calls, settings, advance: ms => { now += ms; }, at: () => now};
}

test('未启动：已保存视频、没有任何运行证据', async t => {
  const f = panel(t);
  const st = await f.panel.status();
  assert.equal(st.selectedMode, 'video');
  assert.equal(st.runningMode, null);
  assert.equal(st.phase, 'stopped');
  assert.equal(st.mismatch, false);
  assert.equal(st.bridge.service, 'down');
  assert.equal(st.bridge.extension, 'none');
  assert.equal(st.bridge.fresh, false);
  assert.equal(st.media.title, null);
  assert.equal(st.sources.loop, 'module');
  assert.equal(st.revision, 1);
});

test('屏幕在跑、已保存屏幕：running + 计数来自模块快照', async t => {
  const f = panel(t, {
    settings: {mode: 'screen'},
    screenState: {state: 'running', sessionId: 's1', samples: 7, calls: 3, spoken: 2, reason: ''},
  });
  const st = await f.panel.status();
  assert.equal(st.runningMode, 'screen');
  assert.equal(st.phase, 'running');
  assert.equal(st.screen.samples, 7);
  assert.equal(st.screen.calls, 3);
  assert.equal(st.mismatch, false);
});

test('已保存屏幕但视频循环在跑：mismatch 必须报出来', async t => {
  const loop = loopFixture({active: true, session: 's2', pos: 42, confidence: 'fresh'});
  const f = panel(t, {settings: {mode: 'screen'}, loop});
  const st = await f.panel.status();
  assert.equal(st.runningMode, 'video');
  assert.equal(st.phase, 'running');
  assert.equal(st.mismatch, true);
  assert.equal(st.sessionId, 's2');
});

test('启动视频：先 starting，循环真的 active 之后才 running，并推进 revision', async t => {
  const f = panel(t);
  f.calls.probe = 0;
  const started = await f.panel.control('start', {requestId: 'r1'});
  assert.deepEqual(f.calls.submit, ['start']);
  assert.equal(started.phase, 'starting');
  assert.equal(started.revision, 2);
  // 循环还没起来时**不能**乐观显示 running
  assert.equal((await f.panel.status()).phase, 'starting');
  f.loop.state.active = true;
  const running = await f.panel.status();
  assert.equal(running.phase, 'running');
  assert.equal(running.runningMode, 'video');
});

test('连点两下只执行一次；同一个 requestId 重放不重复提交', async t => {
  const f = panel(t);
  await f.panel.control('start', {requestId: 'same'});
  const replay = await f.panel.control('start', {requestId: 'same'});
  assert.equal(replay.replay, true);
  assert.deepEqual(f.calls.submit, ['start']);
});

test('已经在跑时再 start 被拒绝，并带回最新快照', async t => {
  const loop = loopFixture({active: true, session: 's1'});
  const f = panel(t, {loop});
  await assert.rejects(f.panel.control('start'), error => {
    assert.equal(error.code, 'already-running');
    assert.equal(error.status, 409);
    assert.equal(error.payload.phase, 'running');
    return true;
  });
});

test('插件未加载时视频启动给出明确错误，不静默回退屏幕', async t => {
  const f = panel(t, {available: false});
  await assert.rejects(f.panel.control('start'), error => {
    assert.equal(error.code, 'plugin-missing');
    assert.equal(f.calls.submit.length, 0);
    return true;
  });
});

test('启动中可以停止；停止之后 pendingStart 被清掉，不会一直显示启动中', async t => {
  const f = panel(t);
  await f.panel.control('start');
  assert.equal((await f.panel.status()).phase, 'starting');
  const stopped = await f.panel.control('stop');
  assert.deepEqual(f.calls.stop, ['panel-stop']);
  assert.equal(stopped.phase, 'stopped');
  assert.equal((await f.panel.status()).phase, 'stopped');
});

test('暂停后循环停表：面板仍显示 paused；继续时重新跟随播放位置', async t => {
  const loop = loopFixture({active: true});
  const f = panel(t, {loop});
  await f.panel.control('pause');
  assert.deepEqual(f.calls.stop, ['panel-pause']);
  assert.equal((await f.panel.status()).phase, 'paused');
  const resumed = await f.panel.control('resume');
  assert.deepEqual(f.calls.submit, ['resume']);
  assert.equal(resumed.phase, 'starting');
});

test('已保存屏幕但视频在跑：停止要停视频循环，不能只停屏幕', async t => {
  const loop = loopFixture({active: true});
  const f = panel(t, {settings: {mode: 'screen'}, loop});
  const stopped = await f.panel.control('stop');
  assert.deepEqual(f.calls.stop, ['panel-stop']);
  assert.deepEqual(f.calls.screen, [], '屏幕模块没在跑，不该去停它');
  assert.equal(stopped.phase, 'stopped');
});

test('没有在运行时暂停被拒绝', async t => {
  const f = panel(t);
  await assert.rejects(f.panel.control('pause'), error => error.code === 'not-running');
});

test('revision 对不上时拒绝执行，不产生副作用', async t => {
  const f = panel(t);
  await assert.rejects(f.panel.control('start', {expectedRevision: 99}), error => {
    assert.equal(error.code, 'revision-mismatch');
    assert.equal(error.status, 409);
    return true;
  });
  assert.equal(f.calls.submit.length, 0);
});

test('启动超时才报"没启动起来"，不谎报 running', async t => {
  const f = panel(t);
  await f.panel.control('start');
  f.advance(91_000);
  const st = await f.panel.status();
  assert.equal(st.phase, 'stopped');
  assert.equal(st.lastError.code, 'video-not-started');
});

test('位置桥三层分开报：扩展报过但位置过期，不等于"已连上"', async t => {
  const at = 1000;
  const f = panel(t, {
    service: true,
    bridge: bridgeFixture({hello: {at: at - 60_000, version: '1.0'}, sample: null}),
  });
  const st = await f.panel.status();
  assert.equal(st.bridge.service, 'up');
  assert.equal(st.bridge.extension, 'seen');
  assert.equal(st.bridge.fresh, false);
  assert.equal(st.media.confidence, 'unknown');
});

test('有新鲜位置时给出片名与秒数，且 confidence=fresh', async t => {
  const f = panel(t, {
    service: true,
    bridge: bridgeFixture({hello: {at: 999_000}, sample: {at: 950, pos: 12.5, dur: 600, title: '测试片', paused: false, url: 'https://example/x'}}),
  });
  const st = await f.panel.status();
  assert.equal(st.bridge.extension, 'live');
  assert.equal(st.bridge.fresh, true);
  assert.equal(st.media.title, '测试片');
  assert.equal(st.media.positionSeconds, 12.5);
  assert.equal(st.media.durationSeconds, 600);
  assert.equal(st.media.confidence, 'fresh');
});

test('GET 状态很便宜：2.5 秒一次轮询不会反复探端口', async t => {
  const f = panel(t, {service: true});
  for (let i = 0; i < 4; i += 1) { await f.panel.status(); f.advance(300); }
  assert.equal(f.calls.probe, 1, '1.2 秒内连问四次只该探一次端口');
  for (let i = 0; i < 5; i += 1) { await f.panel.status(); f.advance(2500); }
  assert.equal(f.calls.probe, 5, '每 2.5 秒一次 → 每次都在缓存过期后，探一遍就够');
});

test('读不到原插件模块时 phase=unknown，不谎报未运行', async t => {
  const f = panel(t, {noLoop: true});
  const st = await f.panel.status();
  assert.equal(st.phase, 'unknown');
  assert.equal(st.sources.loop, 'none');
  assert.equal(st.runningMode, null);
});

test('未知动作直接拒绝', async t => {
  const f = panel(t);
  assert.throws(() => f.panel.control('explode'), error => error.code === 'unknown-action');
});
