import assert from 'node:assert/strict';
import test from 'node:test';

import { MssObservationRunner } from '../plugins/dsh-assistant-host/mss-observation-runner.js';

class FakeAdapter {
  constructor() {
    this.calls = 0;
    this.fail = false;
    this.delay = 0;
  }

  async capture({ scope, frameId }) {
    this.calls += 1;
    if (this.delay) await new Promise(resolve => setTimeout(resolve, this.delay));
    if (this.fail) throw new Error('synthetic capture failure');
    return {
      frame_id: frameId,
      scope_id: scope.scope_id,
      geometry_revision: scope.geometry_revision,
      captured_at: new Date().toISOString(),
      changed_score: 0,
      width: 64,
      height: 64,
      source: 'fake',
    };
  }
}

const scope = {
  kind: 'monitor',
  scope_id: 'scope-runner',
  geometry_revision: 'geo-runner',
};

test('low-rate runner captures immediately and repeatedly, then pauses cleanly', async () => {
  const adapter = new FakeAdapter();
  const frames = [];
  const runner = new MssObservationRunner({ adapter, intervalMs: 250 });
  try {
    runner.start({ scope, onFrame: frame => frames.push(frame) });
    await new Promise(resolve => setTimeout(resolve, 320));
    assert.ok(frames.length >= 2);
    assert.equal(runner.status().status, 'running');
    runner.pause('user');
    const afterPause = frames.length;
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(frames.length, afterPause);
    assert.equal(runner.status().status, 'paused');
  } finally {
    runner.stop('test');
  }
});

test('runner does not overlap a slow capture and stops timers', async () => {
  const adapter = new FakeAdapter();
  adapter.delay = 120;
  const frames = [];
  const runner = new MssObservationRunner({ adapter, intervalMs: 250 });
  runner.start({ scope, onFrame: frame => frames.push(frame) });
  await new Promise(resolve => setTimeout(resolve, 40));
  runner.stop('test');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(adapter.calls, 1);
  assert.equal(frames.length, 0);
  assert.equal(runner.status().status, 'stopped');
});

test('runner reports capture errors without throwing', async () => {
  const adapter = new FakeAdapter();
  adapter.fail = true;
  const errors = [];
  const runner = new MssObservationRunner({ adapter, intervalMs: 250 });
  try {
    runner.start({ scope, onError: error => errors.push(error.message) });
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /synthetic capture failure/);
    assert.equal(runner.status().errors, 1);
  } finally {
    runner.stop('test');
  }
});
