import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildProgramDraft,
  draftDigest,
  writeProgramDraft,
} from '../plugins/dsh-assistant-host/program-draft.js';

const sha = 'a'.repeat(64);
const windowInfo = { hwnd: 1234, class_name: 'Notepad', title: 'Untitled - Notepad' };

function step(index, overrides = {}) {
  return {
    intent: `第 ${index} 步`,
    target_label: `按钮 ${index}`,
    evidence: {
      observation_id: `obs-${index}`,
      image_sha256: sha,
      capture_bounds: { left: 10, top: 20, width: 800, height: 600 },
      target_center: [100 + index, 50 + index],
    },
    expected: { description: `第 ${index} 步完成` },
    verification: { status: 'passed' },
    ...overrides,
  };
}

test('preserves expected template metadata needed by PreAct proof', () => {
  const draft = buildProgramDraft({
    task: 't', executorVersion: '0.5.1',
    steps: [step(1, { expected: {
      description: '菜单已打开', template: 'runtime/templates/menu.png', region: [0, 0, 100, 80],
    } })],
  });
  assert.equal(draft.steps[0].expected.template, 'runtime/templates/menu.png');
  assert.deepEqual(draft.steps[0].expected.region, [0, 0, 100, 80]);
});

test('builds a PreAct-shaped draft sequence without coordinates in actions', () => {
  const draft = buildProgramDraft({
    programId: 'explore-calculator',
    task: '打开计算器并计算',
    executorVersion: '0.5.1',
    steps: [step(1), step(2)],
    window: windowInfo,
    createdAt: '2026-11-03T12:00:00.000Z',
  });
  assert.equal(draft.verification.status, 'draft');
  assert.equal(draft.steps.length, 2);
  assert.deepEqual(draft.steps[0].visual_basis.target_center, [101, 51]);
  assert.equal(draft.steps[0].visual_basis.observation_id, 'obs-1');
  assert.equal(draft.steps[0].action.type, 'click');
  assert.equal(draft.steps[0].action.target_label, '按钮 1');
  for (const forbidden of ['center', 'screen_point', 'point', 'x', 'y']) {
    assert.equal(forbidden in draft.steps[0].action, false);
  }
  assert.deepEqual(draft.steps[0].preconditions.window, {
    hwnd: 1234, class_name: 'Notepad', title: 'Untitled - Notepad',
  });
});

test('rejects missing evidence, invalid target center and coordinate actions', () => {
  assert.throws(() => buildProgramDraft({
    task: 't', executorVersion: 'v', steps: [step(1, { evidence: {} })],
  }), /observation_id/);
  assert.throws(() => buildProgramDraft({
    task: 't', executorVersion: 'v',
    steps: [step(1, { evidence: { ...step(1).evidence, target_center: [-1, 1] } })],
  }), /target_center/);
  assert.throws(() => buildProgramDraft({
    task: 't', executorVersion: 'v',
    steps: [step(1, { action: { center: [1, 2] } })],
  }), /coordinates/);
});

test('writes a draft file and refuses to overwrite', async () => {
  const root = mkdtempSync(join(tmpdir(), 'assistant-program-draft-'));
  const draft = buildProgramDraft({
    programId: 'explore-write', task: 't', executorVersion: 'v', steps: [step(1)],
    window: windowInfo,
  });
  try {
    const path = await writeProgramDraft(root, draft);
    assert.match(path, /program-drafts/);
    await assert.rejects(() => writeProgramDraft(root, draft), /EEXIST/);
    assert.equal(draftDigest(draft).length, 64);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
