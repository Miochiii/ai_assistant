// Native command registry -> actual isolated worker -> native SDK -> local SSE.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from '../plugins/dsh-desktop-observe/bridge.js';
import { sessionTrialCommand, sessionOfflineCommand, launchSessionWorker } from '../plugins/dsh-desktop-observe/session-trial.js';
const sdk = async name => import(pathToFileURL(`E:/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/${name}/lib/index.js`));
const { Context } = await sdk('cordis');
const { CommandRuntime } = await sdk('dsh-commands');
const ctx = new Context();
const runtime = new CommandRuntime(ctx);
const events = [];
const agent = { session: { header: { cwd: root, id: 'offline-command-worker' }, append: (type, data) => events.push({ type, data }) } };
const dispose = runtime.register(sessionTrialCommand(ctx));
const disposeOffline = runtime.register(sessionOfflineCommand(ctx));
try {
  const cancellation = new AbortController();
  const cancelledWorker = launchSessionWorker('offline', 'cancelled-worker-fixture', cancellation.signal);
  cancellation.abort();
  await assert.rejects(cancelledWorker, /取消/);
  const cancelledReport = JSON.parse(await readFile(join(root, 'results/a04/dsh-session-worker-offline.json'), 'utf8'));
  assert.equal(cancelledReport.passed, false);
  assert.equal(cancelledReport.paid_model_requests, 0);
  assert.equal(cancelledReport.temporary_files_removed, true);
  assert(!(await readdir(join(root, 'results/vision'))).some(n => n.startsWith('tmp-session-worker-')));
  const status = await runtime.execute(agent, '/desktop-trial', [], new AbortController().signal);
  assert.equal(status.result.kind, 'success');
  const blocked = await runtime.execute(agent, '/desktop-trial run', [], new AbortController().signal);
  assert.equal(blocked.result.kind, 'error');
  const result = await runtime.execute(agent, '/desktop-offline', [], new AbortController().signal);
  assert.equal(result.result.kind, 'success', result.result.text);
  assert(result.result.text.includes('OFFLINE_NATIVE_WIRE_IMAGE_RECEIVED'));
  assert.equal(events.filter(e => e.type === 'command/done').length, 3);
  const report = { checked_at: new Date().toISOString(), passed: true, native_commands: true,
    actual_child_process: true, native_agent_loop_and_sdk: true, transport: 'local SSE',
    command: 'desktop-offline', unapproved_run_blocked: true, result_returned_to_command: true, cancellation_cleanup_verified: true,
    paid_model_requests: 0, new_screenshots: 0, gui_actions: 0, running_desktop_host_tested: false };
  await writeFile(join(root, 'results/a04/dsh-session-command-offline.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { disposeOffline(); dispose(); await ctx.fiber.dispose(); }
