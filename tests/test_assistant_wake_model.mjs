import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UiChannel } from '../plugins/dsh-assistant-host/ui-channel.js';
import { ResidentHost } from '../plugins/dsh-assistant-host/resident-host.js';
import { ObservationService } from '../plugins/dsh-assistant-host/observation-service.js';
import { SceneWakeScheduler } from '../plugins/dsh-assistant-host/scene-wake.js';
import {
  OfflineWakeModel,
  WakeModelAdapter,
} from '../plugins/dsh-assistant-host/wake-model-adapter.js';

function fixture({ model = new OfflineWakeModel(), allowUserWake = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'assistant-wake-model-'));
  const channel = new UiChannel(root, { assistantSessionId: 'instance-wake-model' });
  const host = new ResidentHost({ channel });
  host.initialize();
  const adapter = new WakeModelAdapter({
    model, host, allowUserWake,
    clock: () => new Date('2026-11-03T12:00:00.000Z'),
  });
  return { root, channel, host, adapter };
}

const frame = {
  frame_id: 'frame-1',
  captured_at: '2026-11-03T12:00:00.000Z',
  changed_score: 4,
  changed_ratio: 0.02,
  change_bbox: { left: 10, top: 20, width: 100, height: 80 },
  thumbnail_ref: 'runtime/thumbs/1.png',
  width: 2560,
  height: 1440,
};

test('wake model publishes a suggestion and does not advance the task', async () => {
  const { root, channel, host, adapter } = fixture();
  try {
    host.startTask({ title: '演示', steps: ['打开菜单', '选择导出'] });
    const result = await adapter.handle({ kind: 'frame', frame });
    assert.equal(result.ok, true);
    assert.equal(result.should_speak, true);
    assert.equal(host.state.task.step_index, 0);
    const messages = channel.readOutbox();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].kind, 'wake_suggestion');
    assert.match(messages[0].text, /当前步骤：打开菜单/);
    assert.match(messages[0].text, /100×80/);
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a silent model result publishes nothing', async () => {
  const model = { async complete() { return { should_speak: false, text: '' }; } };
  const { root, channel, host, adapter } = fixture({ model });
  try {
    const result = await adapter.handle({ kind: 'frame', frame });
    assert.equal(result.ok, true);
    assert.equal(result.should_speak, false);
    assert.equal(channel.readOutbox().length, 0);
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('user wake is ignored by default and can be enabled explicitly', async () => {
  const { root, host, adapter } = fixture();
  try {
    const ignored = await adapter.handle({ kind: 'user', text: '在吗' });
    assert.equal(ignored.ignored, 'user-wake-handled-by-chat');
    const root2 = mkdtempSync(join(tmpdir(), 'assistant-wake-user-'));
    const channel2 = new UiChannel(root2, { assistantSessionId: 'instance-wake-user' });
    const host2 = new ResidentHost({ channel: channel2 });
    host2.initialize();
    const adapter2 = new WakeModelAdapter({ host: host2, allowUserWake: true });
    try {
      const result = await adapter2.handle({ kind: 'user', text: '在吗' });
      assert.equal(result.ok, true);
      assert.match(channel2.readOutbox()[0].text, /收到：在吗/);
    } finally {
      host2.close();
      rmSync(root2, { recursive: true, force: true });
    }
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an action request is returned but never executed', async () => {
  const request = {
    action_request: { program_id: 'notepad-open-file-menu', version: 2 },
  };
  const model = { async complete() { return { should_speak: true, text: '可以点开菜单', ...request }; } };
  const { root, host, adapter } = fixture({ model });
  try {
    const result = await adapter.handle({ kind: 'frame', frame });
    assert.deepEqual(result.action_request, request.action_request);
    assert.equal(host.state.task, null);
    assert.equal(adapter.published, 1);
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('overlapping model turns are rejected while one is pending', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const model = {
    async complete() {
      calls += 1;
      await gate;
      return { should_speak: false, text: '' };
    },
  };
  const { root, host, adapter } = fixture({ model });
  try {
    const first = adapter.handle({ kind: 'frame', frame });
    await Promise.resolve();
    const second = await adapter.handle({ kind: 'frame', frame });
    assert.equal(second.reason, 'busy');
    release();
    await first;
    assert.equal(calls, 1);
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('scheduler wake feeds the model adapter end to end without advancing the task', async () => {
  const root = mkdtempSync(join(tmpdir(), 'assistant-wake-loop-'));
  const channel = new UiChannel(root, { assistantSessionId: 'instance-wake-loop' });
  const host = new ResidentHost({ channel });
  host.initialize();
  host.startTask({ title: '演示', steps: ['打开菜单'] });
  const scope = { kind: 'monitor', scope_id: 'scope-loop', geometry_revision: 'geo-loop' };
  const service = new ObservationService({ clock: () => new Date('2026-11-03T12:00:00.000Z') });
  service.start({ scope });
  service.pushFrame({
    frame_id: 'frame-loop',
    scope_id: scope.scope_id,
    geometry_revision: scope.geometry_revision,
    captured_at: '2026-11-03T12:00:00.000Z',
    changed_score: 5,
    changed_ratio: 0.03,
    change_bbox: { left: 0, top: 0, width: 40, height: 30 },
  });
  const adapter = new WakeModelAdapter({ host });
  const scheduler = new SceneWakeScheduler({
    observationService: service,
    onWake: payload => adapter.handle(payload),
    retryDelayMs: 0,
    now: () => Date.parse('2026-11-03T12:00:00.000Z'),
  });
  try {
    await scheduler.tick();
    assert.equal(channel.readOutbox().length, 1);
    assert.match(channel.readOutbox()[0].text, /当前步骤：打开菜单/);
    assert.equal(host.state.task.step_index, 0);
    assert.equal(host.state.task.status, 'waiting_user');
  } finally {
    scheduler.stop('test');
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
