import test from 'node:test';
import assert from 'node:assert/strict';
import { PRICE, reservation, inspectPlan } from '../scripts/desktop_session_plan.mjs';
import { sessionTrialCommand, sessionOfflineCommand } from '../plugins/dsh-desktop-observe/session-trial.js';
import { root } from '../plugins/dsh-desktop-observe/bridge.js';

const now = Date.parse(PRICE.checkedAt) + 60000;
const plan = () => ({ schema_version: 1, trial_id: 'offline-test-plan', approved: true, status: 'active',
  max_output_tokens: 1024, max_requests: 3, budget_micro_cny: 6400000, price_snapshot: PRICE.checkedAt,
  expires_at: new Date(now + 600000).toISOString(), parent_session_id: 'fixture-session',
  observation_path: 'fixture-path', source_sha256: 'a'.repeat(64), image_reviewed: true, scope: 'one-reviewed-image-readonly' });
const invocation = (rawInput = '') => ({ rawInput, attachments: [], signal: new AbortController().signal,
  agent: { session: { header: { cwd: root, id: 'fixture-session' } } } });

test('budget uses the entire published context at peak rates, not text-byte estimates', () => {
  assert.equal(reservation(1024, 3).totalMicroCny, 6316032);
  assert.equal(reservation(1024, 3).perRequestMicroCny, 2105344);
  assert.throws(() => reservation(256000, 3)); assert.throws(() => reservation(1024, 4));
  assert(inspectPlan(plan(), { now, parentSessionId: 'fixture-session' }).ready);
  assert(!inspectPlan({ ...plan(), budget_micro_cny: 500000 }, { now }).ready);
});

test('closed/expired approval, stale prices, wrong session and missing image reject', () => {
  for (const patch of [{ approved: false }, { status: 'completed' }, { image_reviewed: false },
    { source_sha256: 'wrong' }, { expires_at: new Date(now - 1).toISOString() }, { price_snapshot: 'old' },
    { parent_session_id: 'another-session' }, { scope: 'entire-desktop' }])
    assert(!inspectPlan({ ...plan(), ...patch }, { now, parentSessionId: 'fixture-session' }).ready);
  assert(!inspectPlan(plan(), { now: Date.parse(PRICE.validUntil) + 1 }).ready);
});

test('bounded validation skips pricing but keeps image, session, expiry and finite limits', () => {
  const later = Date.parse(PRICE.validUntil) + 60000;
  const bounded = { ...plan(), authorization_mode: 'small_readonly_validation',
    authorization_note: 'User requested small validation without cost calculations',
    budget_micro_cny: undefined, price_snapshot: undefined, expires_at: new Date(later + 600000).toISOString() };
  const check = patch => inspectPlan({ ...bounded, ...patch }, { now: later, parentSessionId: 'fixture-session' });
  assert.equal(check().ready, true); assert.equal(check().cost, null);
  for (const patch of [{ approved: false }, { status: 'completed' }, { image_reviewed: false },
    { authorization_note: '' }, { parent_session_id: 'wrong' }, { expires_at: new Date(later - 1).toISOString() }])
    assert.equal(check(patch).ready, false);
  for (const patch of [{ max_requests: 0 }, { max_requests: 4 }, { max_output_tokens: 1025 }])
    assert.throws(() => check(patch), /limits/);
});

test('status and unapproved run never launch; offline does not load paid plan', async () => {
  let launches = 0, loads = 0;
  const command = sessionTrialCommand({}, {
    load: async () => { loads++; return { ...plan(), approved: false }; },
    launch: async mode => { launches++; assert.equal(mode, 'offline'); return { passed: true, report_path: 'fixture', message: 'offline' }; },
  });
  assert.equal((await command.handler(invocation())).kind, 'success');
  assert.equal((await command.handler(invocation('run'))).kind, 'error');
  assert.equal(launches, 0); assert.equal(loads, 2);
  assert.equal((await command.handler(invocation('offline'))).kind, 'success');
  assert.equal(launches, 1); assert.equal(loads, 2);
});

test('invalid input, workspace and cancelled invocation never launch', async () => {
  const command = sessionTrialCommand({}, { launch: async () => assert.fail('must not launch') });
  assert.equal((await command.handler(invocation('--send'))).kind, 'error');
  assert.equal((await command.handler({ ...invocation('offline'), attachments: [{}] })).kind, 'error');
  assert.equal((await command.handler({ ...invocation('offline'), agent: {} })).kind, 'error');
  await assert.rejects(command.handler({ ...invocation('offline'), signal: AbortSignal.abort() }));
});

test('dedicated offline command has no input and cannot select a paid run', async () => {
  let calls = 0;
  const command = sessionOfflineCommand({}, { load: async () => assert.fail('no paid plan'),
    launch: async mode => { calls++; assert.equal(mode, 'offline'); return { passed: true, report_path: 'fixture' }; } });
  assert.equal(command.name, 'desktop-offline'); assert.equal(command.input, undefined);
  assert.equal((await command.handler(invocation())).kind, 'success');
  assert.equal((await command.handler(invocation('run'))).kind, 'error');
  assert.equal(calls, 1);
  assert.equal(typeof sessionTrialCommand({}).input.hint, 'string');
});
