import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PanelStepVerifier, parseStepVerification } from '../plugins/dsh-assistant-host/panel-guidance.js';

function fixture(reply = '{"status":"passed","reason":"菜单已打开"}') {
  const root = mkdtempSync(join(tmpdir(), 'assistant-panel-verify-'));
  const thumb = join(root, 'thumb.png');
  writeFileSync(thumb, Buffer.from('png'));
  const bodies = [];
  const saved = [];
  const ctx = {
    llm: {
      async *stream(request) {
        bodies.push(request);
        yield { type: 'text-delta', index: 0, text: reply };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
    get(name) {
      if (name === 'attachments') {
        return { async saveImage(input) { saved.push(input); return { attachmentId: 'verify-image' }; } };
      }
      return null;
    },
  };
  const verifier = new PanelStepVerifier({
    ctx,
    sessionId: 's1',
    captureFrame: async () => ({ frame_id: 'f1', thumbnail_ref: thumb }),
  });
  return { root, verifier, bodies, saved };
}

test('step verification parses passed/failed/unknown and never guesses', () => {
  assert.equal(parseStepVerification('{"status":"passed","reason":"ok"}').status, 'passed');
  assert.equal(parseStepVerification('{"status":"failed"}').status, 'failed');
  assert.equal(parseStepVerification('我觉得成功了').status, 'unknown');
  assert.equal(parseStepVerification('{"status":"ok"}').status, 'unknown');
});

test('step verifier sends the fresh frame and returns a structured decision', async () => {
  const { root, verifier, bodies, saved } = fixture();
  try {
    const result = await verifier.verify({
      task: { title: '打开文件菜单' },
      step: { text: '点击“文件”' },
    });
    assert.equal(result.status, 'passed');
    assert.equal(result.reason, '菜单已打开');
    assert.equal(saved.length, 1);
    const content = bodies[0].messages.at(-1).content;
    assert.equal(content[1].type, 'image');
    assert.equal(content[1].attachment.attachmentId, 'verify-image');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('step verifier returns unknown for an unstructured reply', async () => {
  const { root, verifier } = fixture('看起来已经完成了');
  try {
    const result = await verifier.verify({ task: { title: '任务' }, step: { text: '一步' } });
    assert.equal(result.status, 'unknown');
    assert.equal(result.reason, 'verification_reply_unstructured');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
