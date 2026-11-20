import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const ENDPOINT = 'https://api.deepseek.com/anthropic/v1/messages';
export const REQUEST_RESERVE_CNY = 0.072768; // 20k input at 2 + 4096 output at 8, per million.

export function validateRequest(url, init, expectedImageHash) {
  if (String(url) !== ENDPOINT || init?.method !== 'POST' || init.redirect !== 'error') throw new Error('Trial endpoint/method rejected');
  const body = JSON.parse(init.body);
  if (Object.keys(body).some(k => !['model', 'max_tokens', 'thinking', 'messages', 'stream', 'system'].includes(k))) throw new Error('Unexpected request fields');
  if (body.model !== 'deepseek-flash' || !Number.isSafeInteger(body.max_tokens)
      || body.max_tokens < 1 || body.max_tokens > 4096 || body.thinking?.type !== 'disabled'
      || body.stream !== true) throw new Error('Trial model/output limit rejected');
  if (!Array.isArray(body.messages) || body.messages.length !== 1 || body.messages[0].role !== 'user'
      || !Array.isArray(body.messages[0].content)) throw new Error('Trial must contain one isolated user message');
  let images = 0;
  let textBytes = Buffer.byteLength(JSON.stringify(body.system ?? ''));
  for (const block of body.messages[0].content) {
    if (block.type === 'text' && typeof block.text === 'string') textBytes += Buffer.byteLength(block.text);
    else if (block.type === 'image' && block.source?.type === 'base64') {
      images++;
      const data = Buffer.from(block.source.data, 'base64');
      if (createHash('sha256').update(data).digest('hex') !== expectedImageHash) throw new Error('Unapproved image bytes');
    } else throw new Error('Unexpected content in trial');
  }
  // Far below the reserved 20k input: <=8192 text bytes, <=1024 native image tokens,
  // plus serialization overhead. No history, tools, server tools or extensions are admitted.
  if (images !== 1 || textBytes > 8192) throw new Error('Trial image/text limits exceeded');
  return { text_bytes: textBytes, images, max_tokens: body.max_tokens, request_reserve_cny: REQUEST_RESERVE_CNY };
}

export async function reserveRequest(directory, approval, facts) {
  if (approval.approved !== true || approval.status === 'completed' || approval.trial_id !== 'flash-readonly-20261023'
      || approval.max_requests !== 3 || approval.max_budget_cny !== 0.5
      || approval.max_output_tokens !== 4096 || approval.max_input_tokens_reserved !== 20000
      || 3 * REQUEST_RESERVE_CNY > approval.max_budget_cny) throw new Error('Trial approval does not match fixed limits');
  await mkdir(directory, { recursive: true });
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await writeFile(join(directory, `request-${attempt}.json`), JSON.stringify({
        attempt, reserved_at: new Date().toISOString(), ...facts,
        reserved_cny: REQUEST_RESERVE_CNY, status: 'reserved_before_transport',
      }, null, 2), { flag: 'wx' });
      return attempt;
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw new Error('Three-request trial quota exhausted; no further request is allowed');
}
