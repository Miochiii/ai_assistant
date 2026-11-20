import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PanelChatModel } from '../plugins/dsh-assistant-host/panel-model.js';
import { ResidentHost, makeAssistantEvent } from '../plugins/dsh-assistant-host/resident-host.js';
import { UiChannel } from '../plugins/dsh-assistant-host/ui-channel.js';
import { createMemoryHost } from '../plugins/dsh-desktop-observe/memory.js';
import { callMemory } from '../plugins/dsh-desktop-observe/memory-client.js';

test('explicit panel memory across sessions, revision, withdrawal and idempotent delivery', async () => {
  const directory = join(process.cwd(), 'runtime', 'memory-tests');
  await mkdir(directory, { recursive: true });
  const temp = await mkdtemp(join(directory, 'panel-memory-'));
  const oldDb = process.env.DSH_MEMORY_DB;
  process.env.DSH_MEMORY_DB = join(temp, 'memory.sqlite3');
  try {
    const memory = createMemoryHost();
    function panel(id, cwd = process.cwd()) {
      return new PanelChatModel({ ctx: {}, sessionId: id, session: { id, header: { cwd } }, memory });
    }
    const first = panel('first'), second = panel('second');
    const command = { event_id: 'event-1', text: '记住，以后教我一次只说一步' };
    const lookup = { text: '查记忆：教我' };
    for (let i = 0; i < 2; i++) assert.equal((await first.complete(command)).text, '已记住。');
    assert.equal((await second.complete(lookup)).text, '以后教我一次只说一步');
    assert.equal((await panel('other', temp).complete(lookup)).text, '没有找到相关记忆。');
    const query = () => callMemory({ root: process.cwd(), ...memory.scope(second.session), op: 'recall',
      args: { route: 'search', query: '教我' } });
    const { items } = await query();
    assert.equal(items.length, 1);
    const [item] = items;
    assert.equal(item.sources[0].origin, 'user');
    assert.equal(item.sources[0].channel, 'assistant-panel');
    assert.equal(item.sources[0].content, command.text);
    assert.equal(item.sources[0].session_id, 'first');
    const admin = rawInput => memory.command({ agent: { session: second.session }, commandId: randomUUID(), rawInput });
    const revision = { memory_id: item.memory_id, kind: item.kind, key: item.key, content: '教我时先给概览' };
    assert.equal((await admin('revise ' + JSON.stringify(revision))).kind, 'success');
    assert.equal((await second.complete(lookup)).text, revision.content);
    assert.equal((await admin('revoke ' + (await query()).items[0].memory_id)).kind, 'success');
    assert.match((await first.complete(command)).text, /REVISION_CONFLICT/);
    assert.equal((await second.complete(lookup)).text, '没有找到相关记忆。');
    assert.deepEqual(second.history, []);
    assert.equal(first.calls + second.calls, 0);

    const bodies = [];
    let reply = '回答';
    second.ctx.llm = { async *stream(request) {
      bodies.push(JSON.stringify(request));
      yield { type: 'text-delta', index: 0, text: reply };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } };
    const set = (id, text) => first.complete({ event_id: id, text });
    const ask = text => second.complete({ text });
    await set('save-only', '记住，以后教我一次只说一步');
    await ask('教我怎么用记事本');
    assert.doesNotMatch(bodies.at(-1), /一次只说一步/);
    await set('enable', '指导时使用：一次只说一步');
    await set('enable', '指导时使用：一次只说一步');
    assert.equal((await panel('fresh').complete({ text: '查看指导偏好' })).text, '指导时使用：一次只说一步');
    assert.equal((await panel('elsewhere', temp).complete({ text: '查看指导偏好' })).text, '指导偏好未启用。');
    reply = 'OLD_GUIDANCE_ECHO 一次只说一步';
    await ask('教我操作计算器');
    assert.match(bodies.at(-1), /一次只说一步/);
    reply = '下一条';
    await ask('下一步');
    assert.match(bodies.at(-1), /OLD_GUIDANCE_ECHO/);
    await set('change', '指导时使用：先给概览');
    await ask('继续');
    assert.match(bodies.at(-1), /先给概览/);
    assert.doesNotMatch(bodies.at(-1), /一次只说一步|OLD_GUIDANCE_ECHO/);
    assert.match((await set('enable', '指导时使用：一次只说一步')).text, /REVISION_CONFLICT/);
    await ask('聊聊天');
    assert.doesNotMatch(bodies.at(-1), /一次只说一步|先给概览|OLD_GUIDANCE_ECHO/);
    reply = 'OVERVIEW_ECHO';
    await ask('教我打开文件');
    await set('disable', '停用指导偏好');
    await ask('下一步');
    assert.doesNotMatch(bodies.at(-1), /先给概览|OVERVIEW_ECHO/);
    await set('reenable', '指导时使用：先给概览');
    await ask('教我保存文件');
    const pref = await memory.guidancePreference(first.session);
    assert.equal((await admin('revoke ' + pref.version)).kind, 'success');
    await ask('继续');
    assert.doesNotMatch(bodies.at(-1), /先给概览|OVERVIEW_ECHO/);
    const generic = await admin('revise ' + JSON.stringify({ kind: 'preference', key: 'panel.guidance.style',
      memory_id: pref.version, content: '一次只说一步' }));
    assert.equal(generic.kind, 'success');
    assert.equal(await memory.guidancePreference(first.session), null);

    // Exercise the actual file-channel entry, including task and epoch forwarding.
    const channel = new UiChannel(join(temp, 'ui'), { assistantSessionId: 'ui-integration' });
    const host = new ResidentHost({ channel, model: second });
    let sequence = 0;
    async function submit(text) {
      const event = makeAssistantEvent({ host, kind: 'chat_submit', payload: { text }, clientSeq: ++sequence });
      channel.submitEvent(event);
      await host.poll();
      await host.waitForIdle();
      assert.equal(channel.readAck(event.event_id).status, 'handled');
      return event;
    }
    try {
      host.initialize();
      const before = second.calls;
      await submit('指导时使用：一次只说一步');
      assert.equal(second.calls, before);
      assert.ok(channel.readOutbox().some(item => item.text === '以后指导时使用：一次只说一步'));
      host.startTask({ title: '更改字体', steps: ['打开格式菜单'] });
      await submit('下一步');
      assert.match(bodies.at(-1), /一次只说一步/);
      assert.match(bodies.at(-1), /打开格式菜单/);
      await submit('停用指导偏好');
      await submit('继续');
      assert.doesNotMatch(bodies.at(-1), /一次只说一步/);
      host.endTask();
      const count = bodies.length;
      await submit('聊聊天');
      assert.equal(bodies.length, count + 1);
      assert.doesNotMatch(bodies.at(-1), /打开格式菜单|一次只说一步/);
    } finally {
      host.close();
    }
  } finally {
    if (oldDb === undefined) delete process.env.DSH_MEMORY_DB;
    else process.env.DSH_MEMORY_DB = oldDb;
    await rm(temp, { recursive: true, force: true });
  }
});
