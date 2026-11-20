import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACK_STATUSES,
  EVENT_KINDS,
  SCHEMA_VERSION,
  makeEvent,
  validateAck,
  validateEvent,
  validateState,
} from '../plugins/dsh-assistant-host/protocol.js';

const SESSION = 'instance-test';

function baseEvent(overrides = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    event_id: 'event-1',
    assistant_session_id: SESSION,
    task_id: null,
    context_epoch: 0,
    client_seq: 1,
    kind: 'chat_submit',
    created_at: '2026-11-03T00:00:00.000Z',
    payload: { text: 'hello' },
    ...overrides,
  };
}

test('valid event and state contracts pass', () => {
  assert.doesNotThrow(() => validateEvent(baseEvent(), { assistantSessionId: SESSION }));
  assert.ok(EVENT_KINDS.includes('chat_submit'));
  assert.ok(ACK_STATUSES.includes('handled'));
  const state = {
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
  assert.doesNotThrow(() => validateState(state, { assistantSessionId: SESSION }));
});

test('event validation rejects missing, stale and oversized fields', () => {
  assert.throws(() => validateEvent(baseEvent({ event_id: '' })), /event_id/);
  assert.throws(() => validateEvent(baseEvent({ kind: 'unknown' })), /event kind/);
  assert.throws(() => validateEvent(baseEvent({ client_seq: 0 })), /client_seq/);
  assert.throws(() => validateEvent(baseEvent({ context_epoch: -1 })), /context_epoch/);
  assert.throws(() => validateEvent(baseEvent({ payload: {} })), /payload.text/);
  assert.throws(() => validateEvent(baseEvent({ created_at: 'not-a-date' })), /created_at/);
  assert.throws(() => validateEvent(baseEvent({ assistant_session_id: 'other' }), {
    assistantSessionId: SESSION,
  }), /mismatch/);
  assert.throws(() => validateEvent(baseEvent({ payload: { text: 'ok', extra: 'x'.repeat(70000) } })), /size limit/);
});

test('makeEvent creates a valid unique event and preserves payload', () => {
  const event = makeEvent({
    assistantSessionId: SESSION,
    kind: 'chat_submit',
    clientSeq: 3,
    contextEpoch: 2,
    payload: { text: 'test' },
    clock: () => new Date('2026-11-03T00:00:00Z'),
  });
  assert.equal(event.schema_version, SCHEMA_VERSION);
  assert.equal(event.assistant_session_id, SESSION);
  assert.equal(event.client_seq, 3);
  assert.equal(event.context_epoch, 2);
  assert.equal(event.payload.text, 'test');
  assert.notEqual(event.event_id, 'event-1');
});

test('ack validation is strict', () => {
  assert.doesNotThrow(() => validateAck({ event_id: 'e', status: 'handled' }));
  assert.throws(() => validateAck({ event_id: 'e', status: 'done' }), /invalid ack/);
});
