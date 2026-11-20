import assert from 'node:assert/strict';
import test from 'node:test';

import { PreactGate } from '../plugins/dsh-assistant-host/preact-gate.js';

const now = () => new Date('2026-11-03T12:00:00.000Z');
const frame = {
  frame_id: 'frame-1',
  captured_at: '2026-11-03T12:00:00.000Z',
};
const actionRequest = {
  program_id: 'notepad-open-file-menu',
  version: 2,
  hwnd: 1234,
};
const grant = {
  grant_id: 'grant-1',
  actions: ['replay'],
  windows: [{ hwnd: 1234 }],
};

test('proposal is not executed before authorization', async () => {
  let calls = 0;
  const gate = new PreactGate({
    replay: async () => { calls += 1; return { status: 'completed' }; },
    clock: now,
  });
  gate.propose({ actionRequest, frame });
  const result = await gate.execute();
  assert.equal(result.reason, 'authorization_required');
  assert.equal(calls, 0);
});

test('a matching grant permits exactly one replay and passed verification completes', async () => {
  let calls = 0;
  const gate = new PreactGate({
    replay: async () => { calls += 1; return { status: 'completed', receipt: 'r1' }; },
    clock: now,
  });
  gate.propose({ actionRequest, frame });
  assert.equal(gate.authorize({ grant }).authorized, true);
  const result = await gate.execute();
  assert.equal(result.ok, true);
  assert.equal(result.status, 'completed');
  assert.equal(calls, 1);
  assert.equal(gate.status().phase, 'completed');
  const second = await gate.execute();
  assert.equal(second.ok, false);
  assert.equal(calls, 1);
});

test('bad grant or stale evidence never reaches replay', async () => {
  let calls = 0;
  const gate = new PreactGate({
    replay: async () => { calls += 1; return { status: 'completed' }; },
    clock: now,
  });
  gate.propose({ actionRequest, frame });
  const bad = gate.authorize({ grant: { grant_id: 'g', actions: ['click'], windows: [{ hwnd: 1234 }] } });
  assert.equal(bad.authorized, false);
  assert.equal(calls, 0);

  const staleGate = new PreactGate({
    replay: async () => { calls += 1; return { status: 'completed' }; },
    clock: () => new Date('2026-11-03T12:00:10.000Z'),
  });
  assert.throws(() => staleGate.propose({ actionRequest, frame }), /stale/);
  assert.equal(calls, 0);
});

test('failed replay stops without retry or coordinate fallback', async () => {
  let calls = 0;
  const gate = new PreactGate({
    replay: async () => {
      calls += 1;
      return { status: 'failed', reason: 'TARGET_NOT_FOUND' };
    },
    clock: now,
  });
  gate.propose({ actionRequest, frame });
  gate.authorize({ grant });
  const result = await gate.execute();
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.equal(calls, 1);
  const again = await gate.execute();
  assert.equal(again.ok, false);
  assert.equal(calls, 1);
});

test('replan_required is preserved and unknown is explicit', async () => {
  const gate = new PreactGate({
    replay: async () => ({ status: 'replan_required', reason: 'WINDOW_CHANGED' }),
    clock: now,
  });
  gate.propose({ actionRequest, frame });
  gate.authorize({ grant });
  const result = await gate.execute();
  assert.equal(result.status, 'replan_required');
  assert.equal(gate.status().phase, 'replan_required');

  const unknownGate = new PreactGate({
    replay: async () => ({ status: 'unknown' }),
    clock: now,
  });
  unknownGate.propose({ actionRequest, frame });
  unknownGate.authorize({ grant });
  const unknown = await unknownGate.execute();
  assert.equal(unknown.status, 'unknown');
});
