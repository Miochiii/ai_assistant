import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { ENDPOINT, createWireGuard, validatePolicy } from '../scripts/desktop_wire_guard.mjs';

const root = resolve(import.meta.dirname, '..');
const bytes = Buffer.from('fixture bytes, no real screenshot');
const imageHash = createHash('sha256').update(bytes).digest('hex');
const policy = { trialId: 'offline-wire', sessionId: 'offline-wire', maxRequests: 3,
  maxOutputTokens: 1024, maxBodyBytes: 2000000, maxNonImageBytes: 16000,
  approvedImageHashes: [imageHash], reserveMicroCny: 72192, budgetMicroCny: 500000 };
function request(patch = {}) {
  return { method: 'POST', redirect: 'error', headers: { 'x-deepseek-harness-session-id': policy.sessionId },
    body: JSON.stringify({ model: 'deepseek-flash', max_tokens: 1024, stream: true,
      thinking: { type: 'disabled' }, messages: [{ role: 'user', content: 'fixture' }], ...patch }) };
}
async function fixture(fn) {
  const directory = await mkdtemp(join(root, 'results', 'tmp-wire-test-'));
  let approval = { approved: true, status: 'active', trial_id: policy.trialId, policy_sha256: validatePolicy(policy) };
  let calls = 0;
  const options = { directory, policy, readApproval: async () => approval,
    transport: async () => { calls++; return new Response('fixture'); } };
  try { await fn({ options, setApproval: value => { approval = value; }, calls: () => calls }); }
  finally {
    const sub = relative(join(root, 'results'), resolve(directory));
    assert(sub && !sub.startsWith('..') && !isAbsolute(sub));
    await rm(directory, { recursive: true, force: true });
  }
}

test('failed HTTP consumes quota; reopening preserves it; no secrets in ledger', () => fixture(async ({ options, calls }) => {
  const first = await createWireGuard({ ...options, transport: async () => { throw new Error('offline network failure'); } });
  await assert.rejects(first(ENDPOINT, request()), /offline network failure/);
  const reopened = await createWireGuard(options);
  await reopened(ENDPOINT, request()); await reopened(ENDPOINT, request());
  await assert.rejects(reopened(ENDPOINT, request()), /quota exhausted/);
  assert.equal(calls(), 2);
  for (const name of await readdir(options.directory)) {
    const content = await readFile(join(options.directory, name), 'utf8');
    assert(!content.includes('x-api-key') && !content.includes('fixture bytes'));
  }
}));

test('concurrent callers cannot exceed persisted quota', () => fixture(async ({ options, calls }) => {
  const guard = await createWireGuard(options);
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => guard(ENDPOINT, request())));
  assert(calls() > 0 && calls() <= 3);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, calls());
  assert.equal((await readdir(options.directory)).filter(n => n.startsWith('request-')).length, 3);
}));

test('upload, wrong session, unapproved image, huge output and text never reach transport', () => fixture(async ({ options, calls }) => {
  const guard = await createWireGuard(options);
  await assert.rejects(guard('https://api.deepseek.com/v1/files', request()), /endpoint/);
  await assert.rejects(guard(ENDPOINT, { ...request(), headers: {} }), /session/);
  await assert.rejects(guard(ENDPOINT, request({ max_tokens: 256000 })), /output/);
  await assert.rejects(guard(ENDPOINT, request({ system: 'a'.repeat(20000) })), /size/);
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('wrong').toString('base64') } };
  await assert.rejects(guard(ENDPOINT, request({ messages: [{ role: 'user', content: [image] }] })), /unapproved/);
  assert.equal(calls(), 0);
}));

test('native tool-result image history is admitted and hashed, never saved as base64', () => fixture(async ({ options, calls }) => {
  const guard = await createWireGuard(options);
  await guard(ENDPOINT, request({ messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'desktop_observe', input: { include_image: true } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') } }] }] },
  ] }));
  const ledger = JSON.parse(await readFile(join(options.directory, 'request-1.json'), 'utf8'));
  assert.deepEqual(ledger.image_hashes, [imageHash]); assert.equal(calls(), 1);
  assert.equal(ledger.monetary_bound_verified, false);
}));

test('closed approval, altered policy, corrupt ledger and pre-cancelled requests fail closed', () => fixture(async ({ options, calls, setApproval }) => {
  const guard = await createWireGuard(options);
  await assert.rejects(guard(ENDPOINT, { ...request(), signal: AbortSignal.abort() }));
  await assert.rejects(createWireGuard({ ...options, policy: { ...policy, maxRequests: 2 } }), /approval/);
  await writeFile(join(options.directory, 'request-1.json'), '{corrupt');
  await assert.rejects(guard(ENDPOINT, request()));
  setApproval({ approved: true, status: 'completed' });
  await assert.rejects(guard(ENDPOINT, request()), /approval/);
  assert.equal(calls(), 0);
}));

test('quota-only validation persists consumed requests without monetary fields', () => fixture(async ({ options, calls }) => {
  const { reserveMicroCny, budgetMicroCny, ...bounded } = policy;
  const boundedOptions = { ...options, policy: bounded, readApproval: async () => ({
    approved: true, status: 'active', trial_id: bounded.trialId, policy_sha256: validatePolicy(bounded) }) };
  const guard = await createWireGuard(boundedOptions);
  for (let i = 0; i < 3; i++) await guard(ENDPOINT, request());
  const reopened = await createWireGuard(boundedOptions);
  await assert.rejects(reopened(ENDPOINT, request()), /quota exhausted/);
  assert.equal(calls(), 3);
  const record = JSON.parse(await readFile(join(options.directory, 'request-1.json'), 'utf8'));
  assert.equal('reserved_micro_cny' in record, false);
  for (const patch of [{ maxRequests: 0 }, { maxRequests: 4 }, { maxOutputTokens: 1025 }, { budgetMicroCny: 1 }])
    assert.throws(() => validatePolicy({ ...bounded, ...patch }), /invalid policy/);
}));
