import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { selectGrant, selectGrantForHwnd } from '../plugins/dsh-desktop-observe/authorization.js';

const WINDOW = { hwnd: 5, pid: 6, class_name: 'Notepad', title: 'test.txt - 记事本' };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auth-'));
  await mkdir(join(root, 'runtime', 'authorizations'), { recursive: true });
  return root;
}

async function grant(root, overrides = {}) {
  const value = { schema_version: 1, grant_id: '11111111-1111-4111-8111-111111111111',
    created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600_000).toISOString(),
    task: 'test', harness_session: 'session-1', windows_session: 1, windows: [WINDOW],
    actions: ['activate', 'observe', 'click', 'replay'], program_ids: null, ...overrides };
  await writeFile(join(root, 'runtime', 'authorizations', `${value.grant_id}.json`), JSON.stringify(value));
  return value;
}

test('grant selection matches window, action and session', async () => {
  const root = await fixture();
  try {
    const value = await grant(root);
    assert.equal(selectGrant({ window: WINDOW, action: 'click', session: 'session-1', root }).grant_id,
      value.grant_id);
    assert.equal(selectGrantForHwnd({ hwnd: 5, action: 'activate', session: 'session-1', root }).grant_id,
      value.grant_id);
    assert.throws(() => selectGrant({ window: { ...WINDOW, title: 'other' }, action: 'click',
      session: 'session-1', root }), /No active task grant/);
    assert.throws(() => selectGrant({ window: WINDOW, action: 'click', session: 'session-2', root }),
      /No active task grant/);
    await grant(root, { program_ids: ['other'] });
    assert.throws(() => selectGrant({ window: WINDOW, action: 'replay', programId: 'p', root }),
      /No active task grant/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('expired and off-action grants are ignored', async () => {
  const root = await fixture();
  try {
    await grant(root, { grant_id: '22222222-2222-4222-8222-222222222222',
      expires_at: '2000-01-01T00:00:00.000Z' });
    await grant(root, { grant_id: '33333333-3333-4333-8333-333333333333', actions: ['observe'] });
    assert.throws(() => selectGrant({ window: WINDOW, action: 'click', session: 'session-1', root }),
      /No active task grant/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('explicit text scroll key chord and drag actions are valid grant actions', async () => {
  const root = await fixture();
  try {
    const value = await grant(root, { actions: ['observe', 'text', 'scroll', 'key', 'chord', 'drag'] });
    for (const action of ['text', 'scroll', 'key', 'chord', 'drag']) {
      assert.equal(selectGrant({ window: WINDOW, action, session: 'session-1', root }).grant_id,
        value.grant_id);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
