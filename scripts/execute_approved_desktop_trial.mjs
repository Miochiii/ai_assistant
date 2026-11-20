// Exercise the same isolated worker launcher used by the Harness command.
// This CLI entry is recorded separately from a live host UI invocation.
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from '../plugins/dsh-desktop-observe/bridge.js';
import { launchSessionWorker } from '../plugins/dsh-desktop-observe/session-trial.js';
import { readPlan, inspectPlan, trialAlreadyStarted } from './desktop_session_plan.mjs';
const plan = await readPlan();
if (!inspectPlan(plan, { parentSessionId: plan.parent_session_id }).ready || await trialAlreadyStarted(plan))
  throw new Error('No active unused approved trial');
const directory = join(root, 'results', 'b01', plan.trial_id);
await mkdir(directory, { recursive: true });
await writeFile(join(directory, 'launcher.json'), JSON.stringify({
  invoked_at: new Date().toISOString(), entry: 'codex-cli-via-plugin-worker-launcher',
  live_host_online_command_invoked: false, approved_parent_session_id: plan.parent_session_id,
  reason: 'Execute the approved read-only trial without desktop input; live command launch was verified offline separately',
}, null, 2), { flag: 'wx' });
const result = await launchSessionWorker('run', plan.parent_session_id, AbortSignal.timeout(110000));
console.log(JSON.stringify(result));
if (!result.passed) process.exitCode = 1;
