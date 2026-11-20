import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UiChannel } from '../plugins/dsh-assistant-host/ui-channel.js';
import { ResidentHost } from '../plugins/dsh-assistant-host/resident-host.js';
import { PreactGate } from '../plugins/dsh-assistant-host/preact-gate.js';
import { WakeActionBridge } from '../plugins/dsh-assistant-host/action-request-bridge.js';

const now = () => new Date('2026-11-03T12:00:00.000Z');
const frame = { frame_id: 'frame-1', captured_at: '2026-11-03T12:00:00.000Z' };
const request = { program_id: 'notepad-open-file-menu', version: 2, hwnd: 1234 };
const grant = { grant_id: 'g1', actions: ['replay'], windows: [{ hwnd: 1234 }] };

function fixture(replay = async () => ({ status: 'completed' })) {
  const root = mkdtempSync(join(tmpdir(), 'assistant-action-bridge-'));
  const channel = new UiChannel(root, { assistantSessionId: 'instance-action-bridge' });
  const host = new ResidentHost({ channel });
  host.initialize();
  const gate = new PreactGate({ replay, clock: now });
  const bridge = new WakeActionBridge({ gate, host });
  return { root, channel, host, gate, bridge };
}

test('proposal asks for authorization and does not call replay', async () => {
  let calls = 0;
  const { root, channel, host, bridge } = fixture(async () => { calls += 1; return { status: 'completed' }; });
  try {
    bridge.propose({ actionRequest: request, frame });
    assert.equal(calls, 0);
    assert.equal(channel.readOutbox()[0].kind, 'action_request');
    assert.match(channel.readOutbox()[0].text, /需要你明确授权/);
    const result = await bridge.execute();
    assert.equal(result.reason, 'authorization_required');
    assert.equal(calls, 0);
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('grant is separate from execution; one authorized replay completes', async () => {
  let calls = 0;
  const { root, channel, host, bridge } = fixture(async () => {
    calls += 1;
    return { status: 'completed', receipt: 'r1' };
  });
  try {
    bridge.propose({ actionRequest: request, frame });
    bridge.authorize({ grant_id: 'bad', actions: ['click'], windows: [{ hwnd: 1234 }] });
    assert.equal(calls, 0);
    assert.match(channel.readOutbox().at(-1).text, /授权不足/);
    bridge.authorize(grant);
    assert.equal(calls, 0);
    assert.match(channel.readOutbox().at(-1).text, /已授权/);
    const result = await bridge.execute();
    assert.equal(result.status, 'completed');
    assert.equal(calls, 1);
    assert.match(channel.readOutbox().at(-1).text, /已完成/);
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed replay is reported and never retried', async () => {
  let calls = 0;
  const { root, channel, host, bridge } = fixture(async () => {
    calls += 1;
    return { status: 'failed', reason: 'TARGET_NOT_FOUND' };
  });
  try {
    bridge.propose({ actionRequest: request, frame });
    bridge.authorize(grant);
    await bridge.execute();
    await bridge.execute();
    assert.equal(calls, 1);
    assert.match(channel.readOutbox().at(-1).text, /不会自动重试/);
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('stale evidence is rejected before a pending action exists', async () => {
  const { root, host } = fixture();
  const lateGate = new PreactGate({
    replay: async () => ({ status: 'completed' }),
    clock: () => new Date('2026-11-03T12:00:10.000Z'),
  });
  const lateBridge = new WakeActionBridge({ gate: lateGate, host });
  try {
    assert.throws(
      () => lateBridge.propose({ actionRequest: request, frame }),
      /stale/,
    );
    assert.equal(lateBridge.status().phase, 'idle');
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
