// Transport-boundary guard for an isolated worker. Never install a global fetch
// override in the shared Harness host. This module does not load credentials.
import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const ENDPOINT = 'https://api.deepseek.com/anthropic/v1/messages';
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = reason => { throw new Error(`DESKTOP_WIRE_GUARD: ${reason}`); };
const keys = (value, allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !allowed.includes(key))) fail('unexpected fields');
};
const integer = value => Number.isSafeInteger(value) && value > 0;
const canonical = value => JSON.stringify(value, Object.keys(value).sort());

export function validatePolicy(policy) {
  keys(policy, ['trialId', 'sessionId', 'maxRequests', 'maxOutputTokens', 'maxBodyBytes',
    'maxNonImageBytes', 'approvedImageHashes', 'reserveMicroCny', 'budgetMicroCny']);
  if (![policy.trialId, policy.sessionId].every(v => typeof v === 'string' && /^[\w-]{1,100}$/.test(v))
      || !['maxRequests', 'maxOutputTokens', 'maxBodyBytes', 'maxNonImageBytes'].every(k => integer(policy[k]))
      || policy.maxRequests > 3 || policy.maxOutputTokens > 1024
      || !Array.isArray(policy.approvedImageHashes) || policy.approvedImageHashes.length > 1
      || policy.approvedImageHashes.some(v => typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v))) fail('invalid policy');
  if (policy.reserveMicroCny !== undefined || policy.budgetMicroCny !== undefined) {
    if (!integer(policy.reserveMicroCny) || !integer(policy.budgetMicroCny)
        || !Number.isSafeInteger(policy.maxRequests * policy.reserveMicroCny)
        || policy.maxRequests * policy.reserveMicroCny > policy.budgetMicroCny) fail('invalid policy');
  }
  return hash(canonical(policy));
}

export function validateWire(url, init, policy) {
  if (String(url) !== ENDPOINT || init?.method !== 'POST' || init.redirect !== 'error'
      || typeof init.body !== 'string') fail('endpoint/method/body');
  if (new Headers(init.headers).get('x-deepseek-harness-session-id') !== policy.sessionId) fail('session');
  if (Buffer.byteLength(init.body) > policy.maxBodyBytes) fail('body size');
  const body = JSON.parse(init.body);
  keys(body, ['model', 'max_tokens', 'thinking', 'messages', 'stream', 'system', 'tools']);
  keys(body.thinking, ['type']);
  if (body.model !== 'deepseek-flash' || body.thinking.type !== 'disabled' || body.stream !== true
      || !integer(body.max_tokens) || body.max_tokens > policy.maxOutputTokens) fail('model/output');
  const tools = new Set(['desktop_monitors', 'desktop_observe']);
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length > 2) fail('tools');
    const seen = new Set();
    for (const tool of body.tools) {
      keys(tool, ['name', 'description', 'input_schema']);
      if (!tools.has(tool.name) || seen.has(tool.name) || typeof tool.description !== 'string'
          || !tool.input_schema || typeof tool.input_schema !== 'object') fail('tool definition');
      seen.add(tool.name);
    }
  }
  let images = 0;
  const imageHashes = [];
  const blocks = (list, role, depth = 0) => {
    if (typeof list === 'string') return;
    if (!Array.isArray(list) || depth > 2) fail('content');
    for (const block of list) {
      if (block?.type === 'text') {
        keys(block, ['type', 'text']);
        if (typeof block.text !== 'string') fail('text');
      } else if (block?.type === 'image' && role === 'user') {
        keys(block, ['type', 'source']); keys(block.source, ['type', 'media_type', 'data']);
        const source = block.source;
        if (source.type !== 'base64' || !['image/png', 'image/jpeg', 'image/webp'].includes(source.media_type)
            || typeof source.data !== 'string') fail('inline image');
        const bytes = Buffer.from(source.data, 'base64');
        if (bytes.toString('base64') !== source.data) fail('image encoding');
        const digest = hash(bytes);
        if (++images > 1 || !policy.approvedImageHashes.includes(digest)) fail('unapproved image');
        imageHashes.push(digest);
        // Only strip bytes after verifying them; keep every other field in the size check.
        source.data = '';
      } else if (block?.type === 'tool_use' && role === 'assistant' && depth === 0) {
        keys(block, ['type', 'id', 'name', 'input']);
        if (typeof block.id !== 'string' || !tools.has(block.name)
            || !block.input || typeof block.input !== 'object' || Array.isArray(block.input)) fail('tool use');
      } else if (block?.type === 'tool_result' && role === 'user' && depth === 0) {
        keys(block, ['type', 'tool_use_id', 'content', 'is_error']);
        if (typeof block.tool_use_id !== 'string'
            || (block.is_error !== undefined && typeof block.is_error !== 'boolean')) fail('tool result');
        blocks(block.content, role, depth + 1);
      } else fail('content block');
    }
  };
  if (body.system !== undefined) blocks(body.system, 'system');
  if (!Array.isArray(body.messages) || !body.messages.length) fail('messages');
  for (const message of body.messages) {
    keys(message, ['role', 'content']);
    if (!['user', 'assistant'].includes(message.role)) fail('role');
    blocks(message.content, message.role);
  }
  const nonImageBytes = Buffer.byteLength(JSON.stringify(body));
  if (nonImageBytes > policy.maxNonImageBytes) fail('non-image size');
  return { image_hashes: imageHashes, images, non_image_bytes: nonImageBytes, max_tokens: body.max_tokens };
}

