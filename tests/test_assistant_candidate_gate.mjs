import assert from 'node:assert/strict';
import test from 'node:test';

import { CandidateGate } from '../plugins/dsh-assistant-host/candidate-gate.js';

function candidateFrame(overrides = {}) {
  return {
    frame_id: 'f1',
    changed_score: 8,
    changed_ratio: 0.08,
    width: 200,
    height: 100,
    change_bbox: { width: 40, height: 30 },
    ...overrides,
  };
}

test('local gate skips low-change and small-region frames before the model', () => {
  let now = 1000;
  const gate = new CandidateGate({ minChangedScore: 3, minChangedRatio: 0.02, now: () => now });
  assert.equal(gate.shouldRequest(candidateFrame({ changed_score: 1, changed_ratio: 0.001 })).reason, 'low_change');
  assert.equal(gate.shouldRequest(candidateFrame({ change_bbox: { width: 2, height: 2 } })).reason, 'small_region');
  assert.equal(gate.shouldRequest(candidateFrame()).candidate, true);
});

test('local gate enforces cooldown and caps silent backoff without stopping', () => {
  let now = 1000;
  const gate = new CandidateGate({
    cooldownMs: 8000, maxSilent: 3, backoffFactor: 2, maxCooldownMs: 60000, now: () => now,
  });
  assert.equal(gate.shouldRequest(candidateFrame()).candidate, true);
  assert.equal(gate.shouldRequest(candidateFrame()).reason, 'cooldown');
  gate.recordDecision(false);
  assert.equal(gate.silentStreak, 1);
  assert.equal(gate.cooldownMs, 16000);
  now += 16000;
  assert.equal(gate.shouldRequest(candidateFrame()).candidate, true);
  gate.recordDecision(false);
  now += 32000;
  assert.equal(gate.shouldRequest(candidateFrame()).candidate, true);
  gate.recordDecision(false);
  assert.equal(gate.silentStreak, 3);
  assert.equal(gate.cooldownMs, 60000);
  now += 60000;
  assert.equal(gate.shouldRequest(candidateFrame()).candidate, true);
});

test('a strong scene change resets silent backoff and is marked new-scan', () => {
  let now = 0;
  const gate = new CandidateGate({ cooldownMs: 8000, maxCooldownMs: 60000, now: () => now });
  gate.recordDecision(false);
  gate.recordDecision(false);
  assert.equal(gate.silentStreak, 2);
  now = 10000;
  const result = gate.shouldRequest(candidateFrame({ changed_score: 80, changed_ratio: 0.4 }));
  assert.equal(result.candidate, true);
  assert.equal(result.new_scene, true);
  assert.equal(gate.silentStreak, 0);
  assert.equal(gate.cooldownMs, 8000);
});

test('a speaking decision resets the silence streak and cooldown', () => {
  let now = 0;
  const gate = new CandidateGate({ cooldownMs: 8000, maxSilent: 3, now: () => now });
  gate.recordDecision(false);
  assert.equal(gate.silentStreak, 1);
  gate.recordDecision(true);
  assert.equal(gate.silentStreak, 0);
  assert.equal(gate.cooldownMs, 8000);
  gate.recordDecision(true);
  assert.equal(gate.silentStreak, 0);
});
