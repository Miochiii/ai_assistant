/**
 * Build a PreAct-shaped draft program from a verified exploration sequence.
 *
 * This deliberately produces verification.status="draft", not "verified":
 * the real PreAct inventory requires a fresh-observation replay, runs and a
 * content-bound proof before save_program accepts it. No coordinates are put
 * into `action`; visual_basis keeps the evidence target for re-localization.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const PROGRAM_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function validateBasis(step, index) {
  const evidence = step.evidence;
  if (!evidence || typeof evidence !== 'object') throw new Error(`step ${index + 1} evidence is required`);
  const observationId = requireString(evidence.observation_id, `step ${index + 1} evidence.observation_id`);
  const imageSha = requireString(evidence.image_sha256, `step ${index + 1} evidence.image_sha256`).toLowerCase();
  if (!SHA256.test(imageSha)) throw new Error(`step ${index + 1} image_sha256 is invalid`);
  const bounds = evidence.capture_bounds;
  if (!bounds || !['left', 'top', 'width', 'height'].every(k => Number.isSafeInteger(bounds[k]))
      || bounds.width <= 0 || bounds.height <= 0) {
    throw new Error(`step ${index + 1} capture_bounds is invalid`);
  }
  const center = evidence.target_center;
  if (!Array.isArray(center) || center.length !== 2
      || !center.every(Number.isSafeInteger) || center[0] < 0 || center[1] < 0) {
    throw new Error(`step ${index + 1} target_center is invalid`);
  }
  return {
    observation_id: observationId,
    image_sha256: imageSha,
    capture_bounds: {
      left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height,
    },
    target_center: [center[0], center[1]],
  };
}

export function buildProgramDraft({
  programId = `explore-${randomUUID().slice(0, 8)}`,
  version = 1,
  task,
  executorVersion = 'unknown',
  steps,
  window = null,
  createdAt = new Date().toISOString(),
} = {}) {
  if (!PROGRAM_ID.test(programId)) throw new Error('programId is invalid');
  if (!Number.isSafeInteger(version) || version < 1 || version > 100000) {
    throw new Error('version is invalid');
  }
  requireString(task, 'task');
  requireString(executorVersion, 'executorVersion');
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('steps must be non-empty');
  const preconditions = window ? {
    window: Object.fromEntries(Object.entries(window).filter(([key]) =>
      ['hwnd', 'class_name', 'title', 'process_name'].includes(key) && window[key] !== undefined)),
  } : {};
  const programSteps = steps.map((step, index) => {
    const targetLabel = requireString(step.target_label ?? step.evidence?.target_label,
      `step ${index + 1} target_label`);
    const action = {
      type: 'click',
      target_label: targetLabel,
    };
    for (const forbidden of ['center', 'screen_point', 'point', 'x', 'y']) {
      if (forbidden in (step.action ?? {})) throw new Error('action must not contain reusable coordinates');
    }
    return {
      step_id: step.step_id ?? `step-${index + 1}`,
      target_label: targetLabel,
      visual_basis: validateBasis(step, index),
      preconditions,
      action,
      expected: {
        ...(step.expected && typeof step.expected === 'object' ? step.expected : {}),
        description: requireString(step.expected?.description ?? step.intent,
          `step ${index + 1} expected.description`),
      },
      verification: {
        status: step.verification?.status === 'passed' ? 'passed' : 'unknown',
      },
    };
  });
  return {
    schema_version: 1,
    program_id: programId,
    program_version: version,
    task,
    executor_version: executorVersion,
    steps: programSteps,
    verification: {
      status: 'draft',
      note: 'Draft only. A fresh-observation replay and proof are required before PreAct inventory save.',
      created_at: createdAt,
    },
    created_at: createdAt,
  };
}

export async function writeProgramDraft(root, draft) {
  if (!draft || draft.verification?.status !== 'draft') {
    throw new Error('only draft programs can be written as drafts');
  }
  if (!PROGRAM_ID.test(draft.program_id ?? '')) throw new Error('invalid program id');
  const dir = resolve(root, 'runtime', 'program-drafts', draft.program_id);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `v${draft.program_version}.json`);
  await writeFile(path, `${JSON.stringify(draft, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return path;
}

export function draftDigest(draft) {
  return createHash('sha256').update(JSON.stringify(draft)).digest('hex');
}
