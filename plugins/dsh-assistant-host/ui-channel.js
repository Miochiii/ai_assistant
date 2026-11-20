/**
 * Durable local file channel for the resident assistant.
 *
 * Layout:
 *   instance.json / .lock
 *   heartbeat.json
 *   state.json                 (Host -> UI, overwrite only by Host)
 *   inbox/<seq>-<hash>.json    (UI -> Host, one immutable event per file)
 *   acks/<hash>.json           (Host -> UI, accepted/handled/rejected)
 *   outbox/<seq>-<hash>.json   (Host -> UI, immutable messages)
 *
 * It is at-least-once + ID-dedupe, not exactly-once. This module deliberately
 * has no timers, network calls, screenshots or desktop input.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import {
  MAX_EVENT_BYTES,
  SCHEMA_VERSION,
  eventBytes,
  nowIso,
  validateAck,
  validateEvent,
  validateState,
} from './protocol.js';

const DEFAULT_MAX_ACKS = 2000;
const DEFAULT_MAX_OUTBOX = 2000;
const HASH_LENGTH = 12;

function hashId(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, HASH_LENGTH);
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJsonAtomic(path, value) {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  try {
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function listJson(directory) {
  try {
    return readdirSync(directory)
      .filter(name => name.endsWith('.json') && !name.startsWith('.'))
      .sort()
      .map(name => join(directory, name));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export class UiChannel {
  constructor(root, {
    assistantSessionId,
    pid = process.pid,
    maxAcks = DEFAULT_MAX_ACKS,
    maxOutbox = DEFAULT_MAX_OUTBOX,
    clock = () => new Date(),
  } = {}) {
    if (typeof root !== 'string' || !root) throw new Error('root is required');
    if (typeof assistantSessionId !== 'string' || !assistantSessionId) {
      throw new Error('assistantSessionId is required');
    }
    this.root = root;
    this.assistantSessionId = assistantSessionId;
    this.pid = pid;
    this.maxAcks = maxAcks;
    this.maxOutbox = maxOutbox;
    this.clock = clock;
    this.inboxDir = join(root, 'inbox');
    this.acksDir = join(root, 'acks');
    this.outboxDir = join(root, 'outbox');
    this.instancePath = join(root, 'instance.json');
    this.lockPath = join(root, 'instance.lock');
    this.heartbeatPath = join(root, 'heartbeat.json');
    this.statePath = join(root, 'state.json');
    this._lockFd = null;
    this._ownsLock = false;
    this._closed = false;
  }

  initialize() {
    if (this._closed) throw new Error('channel is closed');
    for (const directory of [this.root, this.inboxDir, this.acksDir, this.outboxDir]) {
      mkdirSync(directory, { recursive: true });
    }
    this._acquireLock();
    const instance = {
      schema_version: SCHEMA_VERSION,
      assistant_session_id: this.assistantSessionId,
      pid: this.pid,
      started_at: nowIso(this.clock),
    };
    writeJsonAtomic(this.instancePath, instance);
    this.heartbeat();
    return instance;
  }

  _acquireLock() {
    if (existsSync(this.lockPath)) {
      let holder = null;
      try { holder = JSON.parse(readFileSync(this.lockPath, 'utf8')); } catch { /* stale/corrupt */ }
      if (holder && isProcessAlive(holder.pid)) {
        throw new Error(`assistant instance already running: pid=${holder.pid}`);
      }
      unlinkSync(this.lockPath);
    }
    this._lockFd = openSync(this.lockPath, 'wx');
    this._ownsLock = true;
    writeSync(this._lockFd, JSON.stringify({
      pid: this.pid,
      assistant_session_id: this.assistantSessionId,
      started_at: nowIso(this.clock),
    }));
  }

  _assertOpen() {
    if (this._closed) throw new Error('channel is closed');
  }

  _eventHash(eventId) {
    return hashId(eventId);
  }

  _eventPath(event) {
    const seq = String(event.client_seq).padStart(12, '0');
    return join(this.inboxDir, `${seq}-${this._eventHash(event.event_id)}.json`);
  }

  _ackPath(eventId) {
    return join(this.acksDir, `${this._eventHash(eventId)}.json`);
  }

  findExistingEvent(eventId) {
    const ackPath = this._ackPath(eventId);
    if (existsSync(ackPath)) return { duplicate: true, ack: readJson(ackPath) };
    for (const path of listJson(this.inboxDir)) {
      try {
        const event = readJson(path);
        if (event?.event_id === eventId) return { duplicate: true, event, path };
      } catch { /* ignore corrupt */ }
    }
    return { duplicate: false };
  }

  submitEvent(event) {
    this._assertOpen();
    validateEvent(event, { assistantSessionId: this.assistantSessionId });
    if (eventBytes(event) > MAX_EVENT_BYTES) throw new Error('event exceeds size limit');
    const existing = this.findExistingEvent(event.event_id);
    if (existing.duplicate) return { duplicate: true, ...existing };
    const path = this._eventPath(event);
    if (existsSync(path)) return { duplicate: true, path };
    writeJsonAtomic(path, event);
    return { duplicate: false, path, event };
  }

  readInbox() {
    this._assertOpen();
    const items = [];
    for (const path of listJson(this.inboxDir)) {
      try {
        const event = readJson(path);
        validateEvent(event, { assistantSessionId: this.assistantSessionId });
        items.push({ event, path });
      } catch (error) {
        items.push({ event: null, path, error: `${error?.name ?? 'Error'}: ${error?.message ?? error}` });
      }
    }
    items.sort((a, b) => String(a.path).localeCompare(String(b.path)));
    return items;
  }

  readAck(eventId) {
    const path = this._ackPath(eventId);
    return existsSync(path) ? readJson(path) : null;
  }

  ack(eventId, status, reason = '') {
    this._assertOpen();
    if (typeof eventId !== 'string' || !eventId) throw new Error('eventId is required');
    const ack = {
      schema_version: SCHEMA_VERSION,
      event_id: eventId,
      assistant_session_id: this.assistantSessionId,
      status,
      reason: String(reason ?? '').slice(0, 400),
      at: nowIso(this.clock),
    };
    validateAck(ack);
    writeJsonAtomic(this._ackPath(eventId), ack);
    this._prune(this.acksDir, this.maxAcks);
    return ack;
  }

  publishMessage(message) {
    this._assertOpen();
    if (!message || typeof message !== 'object') throw new Error('message is required');
    const item = {
      schema_version: SCHEMA_VERSION,
      message_id: message.message_id ?? `message-${randomUUID()}`,
      assistant_session_id: this.assistantSessionId,
      task_id: message.task_id ?? null,
      context_epoch: Number.isSafeInteger(message.context_epoch) ? message.context_epoch : 0,
      kind: message.kind ?? 'assistant_message',
      text: String(message.text ?? '').slice(0, 8 * 1024),
      created_at: message.created_at ?? nowIso(this.clock),
      ...(message.request_id ? { request_id: message.request_id } : {}),
    };
    const seq = String(Date.now()).padStart(15, '0');
    const path = join(this.outboxDir, `${seq}-${hashId(item.message_id)}.json`);
    writeJsonAtomic(path, item);
    this._prune(this.outboxDir, this.maxOutbox);
    return item;
  }

  readOutbox() {
    this._assertOpen();
    return listJson(this.outboxDir).map(path => {
      try { return { ...readJson(path), path }; } catch { return null; }
    }).filter(Boolean);
  }

  readState() {
    this._assertOpen();
    return existsSync(this.statePath) ? readJson(this.statePath) : null;
  }

  writeState(state) {
    this._assertOpen();
    validateState(state, { assistantSessionId: this.assistantSessionId });
    if (existsSync(this.statePath)) {
      const previous = readJson(this.statePath);
      if (Number.isSafeInteger(previous?.state_revision)
          && state.state_revision < previous.state_revision) {
        throw new Error('state_revision must not decrease');
      }
    }
    writeJsonAtomic(this.statePath, state);
    return state;
  }

  heartbeat(extra = {}) {
    this._assertOpen();
    const value = {
      schema_version: SCHEMA_VERSION,
      assistant_session_id: this.assistantSessionId,
      pid: this.pid,
      at: nowIso(this.clock),
      ...extra,
    };
    writeJsonAtomic(this.heartbeatPath, value);
    return value;
  }

  _prune(directory, limit) {
    const files = listJson(directory);
    if (files.length <= limit) return;
    for (const path of files.slice(0, files.length - limit)) {
      try { unlinkSync(path); } catch { /* best effort */ }
    }
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    if (this._lockFd !== null) {
      try { closeSync(this._lockFd); } catch { /* ignore */ }
      this._lockFd = null;
    }
    if (this._ownsLock) {
      try { unlinkSync(this.lockPath); } catch { /* ignore */ }
      this._ownsLock = false;
    }
  }
}

export function readStateFile(root) {
  const path = join(root, 'state.json');
  return existsSync(path) ? readJson(path) : null;
}

export function listOutbox(root) {
  const directory = join(root, 'outbox');
  try {
    return readdirSync(directory).filter(name => name.endsWith('.json')).sort();
  } catch { return []; }
}
