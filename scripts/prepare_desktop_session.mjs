// Build a reviewable draft only. Never activates a plan or reads credentials.
import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { root, evidencePath } from '../plugins/dsh-desktop-observe/bridge.js';
import { PRICE, reservation } from './desktop_session_plan.mjs';

export function draftForObservation(observation, manifestPath, sessionId, now = Date.now(), { boundedValidation = false } = {}) {
  const captured = Date.parse(observation.captured_at);
  if (!Number.isFinite(captured) || captured > now || now - captured > 15 * 60 * 1000)
    throw new Error('Please prepare a fresh observation captured within 15 minutes');
  if (!boundedValidation && now > Date.parse(PRICE.validUntil)) throw new Error('Pricing snapshot expired; review official rates first');
  if (typeof sessionId !== 'string' || !/^[\w-]{1,100}$/.test(sessionId)) throw new Error('Invalid parent session');
  const bounds = observation.capture_bounds;
  if (observation.read_only !== true || observation.model_calls !== 0 || observation.image?.resized !== false
      || !bounds || ![bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isSafeInteger)
      || bounds.width < 1 || bounds.height < 1 || bounds.width !== observation.image.width
      || bounds.height !== observation.image.height || !/^[a-f0-9]{64}$/.test(observation.image.sha256))
    throw new Error('Invalid source observation');
  const cost = boundedValidation ? null : reservation(1024, 3);
  return {
    plan: { schema_version: 1, trial_id: `readonly-${randomUUID()}`, status: 'draft', approved: false,
      max_requests: 3, max_output_tokens: 1024,
      ...(boundedValidation ? { authorization_mode: 'small_readonly_validation', authorization_note: '' }
        : { budget_micro_cny: 0, price_snapshot: PRICE.checkedAt }),
      expires_at: null, parent_session_id: sessionId, observation_path: manifestPath,
      source_sha256: observation.image.sha256, image_reviewed: false, scope: 'one-reviewed-image-readonly' },
    review: { captured_at: observation.captured_at, image_path: observation.image.path,
      capture_bounds: bounds, source_sha256: observation.image.sha256,
      ...(cost ? { minimum_budget_cny: cost.totalMicroCny / 1e6, suggested_approval_cny: 6.4,
        expected_spend_cny: null, maximum_cost_basis: cost.basis } : {}),
      output_limit: 1024, attempts_including_retries: 3, new_screenshots_during_trial: 0,
      gui_actions: 0, needs_image_review: true, needs_user_budget_approval: !boundedValidation },
  };
}

export async function prepareDraft(manifestInput, sessionId, options = {}) {
  const manifestPath = evidencePath(await realpath(evidencePath(manifestInput)));
  const observation = JSON.parse(await readFile(manifestPath, 'utf8'));
  const imagePath = evidencePath(await realpath(evidencePath(observation.image.path)));
  const digest = createHash('sha256').update(await readFile(imagePath)).digest('hex');
  if (digest !== observation.image.sha256) throw new Error('Source image hash mismatch');
  const draft = draftForObservation(observation, manifestPath, sessionId, Date.now(), options);
  const directory = join(root, 'results', 'proposals', draft.plan.trial_id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'plan.json'), JSON.stringify(draft.plan, null, 2), { flag: 'wx' });
  await writeFile(join(directory, 'review.json'), JSON.stringify(draft.review, null, 2), { flag: 'wx' });
  return { directory, active_config_changed: false, api_calls: 0, ...draft.review };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (![2, 3].includes(args.length) || !args[0].startsWith('--observation=') || !args[1].startsWith('--session=')
      || (args.length === 3 && args[2] !== '--bounded-validation'))
    throw new Error('Usage: --observation=ABSOLUTE_MANIFEST --session=HARNESS_SESSION_ID [--bounded-validation]');
  console.log(JSON.stringify(await prepareDraft(args[0].slice(14), args[1].slice(10),
    { boundedValidation: args.includes('--bounded-validation') }), null, 2));
}
