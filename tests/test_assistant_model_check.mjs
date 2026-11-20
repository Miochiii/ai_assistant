import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelCheck, parseModelReply } from '../plugins/dsh-assistant-host/model-check.js';

test('structured decision required to publish', () => {
  assert.equal(parseModelReply('画面变化').speak, false);
  assert.equal(parseModelReply('{"speak":true,"text":"有变化"}').text, '有变化');
  assert.equal(parseModelReply('{"speak":false,"text":""}').speak, false);
});

test('overlapping capture is rejected; stopping during capture delivers nothing', async () => {
  let captures = 0, captured;
  const check = new ModelCheck({ ctx: { on() {} }, sessionId: 'test',
    captureFrame: () => { captures++; return new Promise(resolve => { captured = resolve; }); } });
  const first = check.request();
  assert.equal((await check.request()).reason, 'pending');
  assert.equal(captures, 1);
  check.stop();
  captured({ frame_id: 'cancelled', thumbnail_ref: 'not-read' });
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(check.pending, null);
  assert.equal(check.last, null);
  assert.equal((await check.request()).reason, 'stopped');
});
