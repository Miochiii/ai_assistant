import assert from 'node:assert/strict';
import test from 'node:test';

import { createDshSessionModelFromContext } from '../plugins/dsh-assistant-host/dsh-model-bridge.js';
import { DshSessionModel } from '../plugins/dsh-assistant-host/dsh-session-model.js';

test('bridge resolves host services and subscribes session events', async () => {
  let listener = null;
  const agent = {
    followup(message) {
      this.message = message;
      queueMicrotask(() => {
        listener?.({ header: { id: 'session-1' } }, {
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: 'bridge reply' }] } },
        });
        this.resolveIdle();
      });
    },
    whenIdle() { return new Promise(resolve => { this.resolveIdle = resolve; }); },
  };
  const ctx = {
    get(name) {
      if (name === 'sessionController') return { async resolveAgent() { return { agent }; } };
      if (name === 'attachments') return { async saveImage() { return { attachmentId: 'x' }; } };
      return null;
    },
    on(name, callback) {
      assert.equal(name, 'session/event');
      listener = callback;
      return () => { listener = null; };
    },
  };
  const model = createDshSessionModelFromContext(ctx, {
    sessionId: 'session-1', eventGraceMs: 0,
  });
  assert.ok(model instanceof DshSessionModel);
  const result = await model.complete({ kind: 'frame', frame: { frame_id: 'f1' } });
  assert.equal(result.should_speak, true);
  assert.equal(result.text, 'bridge reply');
  assert.equal(agent.message.role, 'user');
});

test('bridge rejects a context without sessionController', () => {
  assert.throws(
    () => createDshSessionModelFromContext({ get: () => null, on: () => () => {} }, { sessionId: 's' }),
    /sessionController/,
  );
});
