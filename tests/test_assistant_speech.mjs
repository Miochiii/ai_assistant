import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UiChannel } from '../plugins/dsh-assistant-host/ui-channel.js';
import { ResidentHost } from '../plugins/dsh-assistant-host/resident-host.js';
import {
  __resetSpeech,
  emitSpeech,
  emitSpoken,
  lastSpeech,
  onSpeech,
  speechSubscribers,
  SpeechPort,
} from '../plugins/dsh-assistant-host/speech-bus.js';

test('speech bus is a no-op with no subscriber and delivers due/spoken states', () => {
  __resetSpeech();
  const port = new SpeechPort();
  assert.equal(port.speak('hello').state, 'unvoiced');
  const events = [];
  const off = onSpeech(event => events.push(event));
  try {
    assert.equal(speechSubscribers(), 1);
    assert.equal(port.speak('第一句', { origin: 'assistant_message' }).delivered, 1);
    assert.equal(events[0].text, '第一句');
    assert.equal(events[0].state, 'due');
    emitSpoken({ text: '第一句' });
    assert.equal(events.at(-1).state, 'spoken');
    assert.equal(lastSpeech().state, 'spoken');
  } finally {
    off();
    __resetSpeech();
  }
});

test('a throwing voice subscriber does not break other subscribers', () => {
  __resetSpeech();
  const seen = [];
  const offBad = onSpeech(() => { throw new Error('tts failed'); });
  const offGood = onSpeech(event => seen.push(event.text));
  try {
    assert.equal(emitSpeech({ text: 'still here' }), 1);
    assert.deepEqual(seen, ['still here']);
  } finally {
    offBad();
    offGood();
    __resetSpeech();
  }
});

test('SpeechPort status reports subscriber count and last event', () => {
  __resetSpeech();
  const port = new SpeechPort();
  const off = onSpeech(() => {});
  try {
    port.speak('status');
    assert.equal(port.status().subscribers, 1);
    assert.equal(port.status().last.text, 'status');
  } finally {
    off();
    __resetSpeech();
  }
});

test('Host emits speech for published assistant messages', () => {
  const root = mkdtempSync(join(tmpdir(), 'assistant-speech-host-'));
  const channel = new UiChannel(root, { assistantSessionId: 'instance-speech' });
  const spoken = [];
  const speechPort = { speak: (text, options) => { spoken.push({ text, options }); } };
  const host = new ResidentHost({ channel, speechPort });
  try {
    host.initialize();
    host.publishAssistantMessage('说这一句');
    assert.equal(spoken.length, 1);
    assert.equal(spoken[0].text, '说这一句');
    assert.equal(spoken[0].options.origin, 'assistant_message');
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
