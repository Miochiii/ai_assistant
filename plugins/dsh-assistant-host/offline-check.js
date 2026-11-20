/**
 * Offline resident-host smoke. No UI process, screenshot, model request,
 * network call or desktop input. Used by tests and /assistant-check.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { UiChannel } from './ui-channel.js';
import { ResidentHost, makeAssistantEvent } from './resident-host.js';

export async function runOfflineCheck({ baseDir, clock = () => new Date() } = {}) {
  const root = baseDir ?? join('runtime', 'assistant-host-check', `check-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const assistantSessionId = `instance-${randomUUID()}`;
  const channel = new UiChannel(root, { assistantSessionId, clock });
  const host = new ResidentHost({ channel, clock });
  const checks = [];
  function check(name, value, details = '') {
    checks.push({ name, passed: Boolean(value), details });
    if (!value) throw new Error(`check failed: ${name}${details ? ` (${details})` : ''}`);
  }

  try {
    host.initialize();
    check('startup defaults to standby', host.state.mode === 'standby');
    check('startup has no task', host.state.task === null);
    check('startup observation stopped', host.state.observation.status === 'stopped');

    let seq = 1;
    const chat = makeAssistantEvent({
      host, kind: 'chat_submit', clientSeq: seq++, payload: { text: '在吗？' },
    });
    channel.submitEvent(chat);
    await host.poll();
    await host.waitForIdle();
    const firstOutbox = channel.readOutbox();
    check('chat reply published', firstOutbox.length === 1, `messages=${firstOutbox.length}`);
    check('chat reply is offline and explicit', firstOutbox[0]?.text.includes('离线模式收到'));
    check('chat ack handled', channel.readAck(chat.event_id)?.status === 'handled');
    check('chat did not create a task', host.state.task === null);

    const taskA = makeAssistantEvent({
      host, kind: 'start_task', clientSeq: seq++,
      payload: { title: '任务 A', steps: ['打开文件菜单', '选择导出'] },
    });
    channel.submitEvent(taskA);
    await host.poll();
    check('task A active', host.state.task?.title === '任务 A');
    check('task A mode coach', host.state.mode === 'coach');
    check('task A epoch advanced', host.state.context_epoch >= 1);

    const chatWhileA = makeAssistantEvent({
      host, kind: 'chat_submit', clientSeq: seq++, payload: { text: '这一步在哪？' },
    });
    channel.submitEvent(chatWhileA);
    await host.poll();
    await host.waitForIdle();
    check('chat does not destroy task A', host.state.task?.title === '任务 A');

    const endA = makeAssistantEvent({
      host, kind: 'end_task', clientSeq: seq++,
      payload: { reason: 'user' },
    });
    channel.submitEvent(endA);
    await host.poll();
    check('task A ended', host.state.task === null);

    const taskB = makeAssistantEvent({
      host, kind: 'start_task', clientSeq: seq++,
      payload: { title: '任务 B', steps: ['打开插件'] },
    });
    channel.submitEvent(taskB);
    await host.poll();
    check('task B active after A', host.state.task?.title === '任务 B');

    const pause = makeAssistantEvent({
      host, kind: 'pause_observation', clientSeq: seq++, payload: {},
    });
    channel.submitEvent(pause);
    await host.poll();
    check('pause switches to standby', host.state.mode === 'standby');
    check('pause marks observation paused', host.state.observation.status === 'paused');

    const close = makeAssistantEvent({
      host, kind: 'close_assistant', clientSeq: seq++, payload: {},
    });
    channel.submitEvent(close);
    await host.poll();
    check('close marks assistant closed', host.state.assistant === 'closed');
    check('no active model request after close', host.state.model_request === null);
    check('host reports no pending work', host._pending.size === 0);

    const state = await readFile(join(root, 'state.json'), 'utf8').then(JSON.parse);
    check('final state persisted', state.assistant === 'closed');
    return {
      schema_version: 1,
      mode: 'offline',
      passed: true,
      root,
      checks,
      assistant_session_id: assistantSessionId,
      screenshots: 0,
      model_network_calls: 0,
      desktop_inputs: 0,
      checked_at: clock().toISOString(),
    };
  } finally {
    if (!host.closed) host.close();
    else channel.close();
  }
}
