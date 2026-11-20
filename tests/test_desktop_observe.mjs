import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { captureArgs, evidencePath, root, observe } from '../plugins/dsh-desktop-observe/bridge.js';
import { apply, definitions } from '../plugins/dsh-desktop-observe/index.js';

test('input surface is the eleven declared tools', () => {
  assert.deepEqual(definitions().map(t => t.name),
    ['desktop_monitors', 'desktop_windows', 'desktop_activate', 'desktop_observe', 'desktop_click',
      'desktop_scroll', 'desktop_key', 'desktop_text', 'desktop_combo', 'desktop_drag', 'desktop_replay']);
});
test('reject command injection and malformed regions before process creation', () => {
  for (const args of [{ monitor: '1; calc' }, { monitor: true }, { command: 'calc' },
    { region: [0, 0, 20] }, { region: [0, 0, 0, 20] }, { region: [0, 0, 10000, 10000] }]) {
    assert.throws(() => captureArgs(args));
  }
  assert.deepEqual(captureArgs({region: [-100, 0, 50, 50]}).slice(-5), ['--region', '-100', '0', '50', '50']);
});
test('evidence paths cannot read arbitrary local files', () => {
  assert.throws(() => evidencePath(join(root, 'README.md')));
  assert.equal(evidencePath(join(root, 'results', 'vision', 'run', 'screen.png')),
    join(root, 'results', 'vision', 'run', 'screen.png'));
});
test('calls from another workspace fail before any screenshot', async () => {
  await assert.rejects(observe({}, {agent: {session: {header: {cwd: join(root, '..')}}}}), /assistant workspace/);
});
test('failed mount rolls back the first registration', () => {
  let count = 0, removed = false;
  assert.throws(() => apply({tools: {register() {
    if (++count === 2) throw new Error('registration failed');
    return () => { removed = true; };
  }}}));
  assert.equal(removed, true);
});
