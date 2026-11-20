import assert from 'node:assert/strict';
import test from 'node:test';

import { ModelWatch } from '../plugins/dsh-assistant-host/model-watch.js';

test('watch wires observation runner to scene wake and model check, then stops cleanly', async () => {
  const calls = [];
  let wake = null;
  const service = {
    start(input) { calls.push(['service.start', input.scope.scope_id]); },
    pushFrame(frame) { calls.push(['frame', frame.frame_id]); },
    fail(reason) { calls.push(['fail', reason]); },
    stop() { calls.push(['service.stop']); },
    status() { return { status: 'running' }; },
  };
  const runner = {
    start({ onFrame }) {
      calls.push(['runner.start']);
      onFrame({ frame_id: 'f1' });
    },
    stop() { calls.push(['runner.stop']); },
  };
  const check = {
    last: null,
    pending: null,
    start() { calls.push(['check.start']); },
    stop() { calls.push(['check.stop']); },
    async request({ frame }) {
      calls.push(['check.request', frame.frame_id]);
      return { ok: true, queued: true };
    },
  };
  const scheduler = {
    start() { calls.push(['scheduler.start']); },
    stop() { calls.push(['scheduler.stop']); },
    state() { return { started: true }; },
  };
  const watch = new ModelWatch({
    ctx: { on: () => () => {} },
    sessionId: 's1',
    makeObservation: () => service,
    makeRunner: () => runner,
    makeCheck: () => check,
    makeScheduler: ({ onWake }) => { wake = onWake; return scheduler; },
  });
  await watch.start();
  assert.deepEqual(calls.filter(item => item[0] === 'service.start'), [['service.start', 'model-watch-monitor-1']]);
  assert.equal(calls.some(item => item[0] === 'runner.start'), true);
  assert.equal(calls.some(item => item[0] === 'frame' && item[1] === 'f1'), true);
  assert.equal(calls.some(item => item[0] === 'scheduler.start'), true);
  await wake({ kind: 'frame', frame: {
    frame_id: 'f2', changed_score: 6, changed_ratio: 0.08, width: 200, height: 100,
    change_bbox: { width: 40, height: 40 },
  } });
  assert.equal(calls.some(item => item[0] === 'check.request' && item[1] === 'f2'), true);
  watch.stop();
  assert.equal(calls.some(item => item[0] === 'scheduler.stop'), true);
  assert.equal(calls.some(item => item[0] === 'runner.stop'), true);
  assert.equal(calls.some(item => item[0] === 'check.stop'), true);
});

test('watch pauses model calls at the budget without stopping observation', async () => {
  const calls = [];
  let wake = null;
  const gate = {
    shouldRequest() { return { candidate: true, reason: 'candidate', new_scene: false }; },
    recordDecision() {},
    status() { return { accepted: 1 }; },
  };
  const service = {
    start() {}, pushFrame() {}, fail() {}, stop() { calls.push('service.stop'); },
    status() { return {}; },
  };
  const runner = { start() {}, stop() { calls.push('runner.stop'); } };
  const check = {
    start() {}, stop() { calls.push('check.stop'); },
    async request() { calls.push('check.request'); return { ok: true, queued: true }; },
  };
  const scheduler = {
    start() {}, stop() { calls.push('scheduler.stop'); }, state() { return {}; },
  };
  const watch = new ModelWatch({
    ctx: { on: () => () => {} },
    sessionId: 's1',
    gate,
    maxModelCalls: 1,
    makeObservation: () => service,
    makeRunner: () => runner,
    makeCheck: () => check,
    makeScheduler: ({ onWake }) => { wake = onWake; return scheduler; },
  });
  await watch.start();
  await wake({ kind: 'frame', frame: { frame_id: 'f1' } });
  const second = await wake({ kind: 'frame', frame: { frame_id: 'f2' } });
  assert.equal(second.ok, true);
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'model_budget_paused');
  assert.equal(calls.filter(item => item === 'check.request').length, 1);
  assert.equal(calls.includes('scheduler.stop'), false);
  assert.equal(calls.includes('check.stop'), false);
  assert.equal(watch.status().budget_paused, true);
  watch.stop();
});

