import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UiChannel } from '../plugins/dsh-assistant-host/ui-channel.js';
import {
  ResidentHost,
  makeAssistantEvent,
} from '../plugins/dsh-assistant-host/resident-host.js';
import { runOfflineCheck } from '../plugins/dsh-assistant-host/offline-check.js';

const SESSION = 'instance-lifecycle';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'assistant-lifecycle-'));
}

function makeHost(root, { model } = {}) {
  const channel = new UiChannel(root, { assistantSessionId: SESSION });
  return new ResidentHost({ channel, ...(model ? { model } : {}) });
}

function submit(host, kind, payload = {}, seq) {
  const event = makeAssistantEvent({
    host, kind, payload, clientSeq: seq,
  });
  host.channel.submitEvent(event);
  return event;
}

test('two sequential chat messages each get an ack and a reply', async () => {
  const root = tempRoot();
  const host = makeHost(root);
  try {
    host.initialize();
    const first = submit(host, 'chat_submit', { text: 'first' }, 1);
    await host.poll();
    await host.waitForIdle();
    const second = submit(host, 'chat_submit', { text: 'second' }, 2);
    await host.poll();
    await host.waitForIdle();
    assert.equal(host.channel.readAck(first.event_id)?.status, 'handled');
    assert.equal(host.channel.readAck(second.event_id)?.status, 'handled');
    assert.equal(host.channel.readOutbox().length, 2);
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

class DeferredModel {
  constructor() {
    this.calls = 0;
    this.pending = [];
  }

  complete(request) {
    this.calls += 1;
    return new Promise(resolve => {
      this.pending.push({ request, resolve });
    });
  }

  abort() {}

  resolveAll(text = 'late reply') {
    for (const item of this.pending.splice(0)) item.resolve({ text });
  }
}

test('startup is ready in standby with no task', async () => {
  const root = tempRoot();
  const host = makeHost(root);
  try {
    host.initialize();
    assert.equal(host.state.assistant, 'ready');
    assert.equal(host.state.mode, 'standby');
    assert.equal(host.state.task, null);
    assert.equal(host.state.observation.status, 'stopped');
    assert.equal(host.state.state_revision, 0);
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('chat is accepted, handled and replies without creating a task', async () => {
  const root = tempRoot();
  const host = makeHost(root);
  try {
    host.initialize();
    const event = submit(host, 'chat_submit', { text: 'hello' }, 1);
    await host.poll();
    await host.waitForIdle();
    assert.equal(host.channel.readAck(event.event_id)?.status, 'handled');
    assert.equal(host.state.task, null);
    const messages = host.channel.readOutbox();
    assert.equal(messages.length, 1);
    assert.match(messages[0].text, /离线模式收到：hello/);
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('task A, chat, end, task B preserve the assistant and reject A late reply', async () => {
  const root = tempRoot();
  const model = new DeferredModel();
  const host = makeHost(root, { model });
  try {
    host.initialize();
    submit(host, 'start_task', { title: '任务 A', steps: ['打开菜单', '选择导出'] }, 1);
    await host.poll();
    assert.equal(host.state.task.title, '任务 A');
    assert.equal(host.state.mode, 'coach');
    const epochA = host.state.context_epoch;

    submit(host, 'chat_submit', { text: 'A 的提问' }, 2);
    await host.poll();
    assert.equal(model.calls, 1);
    assert.equal(host.state.model_request.status, 'running');

    submit(host, 'end_task', { reason: 'switch' }, 3);
    await host.poll();
    assert.equal(host.state.task, null);

    submit(host, 'start_task', { title: '任务 B', steps: ['打开插件'] }, 4);
    await host.poll();
    const epochB = host.state.context_epoch;
    assert.ok(epochB > epochA);
    assert.equal(host.state.task.title, '任务 B');

    model.resolveAll('A 的迟到回复');
    await host.waitForIdle();
    const messages = host.channel.readOutbox();
    assert.equal(messages.some(message => message.text === 'A 的迟到回复'), false);
    assert.equal(host.state.task.title, '任务 B');
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('pause cancels a pending request and switches to standby', async () => {
  const root = tempRoot();
  const model = new DeferredModel();
  const host = makeHost(root, { model });
  try {
    host.initialize();
    submit(host, 'start_task', { title: '任务 P', steps: ['一步'] }, 1);
    await host.poll();
    submit(host, 'chat_submit', { text: '回答我' }, 2);
    await host.poll();
    assert.equal(host.state.model_request.status, 'running');
    submit(host, 'pause_observation', {}, 3);
    await host.poll();
    assert.equal(host.state.observation.status, 'paused');
    assert.equal(host.state.mode, 'standby');
    assert.equal(host.state.model_request, null);
    model.resolveAll('不应显示的迟到回复');
    await host.waitForIdle();
    assert.equal(host.channel.readOutbox().some(message => message.text === '不应显示的迟到回复'), false);
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('duplicate event ID is processed once and old epoch is rejected', async () => {
  const root = tempRoot();
  const host = makeHost(root);
  try {
    host.initialize();
    const event = submit(host, 'chat_submit', { text: 'once' }, 1);
    host.channel.submitEvent(event);
    await host.poll();
    await host.waitForIdle();
    await host.poll();
    assert.equal(host.channel.readOutbox().length, 1);

    const stale = makeAssistantEvent({
      host, kind: 'check_step', clientSeq: 2, contextEpoch: 0, payload: {},
    });
    host.channel.submitEvent(stale);
    await host.poll();
    assert.equal(host.channel.readAck(stale.event_id)?.status, 'rejected');
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('close is idempotent and releases the instance lock', async () => {
  const root = tempRoot();
  const host = makeHost(root);
  try {
    host.initialize();
    submit(host, 'close_assistant', {}, 1);
    await host.poll();
    assert.equal(host.state.assistant, 'closed');
    assert.equal(host.state.model_request, null);
    host.close();
    assert.equal(host.state.assistant, 'closed');
    assert.equal(host._pending.size, 0);
    const secondRoot = tempRoot();
    const second = makeHost(secondRoot);
    second.initialize();
    second.close();
    rmSync(secondRoot, { recursive: true, force: true });
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('offline check covers A → chat → B and emits no capture/model/input', async () => {
  const root = tempRoot();
  try {
    const report = await runOfflineCheck({ baseDir: root });
    assert.equal(report.passed, true);
    assert.equal(report.screenshots, 0);
    assert.equal(report.model_network_calls, 0);
    assert.equal(report.desktop_inputs, 0);
    assert.ok(report.checks.length >= 10);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
