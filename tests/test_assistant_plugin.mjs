import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, inject, name } from '../plugins/dsh-assistant-host/index.js';

test('plugin registers offline check and model probe commands', () => {
  const registered = [];
  const disposers = [];
  const ctx = {
    commands: {
      register(command) {
        registered.push(command);
        return () => { disposers.push(command.name); };
      },
    },
  };
  const dispose = apply(ctx);
  assert.equal(name, 'dsh-assistant-host');
  assert.deepEqual(inject, ['commands', 'attachments', 'llm', 'sessionController']);
  assert.deepEqual(registered.map(command => command.name), [
    'assistant-check',
    'assistant-model-check',
    'assistant-highlight',
    'assistant-highlight-clear',
    'assistant-open',
    'assistant-close',
    'assistant-model-watch',
    'assistant-model-stop',
    'assistant-model-status',
  ]);
  assert.equal(registered.every(command => command.recordInput === false), true);
  dispose();
  assert.deepEqual(disposers, [
    'assistant-check',
    'assistant-model-check',
    'assistant-highlight',
    'assistant-highlight-clear',
    'assistant-open',
    'assistant-close',
    'assistant-model-watch',
    'assistant-model-stop',
    'assistant-model-status',
  ]);
});
