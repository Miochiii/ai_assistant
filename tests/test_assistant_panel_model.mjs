import assert from 'node:assert/strict';
import test from 'node:test';
import { PanelChatModel, inferGuidanceTarget } from '../plugins/dsh-assistant-host/panel-model.js';
import { PanelSession } from '../plugins/dsh-assistant-host/panel-session.js';

function fixture() {
  const requests = [], handoffs = [];
  const session = { id: 'main', header: { cwd: process.cwd() } };
  const ctx = {
    llm: { async *stream(req) {
      requests.push(req);
      yield { type: 'text-delta', index: 0, text: '已回答' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } },
    sessionController: { async resolveAgent(id) {
      assert.equal(id, session.id);
      return { agent: { followup: message => handoffs.push(message) } };
    } },
  };
  return { ctx, session, requests, handoffs };
}

test('text-only guidance retains clarification and cannot invent a visual target', async () => {
  assert.equal(inferGuidanceTarget('教我点击“新会话”'), '新会话');
  assert.equal(inferGuidanceTarget('教我打开文件菜单'), '文件');
  const { ctx, session } = fixture();
  const bodies = [];
  ctx.llm.stream = async function* (request) {
    bodies.push(JSON.stringify(request));
    yield { type: 'text-delta', index: 0, text: '屏幕上能看到新会话按钮吗？请先告诉我你当前在哪个界面。' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
  const panel = new PanelChatModel({ ctx, session, sessionId: session.id });
  const reply = await panel.complete({ text: '教我点击“新会话”' });
  assert.equal(reply.highlightTarget, null);
  assert.match(reply.text, /请先告诉我/);
  assert.doesNotMatch(bodies.at(-1), /用户已明确目标：新会话|HIGHLIGHT:新会话/);
});

test('legacy guidance marker is stripped but cannot authorize a highlight', async () => {
  const { ctx, session } = fixture();
  ctx.llm.stream = async function* () {
    yield { type: 'text-delta', index: 0, text: '点击左上角的“文件”。\n[[HIGHLIGHT:文件]]' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
  const panel = new PanelChatModel({ ctx, session, sessionId: session.id });
  const reply = await panel.complete({ text: '教我打开文件菜单' });
  assert.equal(reply.text, '点击左上角的“文件”。');
  assert.equal(reply.highlightTarget, null);
  assert.doesNotMatch(JSON.stringify(panel.history), /HIGHLIGHT/);
});

test('bounded panel context, no cross-session transcript, explicit handoff sends only task', async () => {
  const { ctx, session, requests, handoffs } = fixture();
  const panel = new PanelChatModel({ ctx, session, sessionId: session.id });
  panel.noteObservation('最近一次说出口的观察');
  for (let i = 0; i < 9; i++) await panel.complete({ text: '问' + i });
  assert.equal(panel.history.length, 8);
  assert.equal(requests.at(-1).messages.length, 9);
  assert.match(JSON.stringify(requests.at(-1).messages), /最近一次说出口/);
  assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /问0/);
  assert.equal(handoffs.length, 0);
  await panel.complete({ text: '交给主会话：打开测试文件', event_id: 'ui-event' });
  assert.deepEqual(handoffs[0].content, [{ type: 'text', text: '打开测试文件' }]);
  assert.equal(requests.length, 9);
  await panel.complete({ text: '长'.repeat(3000) });
  assert.ok(Buffer.byteLength(JSON.stringify(panel.history)) <= 8192);
  panel.reset();
  await panel.complete({ text: '重新打开' });
  assert.deepEqual(requests.at(-1).messages[0].content, [{ type: 'text', text: '重新打开' }]);
  assert.notEqual(new PanelSession({ sessionId: 'A' }).root, new PanelSession({ sessionId: 'B' }).root);
});

test('failure cannot add partial reply or fall back to the parent', async () => {
  const { ctx, handoffs } = fixture();
  ctx.llm.stream = async function* () { yield { type: 'text-delta', index: 0, text: '半句话' }; };
  const model = new PanelChatModel({ ctx, sessionId: 'main' });
  await assert.rejects(model.complete({ text: '你好' }), /完整文本/);
  assert.deepEqual(model.history, []);
  assert.deepEqual(handoffs, []);
});

test('only guidance reads the preference; losing the memory service discards affected history', async () => {
  const { ctx, session, requests } = fixture();
  let reads = 0;
  const memory = { async guidancePreference() {
    if (++reads > 1) throw Error('offline');
    return { style: '先给概览', version: 'v1' };
  } };
  const panel = new PanelChatModel({ ctx, sessionId: session.id, session, memory });
  const task = { task_id: 'task-a', context_epoch: 1, coachTask: { title: '设置字体', step: '打开格式菜单' } };
  await panel.complete({ ...task, text: '聊聊天' });
  assert.equal(reads, 0);
  const guidedReply = await panel.complete({ ...task, text: '下一步呢' });
  assert.deepEqual(guidedReply.guidancePreference, { style: '先给概览', version: 'v1' });
  assert.match(JSON.stringify(requests.at(-1)), /先给概览/);
  assert.match(JSON.stringify(requests.at(-1)), /打开格式菜单/);
  assert.equal(requests.at(-1).messages.length, 1);
  const neutralReply = await panel.complete({ ...task, text: '继续' });
  assert.equal(neutralReply.guidancePreference, null);
  assert.doesNotMatch(JSON.stringify(requests.at(-1)), /先给概览|已回答/);
  assert.equal(reads, 2);
  await panel.complete({ context_epoch: 2, text: '继续' });
  assert.equal(reads, 2);
  assert.doesNotMatch(JSON.stringify(requests.at(-1)), /打开格式菜单/);
});