async function exclusiveJson(path, value) {
  const file = await open(path, 'wx');
  try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); }
  finally { await file.close(); }
}

export async function createWireGuard({ directory, policy, readApproval, transport }) {
  // Snapshot the caller's values; changing an in-memory object cannot expand limits.
  policy = structuredClone(policy);
  const fingerprint = validatePolicy(policy);
  if (typeof readApproval !== 'function' || typeof transport !== 'function') fail('missing dependencies');
  const approvalCheck = async () => {
    const approval = await readApproval();
    if (approval?.approved !== true || approval.status !== 'active'
        || approval.policy_sha256 !== fingerprint || approval.trial_id !== policy.trialId) fail('approval inactive/mismatch');
  };
  await approvalCheck();
  await mkdir(directory, { recursive: true });
  const manifest = join(directory, 'policy.json');
  try { await exclusiveJson(manifest, { fingerprint, policy }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const saved = JSON.parse(await readFile(manifest, 'utf8'));
  if (saved.fingerprint !== fingerprint || validatePolicy(saved.policy) !== fingerprint) fail('ledger policy changed');
  return async (url, init) => {
    init?.signal?.throwIfAborted();
    // Clone headers as well as the body before any asynchronous wait.
    const request = { ...init, headers: new Headers(init?.headers) };
    const facts = validateWire(url, request, policy);
    await approvalCheck();
    let attempt;
    for (let slot = 1; slot <= policy.maxRequests; slot++) {
      const path = join(directory, `request-${slot}.json`);
      try {
        await exclusiveJson(path, { attempt: slot, policy_sha256: fingerprint,
          reserved_at: new Date().toISOString(), status: 'reserved_before_transport',
          ...(policy.reserveMicroCny === undefined ? {} : { reserved_micro_cny: policy.reserveMicroCny, monetary_bound_verified: false }), ...facts });
        attempt = slot; break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const previous = JSON.parse(await readFile(path, 'utf8'));
        if (previous.policy_sha256 !== fingerprint || previous.attempt !== slot
            || previous.reserved_micro_cny !== policy.reserveMicroCny) fail('invalid ledger');
      }
    }
    if (!attempt) fail('request quota exhausted');
    // Cancellations, transport failures, retries and crashes never refund a slot.
    await approvalCheck();
    request.signal?.throwIfAborted();
    return transport(ENDPOINT, request);
  };
}
