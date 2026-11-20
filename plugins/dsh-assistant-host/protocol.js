/**
 * Protocol contract for the resident assistant host.
 *
 * This module is intentionally offline: no DSH service, model client, screen
 * capture or desktop input. It validates user events and UI state snapshots so
 * later phases cannot silently widen the wire format.
 */
import { randomUUID } from 'node:crypto';

export const SCHEMA_VERSION = 1;
export const EVENT_KINDS = Object.freeze([
  'chat_submit',
  'typing_started',
  'typing_ended',
  'start_task',
  'end_task',
  'check_step',
  'skip_step',
  'pause_observation',
  'resume_observation',
  'cancel_task',
  'stop_response',
  'close_assistant',
]);
export const ACK_STATUSES = Object.freeze(['accepted', 'handled', 'rejected']);
export const MAX_EVENT_BYTES = 64 * 1024;
export const MAX_MESSAGE_TEXT = 8 * 1024;

export function newId(prefix = 'id') {
  return `${prefix}-${randomUUID()}`;
}

export function nowIso(clock = () => new Date()) {
  return clock().toISOString();
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeInteger(value) {
  return Number.isSafeInteger(value);
}

function validateText(value, field, max = MAX_MESSAGE_TEXT) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be non-empty text`);
  if ([...value].length > max) throw new Error(`${field} exceeds ${max} characters`);
  return value.trim();
}

export function eventBytes(event) {
  return Buffer.byteLength(JSON.stringify(event), 'utf8');
}

export function validateEvent(event, { assistantSessionId = null } = {}) {
  if (!isPlainObject(event)) throw new Error('event must be an object');
  if (event.schema_version !== SCHEMA_VERSION) throw new Error('unsupported event schema_version');
  if (typeof event.event_id !== 'string' || !event.event_id.trim()) throw new Error('missing event_id');
  if (typeof event.assistant_session_id !== 'string' || !event.assistant_session_id) {
    throw new Error('missing assistant_session_id');
  }
  if (assistantSessionId && event.assistant_session_id !== assistantSessionId) {
    throw new Error('assistant_session_id mismatch');
  }
  if (!EVENT_KINDS.includes(event.kind)) throw new Error(`unsupported event kind: ${event.kind}`);
  if (!isSafeInteger(event.client_seq) || event.client_seq < 1) throw new Error('client_seq must be positive integer');
  if (!isSafeInteger(event.context_epoch) || event.context_epoch < 0) {
    throw new Error('context_epoch must be non-negative integer');
  }
  if (event.task_id !== null && typeof event.task_id !== 'string') {
    throw new Error('task_id must be null or string');
  }
  if (typeof event.created_at !== 'string' || Number.isNaN(Date.parse(event.created_at))) {
    throw new Error('created_at must be ISO-8601');
  }
  if (!isPlainObject(event.payload)) throw new Error('payload must be an object');
  if (event.kind === 'chat_submit') validateText(event.payload.text, 'payload.text');
  if (eventBytes(event) > MAX_EVENT_BYTES) throw new Error('event exceeds size limit');
  return event;
}

export function makeEvent({
  assistantSessionId,
  kind,
  clientSeq,
  contextEpoch,
  taskId = null,
  payload = {},
  clock = () => new Date(),
}) {
  const event = {
    schema_version: SCHEMA_VERSION,
    event_id: newId('event'),
    assistant_session_id: assistantSessionId,
    task_id: taskId,
    context_epoch: contextEpoch,
    client_seq: clientSeq,
    kind,
    created_at: nowIso(clock),
    payload,
  };
  return validateEvent(event, { assistantSessionId });
}

export function validateState(state, { assistantSessionId = null } = {}) {
  if (!isPlainObject(state)) throw new Error('state must be an object');
  if (state.schema_version !== SCHEMA_VERSION) throw new Error('unsupported state schema_version');
  if (typeof state.assistant_session_id !== 'string' || !state.assistant_session_id) {
    throw new Error('missing assistant_session_id');
  }
  if (assistantSessionId && state.assistant_session_id !== assistantSessionId) {
    throw new Error('state assistant_session_id mismatch');
  }
  if (!isSafeInteger(state.state_revision) || state.state_revision < 0) {
    throw new Error('state_revision must be non-negative integer');
  }
  if (!isSafeInteger(state.context_epoch) || state.context_epoch < 0) {
    throw new Error('context_epoch must be non-negative integer');
  }
  if (!['starting', 'ready', 'closing', 'closed', 'fault'].includes(state.assistant)) {
    throw new Error('invalid assistant state');
  }
  if (!['companion', 'coach', 'standby'].includes(state.mode)) {
    throw new Error('invalid mode');
  }
  if (!isPlainObject(state.observation)
      || !['stopped', 'starting', 'running', 'paused', 'fault'].includes(state.observation.status)) {
    throw new Error('invalid observation state');
  }
  if (state.task !== null) {
    if (!isPlainObject(state.task) || typeof state.task.task_id !== 'string'
        || !['waiting_user', 'checking', 'complete', 'cancelled'].includes(state.task.status)) {
      throw new Error('invalid task');
    }
  }
  if (state.model_request !== null && !isPlainObject(state.model_request)) {
    throw new Error('invalid model_request');
  }
  if (state.highlight !== undefined && state.highlight !== null) {
    validateHighlight(state.highlight);
  }
  if (!isPlainObject(state.bubble) || typeof state.bubble.text !== 'string') {
    throw new Error('invalid bubble');
  }
  if (typeof state.input_enabled !== 'boolean') throw new Error('input_enabled must be boolean');
  return state;
}

export function validateHighlight(highlight) {
  if (highlight?.window_geometry != null) {
    const geometry = highlight.window_geometry;
    if (!Array.isArray(geometry) || geometry.length < 1 || geometry.length > 16
        || !geometry.every(g => Number.isSafeInteger(g?.hwnd) && g.hwnd > 0
          && Array.isArray(g.rect) && g.rect.length === 4 && g.rect.every(Number.isSafeInteger)
          && g.rect[2] > g.rect[0] && g.rect[3] > g.rect[1])
        || !geometry.some(g => g.hwnd === highlight.target_hwnd)) {
      throw new Error('highlight window_geometry must bind target HWND to visible frame bounds');
    }
  }
  if (!isPlainObject(highlight)) throw new Error('highlight must be an object');
  if (typeof highlight.highlight_id !== 'string' || !highlight.highlight_id) {
    throw new Error('highlight_id is required');
  }
  if (typeof highlight.text !== 'string' || !highlight.text.trim()) {
    throw new Error('highlight text is required');
  }
  if (!Array.isArray(highlight.rect) || highlight.rect.length !== 4
      || !highlight.rect.every(value => Number.isSafeInteger(value))
      || highlight.rect[2] <= 0 || highlight.rect[3] <= 0) {
    throw new Error('highlight rect must be [left, top, width, height]');
  }
  if (highlight.target_hwnd !== null && highlight.target_hwnd !== undefined
      && !Number.isSafeInteger(highlight.target_hwnd)) {
    throw new Error('highlight target_hwnd must be an integer or null');
  }
  if (highlight.observation_id !== null && highlight.observation_id !== undefined
      && typeof highlight.observation_id !== 'string') {
    throw new Error('highlight observation_id must be a string or null');
  }
  if (highlight.created_at !== undefined && typeof highlight.created_at !== 'string') {
    throw new Error('highlight created_at must be a string');
  }
  return highlight;
}

export function validateAck(ack) {
  if (!isPlainObject(ack) || typeof ack.event_id !== 'string'
      || !ACK_STATUSES.includes(ack.status)) {
    throw new Error('invalid ack');
  }
  return ack;
}
