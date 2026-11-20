import assert from 'node:assert/strict';
import test from 'node:test';

import { SceneWakeScheduler } from '../plugins/dsh-assistant-host/scene-wake.js';

function fixture({ windowOpen = true, onWake = null, config = {} } = {}) {
  let now = 1_000_000;
  let frameId = 'f1';
  let active = true;
  const calls = [];
  const stops = [];
  const service = {
    latest: () => (active
      ? { status: 'found', frame: { frame_id: frameId, captured_at: new Date(now).toISOString() } }
      : { status: 'not_found', reason: 'no_frame' }),
  };
  const scheduler = new SceneWakeScheduler({
    observationService: service,
    now: () => now,
    windowOpen: () => windowOpen,
    onWake: onWake ?? (async payload => { calls.push(payload); return { ok: true }; }),
    onStop: reason => stops.push(reason),
    retryDelayMs: 0,
    ...config,
  });
  return {
    scheduler, calls, stops, service,
    advance: ms => { now += ms; },
    setFrame: id => { frameId = id; },
    setActive: value => { active = value; },
  };
}

test('wakes once per new frame, respects the 8s gap and user priority', async () => {
  const { scheduler, calls, advance, setFrame } = fixture();
  await scheduler.tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'frame');
  assert.equal(calls[0].frame.frame_id, 'f1');

  await scheduler.tick();
  assert.equal(calls.length, 1, 'same frame must not wake again');

  advance(7999);
  setFrame('f2');
  await scheduler.tick();
  assert.equal(calls.length, 1, 'frame must wait for the 8s gap');

  advance(1);
  await scheduler.tick();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].frame.frame_id, 'f2');

  scheduler.noteUser('stop and explain');
  advance(2999);
  await scheduler.tick();
  assert.equal(calls.length, 2, 'user wait uses 3s cooldown');
  advance(1);
  await scheduler.tick();
  assert.equal(calls.length, 3);
  assert.equal(calls[2].kind, 'user');
  assert.equal(calls[2].text, 'stop and explain');
});

test('does not overlap wakes while onWake is pending', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const { scheduler, setFrame, advance } = fixture({
    onWake: async () => { calls += 1; await gate; return { ok: true }; },
  });
  const first = scheduler.tick();
  advance(9000);
  setFrame('f2');
  const second = scheduler.tick();
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  advance(9000);
  await scheduler.tick();
  assert.equal(calls, 2);
});

test('stops after two wake failures and does not mark the frame consumed', async () => {
  let calls = 0;
  const { scheduler, stops } = fixture({
    onWake: async () => { calls += 1; return { ok: false, reason: 'offline' }; },
    config: { maxWakeFailures: 2 },
  });
  await scheduler.tick();
  assert.equal(calls, 2);
  assert.equal(scheduler.state().stopped, false);
  await scheduler.tick();
  assert.equal(calls, 4);
  assert.equal(scheduler.state().stopped, true);
  assert.ok(stops.includes('wake-failed'));
  assert.equal(scheduler.state().last_frame_id, null);
});

test('stops when the companion window is closed and the user is idle', async () => {
  const { scheduler, stops, advance } = fixture({ windowOpen: false });
  advance(3 * 60 * 1000 + 1);
  await scheduler.tick();
  assert.equal(scheduler.state().stopped, true);
  assert.ok(stops.includes('idle'));
});

test('no new frame means no wake and no model turn', async () => {
  const { scheduler, calls, setActive } = fixture();
  setActive(false);
  await scheduler.tick();
  assert.equal(calls.length, 0);
});
