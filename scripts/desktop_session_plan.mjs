import { readFile, realpath, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { root, evidencePath } from '../plugins/dsh-desktop-observe/bridge.js';

export const PLAN_PATH = join(root, 'configs', 'desktop-session-trial.json');
// Manually verified against official pricing on 2026-10-24. Expired snapshots
// must be reviewed again, not silently extended by a runtime clock.
export const PRICE = Object.freeze({ model: 'deepseek-flash', version: 'DeepSeek-V4.1-Flash-1017',
  contextTokensUpper: 1048576, inputMicroCnyPerToken: 2, outputMicroCnyPerToken: 8,
  checkedAt: '2026-10-24T10:15:00Z', validUntil: '2026-10-25T10:15:00Z',
  source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/' });
export function validateLimits(maxOutputTokens, maxRequests) {
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 1024
      || !Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 3) throw new Error('Invalid fixed trial limits');
}
export function reservation(maxOutputTokens, maxRequests) {
  validateLimits(maxOutputTokens, maxRequests);
  const perRequestMicroCny = PRICE.contextTokensUpper * PRICE.inputMicroCnyPerToken
    + maxOutputTokens * PRICE.outputMicroCnyPerToken;
  return { perRequestMicroCny, totalMicroCny: perRequestMicroCny * maxRequests,
    basis: 'entire_published_context_plus_output_at_peak_rates', price: PRICE };
}
export const planHash = plan => createHash('sha256').update(JSON.stringify(plan)).digest('hex');
export async function readPlan() { return JSON.parse(await readFile(PLAN_PATH, 'utf8')); }
export async function trialAlreadyStarted(plan) {
  if (!/^[\w-]{1,90}$/.test(plan.trial_id ?? '')) return false;
  try { await access(join(root, 'results', 'b01', plan.trial_id, 'run.lock')); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export function inspectPlan(plan, { now = Date.now(), parentSessionId, requireActive = true } = {}) {
  validateLimits(plan.max_output_tokens, plan.max_requests);
  const bounded = plan.authorization_mode === 'small_readonly_validation';
  const cost = bounded ? null : reservation(plan.max_output_tokens, plan.max_requests);
  const problems = [];
  if (plan.authorization_mode !== undefined && !bounded) problems.push('未知的验证授权模式');
  if (plan.schema_version !== 1 || !/^[\w-]{1,90}$/.test(plan.trial_id ?? '')) problems.push('试验标识无效');
  if (requireActive && (plan.approved !== true || plan.status !== 'active')) problems.push('尚未批准并启用本轮试验');
  if (bounded) {
    if (typeof plan.authorization_note !== 'string' || !plan.authorization_note.trim()) problems.push('缺少小规模验证授权记录');
  } else {
    if (plan.price_snapshot !== PRICE.checkedAt || now > Date.parse(PRICE.validUntil)) problems.push('价格依据需要重新核对');
    if (!Number.isSafeInteger(plan.budget_micro_cny) || plan.budget_micro_cny < cost.totalMicroCny)
      problems.push(`预算尚未覆盖保守预留 ¥${(cost.totalMicroCny / 1e6).toFixed(6)}`);
  }
  if (!Number.isFinite(Date.parse(plan.expires_at)) || Date.parse(plan.expires_at) <= now
      || Date.parse(plan.expires_at) > now + 30 * 60 * 1000) problems.push('需设置未来 30 分钟内的有效期');
  if (!plan.parent_session_id || (parentSessionId !== undefined && plan.parent_session_id !== parentSessionId)) problems.push('需绑定当前 Harness 会话');
  if (!/^[a-f0-9]{64}$/.test(plan.source_sha256 ?? '') || !plan.observation_path
      || plan.image_reviewed !== true) problems.push('缺少经确认的截图及哈希');
  if (plan.scope !== 'one-reviewed-image-readonly') problems.push('范围必须为单张已确认截图的只读识别');
  return { ready: problems.length === 0, problems, cost };
}

export async function loadReviewedObservation(plan) {
  const manifestPath = evidencePath(await realpath(evidencePath(plan.observation_path)));
  const observation = JSON.parse(await readFile(manifestPath, 'utf8'));
  const imagePath = evidencePath(await realpath(evidencePath(observation.image.path)));
  const digest = createHash('sha256').update(await readFile(imagePath)).digest('hex');
  if (digest !== plan.source_sha256 || observation.image.sha256 !== digest) throw new Error('Reviewed image hash mismatch');
  return observation;
}
