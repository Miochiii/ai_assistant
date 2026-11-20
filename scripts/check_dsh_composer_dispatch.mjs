// Exercise the installed client's real method bodies, not a reimplementation
// of its decision table. Browser/session services are fixtures; no model/API.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { root } from '../plugins/dsh-desktop-observe/bridge.js';
import { sessionTrialCommand, sessionOfflineCommand } from '../plugins/dsh-desktop-observe/session-trial.js';
const sdkRoot = 'E:/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/';
const source = await readFile(sdkRoot + 'dsh-client-ui-commands/lib/client.js', 'utf8');
function method(name, async = false) {
  const start = source.indexOf(`\t\t\t${async ? 'async ' : ''}${name}(`);
  assert(start >= 0, `Installed client method missing: ${name}`);
  const end = source.indexOf('\n\t\t\t}', start);
  assert(end > start);
  return source.slice(start, end + '\n\t\t\t}'.length);
}
const client = vm.runInNewContext(`({${method('matchEnter', true)},${method('dispatch')},${method('leadingClaim')}})`);
const { Context } = await import(pathToFileURL(sdkRoot + 'cordis/lib/index.js'));
const { CommandRuntime } = await import(pathToFileURL(sdkRoot + 'dsh-commands/lib/index.js'));
const ctx = new Context(), runtime = new CommandRuntime(ctx);
const session = { sessionId: 'composer-fixture' };
const agent = { session: { header: { cwd: root, id: session.sessionId }, append: () => {} } };
const launched = [], pending = [];
const dependencies = { load: async () => { throw new Error('Paid plan must not be read'); },
  launch: async mode => { launched.push(mode); return { passed: true, message: 'fixture', report_path: 'fixture' }; } };
const disposers = [runtime.register(sessionTrialCommand(ctx, dependencies)), runtime.register(sessionOfflineCommand(ctx, dependencies))];
const descriptors = new Map(runtime.list(agent).map(d => [d.name, d]));
client.live = { contributions: new Map(), decorations: new Map() };
client.directory = { ensureReady: async () => [...descriptors.values()], resolve: (_id, name) => descriptors.get(name) };
client.consumeVia = () => {};
client.t = key => key;
client.execute = (_session, line, attachments = []) => runtime.execute(agent, line, attachments, new AbortController().signal);
client.runDetached = (_descriptor, target, line) => pending.push(client.execute(target, line));
try {
  // Reproduce the exact previous bug: no input descriptor => chat fallthrough.
  const current = descriptors.get('desktop-trial');
  const { input, ...old } = current;
  descriptors.set('desktop-trial', old);
  assert.equal(await client.matchEnter(session, '/desktop-trial offline', new AbortController().signal, { attachments: 0 }), undefined);
  assert.equal(launched.length, 0);
  descriptors.set('desktop-trial', current);
  // Legacy parameter form is now owned by the composer claim; submit it locally.
  const claimed = await client.matchEnter(session, '/desktop-trial offline', new AbortController().signal, { attachments: 0 });
  assert.equal(claimed.claim.name, 'desktop-trial');
  assert.equal((await claimed.claim.submit('offline', null, [])).result.kind, 'success');
  // New menu item and bare Enter both dispatch directly without argument parsing.
  assert.equal(client.dispatch({ candidate: { name: 'desktop-offline' }, session, span: { from: 0, to: 16 } }), 'handled');
  assert.equal(await client.matchEnter(session, '/desktop-offline', new AbortController().signal, { attachments: 0 }), 'handled');
  for (const result of await Promise.all(pending)) assert.equal(result.result.kind, 'success');
  assert.deepEqual(launched, ['offline', 'offline', 'offline']);
  await assert.rejects(client.matchEnter(session, '/desktop-trial offline', new AbortController().signal, { attachments: 1 }));
  const report = { checked_at: new Date().toISOString(), sdk: 'DSH 0.2.1-rc.2', plugin_version: '0.4.1',
    installed_client_source_sha256: createHash('sha256').update(source).digest('hex'),
    actual_client_methods: ['matchEnter', 'dispatch', 'leadingClaim'], native_command_catalog: true,
    previous_fallthrough_reproduced: true, legacy_input_claim_verified: true,
    offline_menu_and_bare_enter_handled: true, dispatched_modes: launched,
    browser_services_fixture: true, worker_fixture: true, actual_desktop_ui_tested: false,
    paid_model_requests: 0, new_screenshots: 0, gui_actions: 0, passed: true };
  await writeFile(join(root, 'results/a04/dsh-composer-dispatch.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { disposers.reverse().forEach(dispose => dispose()); await ctx.fiber.dispose(); }
