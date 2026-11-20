import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DshSessionModel,
  SessionEventCollector,
  extractAssistantText,
} from '../plugins/dsh-assistant-host/dsh-session-model.js';

function fixture({ replyText = '这是模型回复', emitReply = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'assistant-dsh-model-'));
  const thumbnail = join(root, 'thumb.png');
  writeFileSync(thumbnail, Buffer.from('png bytes'));
  const handlers = new Set();
  let idleResolve;
  const idle = new Promise(resolve => { idleResolve = resolve; });
  const messages = [];
  const saved = [];
  const agent = {
    followup(message) {
      messages.push(message);
      if (emitReply) {
        queueMicrotask(() => {
          for (const handler of handlers) {
            handler({
              type: 'assistant/message',
              data: { message: { content: [{ type: 'text', text: replyText }] } },
            }, { header: { id: 'session-1' } });
          }
          idleResolve();
        });
      } else {
        queueMicrotask(() => idleResolve());
      }
    },
    whenIdle: () => idle,
  };
  const sessionController = {
    async resolveAgent() { return { agent }; },
  };
  const attachments = {
    async saveImage(input) { saved.push(input); return { attachmentId: 'img-1' }; },
  };
  const events = {
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
  const model = new DshSessionModel({
    sessionController, attachments, sessionId: 'session-1', events, eventGraceMs: 0,
  });
  return { root, thumbnail, model, messages, saved, events };
}

test('extracts assistant text from the committed session event shape', () => {
  assert.equal(extractAssistantText({
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'hello' }] } },
  }), 'hello');
  assert.equal(extractAssistantText({ type: 'turn/end' }), null);
  assert.equal(extractAssistantText({ type: 'assistant/message', data: { message: { content: [] } } }), null);
});

test('DSH model saves the frame image, wakes the session and returns the assistant reply', async () => {
  const { root, thumbnail, model, messages, saved } = fixture();
  try {
    const result = await model.complete({
      kind: 'frame',
      task: { title: '任务', step_index: 0, steps: ['第一步'] },
      step: { index: 0, text: '第一步' },
      frame: {
        frame_id: 'frame-1', changed_score: 3, changed_ratio: 0.02,
        change_bbox: { left: 1, top: 2, width: 30, height: 20 },
        thumbnail_ref: thumbnail,
      },
    });
    assert.equal(result.should_speak, true);
    assert.equal(result.text, '这是模型回复');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].mediaType, 'image/png');
    assert.equal(messages.length, 1);
    const content = messages[0].content;
    assert.equal(content[0].type, 'text');
    assert.match(content[0].text, /当前步骤 1\/1/);
    assert.equal(content[1].type, 'image');
    assert.equal(content[1].attachment.attachmentId, 'img-1');
    assert.equal(messages[0].source.kind, 'assistant-host');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DSH model can wake without an image and reports no assistant text', async () => {
  const { root, model, messages } = fixture({ emitReply: false });
  try {
    const result = await model.complete({ kind: 'frame', frame: { frame_id: 'f' } });
    assert.equal(result.should_speak, false);
    assert.equal(result.error, 'no_assistant_message');
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content.length, 1);
    assert.equal(messages[0].content[0].type, 'text');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DSH model surfaces resolve failures without sending a message', async () => {
  const model = new DshSessionModel({
    sessionController: { async resolveAgent() { return { error: { message: 'no-agent' } }; } },
    sessionId: 'session-1',
    eventGraceMs: 0,
  });
  const result = await model.complete({ kind: 'frame', frame: { frame_id: 'f' } });
  assert.equal(result.should_speak, false);
  assert.match(result.error, /no-agent/);
});
