import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { startResidentUi } from '../plugins/dsh-assistant-host/ui-process.js';

test('UI process handshakes, reports heartbeat and stops', async () => {
  const root = mkdtempSync(join(tmpdir(), 'assistant-ui-'));
  const session = 'instance-ui-test';
  try {
    mkdirSync(join(root, 'inbox'), { recursive: true });
    writeFileSync(join(root, 'instance.json'), JSON.stringify({
      assistant_session_id: session,
      pid: 1,
      started_at: new Date().toISOString(),
    }));
    const ui = await startResidentUi({
      channelDir: root,
      assistantSessionId: session,
      pythonPath: 'E:\\python\\python.exe',
      panelPath: resolve('tests', 'fixtures', 'fake_resident_ui.py'),
      timeoutMs: 4000,
    });
    try {
      assert.equal(ui.ready.assistant_session_id, session);
      assert.equal(ui.ready.pid, ui.child.pid);
      const state = ui.status();
      assert.equal(state.alive, true);
      assert.equal(state.ready.assistant_session_id, session);
      assert.equal(state.heartbeat_fresh, true);
    } finally {
      await ui.stop();
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    assert.equal(ui.status().alive, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('UI process rejects a missing channel handshake', async () => {
  const root = mkdtempSync(join(tmpdir(), 'assistant-ui-missing-'));
  try {
    await assert.rejects(() => startResidentUi({
      channelDir: root,
      assistantSessionId: 'instance-missing',
      pythonPath: 'E:\\python\\python.exe',
      panelPath: resolve('tests', 'fixtures', 'fake_resident_ui.py'),
      timeoutMs: 300,
    }), /handshake timed out|exited early|not found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
