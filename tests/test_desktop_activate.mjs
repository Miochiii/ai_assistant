import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { activateWindow, root } from '../plugins/dsh-desktop-observe/bridge.js';

function execution(cwd = root) {
  return { agent: { session: { header: { cwd, id: 'activate-test' } } },
    signal: new AbortController().signal };
}

test('activation forwards hwnd and reports a focus-only action', async () => {
  let seen;
  const receipt = await activateWindow({ hwnd: 123 }, execution(), async hwnd => {
    seen = hwnd;
    return { ok: true, outcome: 'foreground_confirmed', hwnd, foreground: hwnd,
      integrity: 'medium', target_integrity: 'medium', input_events_sent: 0, clicks: 0 };
  });
  assert.equal(seen, 123);
  assert.equal(receipt.activation, true);
  assert.equal(receipt.gui_actions, 1);
  assert.equal(receipt.input_events_sent, 0);
  assert.match(receipt.notice, /No mouse or keyboard input/);
});

test('activation rejects bad input and another workspace before running', async () => {
  await assert.rejects(activateWindow({}, execution(), async () => assert.fail('must not run')), /hwnd/);
  await assert.rejects(activateWindow({ hwnd: 0 }, execution(), async () => assert.fail('must not run')), /hwnd/);
  await assert.rejects(activateWindow({ hwnd: 1, command: 'calc' }, execution(),
    async () => assert.fail('must not run')), /Unknown/);
  await assert.rejects(activateWindow({ hwnd: 1 }, execution(join(root, '..')),
    async () => assert.fail('must not run')), /assistant workspace/);
});

test('activation relay preserves a refusal receipt', async () => {
  const receipt = await activateWindow({ hwnd: 123 }, execution(), async () => ({
    ok: false, error_code: 'TARGET_INTEGRITY_TOO_HIGH', input_events_sent: 0, clicks: 0 }));
  assert.equal(receipt.ok, false);
  assert.equal(receipt.error_code, 'TARGET_INTEGRITY_TOO_HIGH');
  assert.equal(receipt.clicks, 0);
});
