import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UiChannel } from '../plugins/dsh-assistant-host/ui-channel.js';
import { ResidentHost, makeAssistantEvent } from '../plugins/dsh-assistant-host/resident-host.js';
import { ObservationService } from '../plugins/dsh-assistant-host/observation-service.js';

function fixture({ verifier, withFrame = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'assistant-step-loop-'));
  const scope = { kind: 'monitor', scope_id: 'scope-steps', geometry_revision: 'geo-steps' };
  const service = new ObservationService({ maxFrames: 4, maxAgeMs: 15000 });
  if (withFrame) {
    service.start({ scope });
    service.pushFrame({
      frame_id: 'frame-1',
      scope_id: scope.scope_id,
      geometry_revision: scope.geometry_revision,
      captured_at: new Date().toISOString(),
      changed_score: 0,
      width: 64,
      height: 48,
    });
  }
  const channel = new UiChannel(root, { assistantSessionId: 'instance-steps' });
  const host = new ResidentHost({
    channel,
    observationService: service,
    stepVerifier: verifier ?? undefined,
    defaultObservationScope: scope,
  });
  return { root, channel, host, service, scope };
}

function event(host, kind, payload = {}, seq = 1) {
  return makeAssistantEvent({ host, kind, payload, clientSeq: seq });
}

async function submit(host, channel, kind, payload = {}, seq = 1) {
  const e = event(host, kind, payload, seq);
  channel.submitEvent(e);
  await host.poll();
  return e;
}

test('passed verification advances one step and completes at the end', async () => {
  const calls = [];
  const verifier = {
    async verify(input) {
      calls.push(input);
      return { status: 'passed', evidence: { frame_id: input.frame.frame_id } };
    },
  };
  const { root, channel, host } = fixture({ verifier });
  try {
    host.initialize();
    await submit(host, channel, 'start_task', { title: '两步任务', steps: ['第一步', '第二步'] });
    await submit(host, channel, 'check_step', {}, 2);
    assert.equal(host.state.task.step_index, 1);
    assert.equal(host.state.task.status, 'waiting_user');
    assert.equal(host.state.bubble.text, '第二步');
    await submit(host, channel, 'check_step', {}, 3);
    assert.equal(host.state.task.step_index, 2);
    assert.equal(host.state.task.status, 'complete');
    assert.equal(calls.length, 2);
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed verification keeps the current step and does not auto retry', async () => {
  let calls = 0;
  const verifier = {
    async verify() { calls += 1; return { status: 'failed', reason: 'no change' }; },
  };
  const { root, channel, host } = fixture({ verifier });
  try {
    host.initialize();
    await submit(host, channel, 'start_task', { title: '任务', steps: ['一步'] });
    await submit(host, channel, 'check_step', {}, 2);
    assert.equal(host.state.task.step_index, 0);
    assert.equal(host.state.task.status, 'waiting_user');
    assert.match(host.state.bubble.text, /未通过/);
    assert.equal(calls, 1);
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('unknown or missing frame verification does not advance', async () => {
  const verifier = { async verify() { return { status: 'unknown' }; } };
  const missing = fixture({ verifier, withFrame: false });
  try {
    missing.host.initialize();
    await submit(missing.host, missing.channel, 'start_task', { title: '任务', steps: ['一步'] });
    await submit(missing.host, missing.channel, 'check_step', {}, 2);
    assert.equal(missing.host.state.task.step_index, 0);
    assert.match(missing.host.state.bubble.text, /没有新鲜画面/);
  } finally {
    missing.host.close();
    rmSync(missing.root, { recursive: true, force: true });
  }
});

test('verifier can capture a fresh frame when no observation service is injected', async () => {
  const root = mkdtempSync(join(tmpdir(), 'assistant-step-capture-'));
  const channel = new UiChannel(root, { assistantSessionId: 'instance-capture-step' });
  let captured = 0;
  const host = new ResidentHost({
    channel,
    stepVerifier: {
      async captureFrame() {
        captured += 1;
        return { frame_id: 'captured-1', thumbnail_ref: 'ignored.png' };
      },
      async verify({ frame }) {
        assert.equal(frame.frame_id, 'captured-1');
        return { status: 'passed' };
      },
    },
  });
  try {
    host.initialize();
    await submit(host, channel, 'start_task', { title: '一对一', steps: ['打开文件菜单'] });
    await submit(host, channel, 'check_step', {}, 2);
    assert.equal(captured, 1);
    assert.equal(host.state.task.status, 'complete');
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('without a verifier check_step keeps the legacy checking state', async () => {
  const { root, channel, host } = fixture();
  try {
    host.initialize();
    await submit(host, channel, 'start_task', { title: '任务', steps: ['一步'] });
    await submit(host, channel, 'check_step', {}, 2);
    assert.equal(host.state.task.status, 'checking');
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Host starts/stops the scene scheduler and forwards user interjections', async () => {
  const root = mkdtempSync(join(tmpdir(), 'assistant-step-scheduler-'));
  const channel = new UiChannel(root, { assistantSessionId: 'instance-scheduler-host' });
  const events = [];
  const scheduler = {
    start() { events.push('start'); },
    stop(reason) { events.push(`stop:${reason}`); },
    noteUser(text) { events.push(`user:${text}`); },
  };
  const host = new ResidentHost({ channel, sceneWakeScheduler: scheduler });
  try {
    host.initialize();
    await submit(host, channel, 'resume_observation', {}, 1);
    assert.ok(events.includes('start'));
    await submit(host, channel, 'chat_submit', { text: '先解释一下' }, 2);
    assert.ok(events.includes('user:先解释一下'));
    await submit(host, channel, 'pause_observation', {}, 3);
    assert.ok(events.some(value => value === 'stop:pause'));
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
