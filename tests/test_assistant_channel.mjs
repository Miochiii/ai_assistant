import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SCHEMA_VERSION, makeEvent } from '../plugins/dsh-assistant-host/protocol.js';
import { UiChannel, readStateFile } from '../plugins/dsh-assistant-host/ui-channel.js';

const SESSION = 'instance-channel';
let seq = 0;

function event(overrides = {}) {
  seq += 1;
  return makeEvent({
    assistantSessionId: SESSION,
    kind: 'chat_submit',
    clientSeq: seq,
    contextEpoch: 0,
    payload: { text: `message-${seq}` },
    ...overrides,
  });
}

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'assistant-channel-'));
}

test('channel writes immutable inbox, dedupes and writes acks', () => {
  const root = tempRoot();
  const channel = new UiChannel(root, { assistantSessionId: SESSION });
  try {
    channel.initialize();
    const item = event();
    const first = channel.submitEvent(item);
    const duplicate = channel.submitEvent(item);
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    const inbox = channel.readInbox();
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].event.event_id, item.event_id);
    assert.equal(channel.ack(item.event_id, 'accepted').status, 'accepted');
    assert.equal(channel.ack(item.event_id, 'handled').status, 'handled');
    assert.equal(channel.readAck(item.event_id).status, 'handled');
    assert.equal(channel.submitEvent(item).duplicate, true);
    assert.equal(readdirSync(join(root, 'inbox')).filter(name => name.endsWith('.tmp')).length, 0);
  } finally {
    channel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('channel persists state monotonically and publishes outbox messages', () => {
  const root = tempRoot();
  const channel = new UiChannel(root, { assistantSessionId: SESSION });
  const base = {
    schema_version: SCHEMA_VERSION,
    assistant_session_id: SESSION,
    state_revision: 1,
    context_epoch: 0,
    assistant: 'ready',
    mode: 'standby',
    observation: { status: 'stopped', scope_id: null },
    task: null,
    model_request: null,
    bubble: { text: '待命中' },
    input_enabled: true,
  };
  try {
    channel.initialize();
    channel.writeState(base);
    channel.writeState({ ...base, state_revision: 2, bubble: { text: '更新' } });
    assert.equal(readStateFile(root).bubble.text, '更新');
    assert.throws(() => channel.writeState({ ...base, state_revision: 1 }), /must not decrease/);
    const message = channel.publishMessage({ kind: 'assistant_message', text: 'hello' });
    assert.equal(message.assistant_session_id, SESSION);
    assert.equal(channel.readOutbox().length, 1);
    assert.equal(channel.readOutbox()[0].text, 'hello');
  } finally {
    channel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('channel prevents a second live instance and releases the lock', () => {
  const root = tempRoot();
  const first = new UiChannel(root, { assistantSessionId: SESSION });
  try {
    first.initialize();
    const second = new UiChannel(root, { assistantSessionId: 'instance-other' });
    assert.throws(() => second.initialize(), /already running/);
    second.close();
    assert.equal(existsSync(join(root, 'instance.lock')), true);
    first.close();
    assert.equal(existsSync(join(root, 'instance.lock')), false);
    const third = new UiChannel(root, { assistantSessionId: 'instance-third' });
    third.initialize();
    third.close();
  } finally {
    first.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('channel rejects invalid event payloads without leaving a file', () => {
  const root = tempRoot();
  const channel = new UiChannel(root, { assistantSessionId: SESSION });
  try {
    channel.initialize();
    const bad = { ...event(), payload: {} };
    assert.throws(() => channel.submitEvent(bad), /payload.text/);
    assert.equal(channel.readInbox().length, 0);
    assert.equal(readFileSync(join(root, 'instance.json'), 'utf8').includes(SESSION), true);
  } finally {
    channel.close();
    rmSync(root, { recursive: true, force: true });
  }
});
