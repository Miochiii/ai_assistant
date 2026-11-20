import assert from 'node:assert/strict';
import test from 'node:test';

import { ExplorationFlow } from '../plugins/dsh-assistant-host/exploration-flow.js';

const explorationGrant = {
  grant_id: 'explore-1',
  actions: ['explore'],
  windows: [{ hwnd: 1234 }],
};
const riskGrant = {
  grant_id: 'risk-1',
  actions: ['risk'],
  windows: [{ hwnd: 1234 }],
};
const window = { hwnd: 1234, title: 'Calculator' };
const evidence = { frame_id: 'frame-1', captured_at: '2026-11-03T12:00:00.000Z' };

function flow() {
  return new ExplorationFlow({
    goal: '打开计算器并计算 12×34',
    window,
    explorationGrant,
    clock: () => new Date('2026-11-03T12:00:00.000Z'),
  });
}

test('starting without an exploration grant is refused', () => {
  assert.throws(
    () => new ExplorationFlow({ goal: 'x', window, explorationGrant: null }),
    /exploration grant/,
  );
});

test('low-risk steps run under the exploration grant and are recorded as a sequence', async () => {
  const f = flow();
  const calls = [];
  const executor = async step => {
    calls.push(step.intent);
    return { status: 'passed', verification: { status: 'passed' } };
  };
  f.proposeStep({ intent: '点击开始菜单', risk: 'low', evidence });
  assert.equal((await f.executeStep({ executor })).status, 'passed');
  f.proposeStep({ intent: '打开计算器', risk: 'low', evidence });
  assert.equal((await f.executeStep({ executor })).status, 'passed');
  assert.equal(f.status().steps_verified, 2);
  assert.equal(f.finish().ok, true);
  let saved = null;
  const result = await f.record({
    recordProgram: async draft => {
      saved = draft;
      return { program_id: 'calculator-sum', version: 1 };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.program_id, 'calculator-sum');
  assert.equal(saved.steps.length, 2);
  assert.equal(saved.steps.every(step => step.verification.status === 'passed'), true);
  assert.deepEqual(calls, ['点击开始菜单', '打开计算器']);
  assert.equal(f.status().phase, 'recorded');
});

test('risky step is blocked until a separate risk grant is supplied', async () => {
  const f = flow();
  let calls = 0;
  const executor = async () => { calls += 1; return { status: 'passed' }; };
  f.proposeStep({ intent: '删除账号', risk: 'high', evidence });
  assert.equal(f.status().phase, 'awaiting_risk_authorization');
  const blocked = await f.executeStep({ executor });
  assert.equal(blocked.reason, 'authorization_required');
  assert.equal(calls, 0);

  assert.equal(f.authorizeRisk(riskGrant).authorized, true);
  const result = await f.executeStep({ executor });
  assert.equal(result.status, 'passed');
  assert.equal(calls, 1);
});

test('failed step is not appended and does not auto retry', async () => {
  const f = flow();
  let calls = 0;
  f.proposeStep({ intent: '点击错误目标', risk: 'low', evidence });
  const result = await f.executeStep({
    executor: async () => { calls += 1; return { status: 'failed', reason: 'TARGET_NOT_FOUND' }; },
  });
  assert.equal(result.ok, false);
  assert.equal(f.status().steps_verified, 0);
  assert.equal(f.status().phase, 'failed');
  const again = await f.executeStep({
    executor: async () => { calls += 1; return { status: 'passed' }; },
  });
  assert.equal(again.ok, false);
  assert.equal(calls, 1);
  assert.equal((await f.record({ recordProgram: async () => ({ program_id: 'x' }) })).ok, false);
});

test('record requires a completed, non-pending sequence', async () => {
  const f = flow();
  f.proposeStep({ intent: '第一步', risk: 'low', evidence });
  await f.executeStep({ executor: async () => ({ status: 'passed' }) });
  assert.equal((await f.record({ recordProgram: async () => ({ program_id: 'x' }) })).ok, false);
  assert.equal(f.finish().ok, true);
  assert.equal((await f.record({ recordProgram: async () => ({ program_id: 'x' }) })).ok, true);
});
