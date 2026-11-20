// Local contract check; importing the bridge never captures the desktop.
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { apply, definitions } from '../plugins/dsh-desktop-observe/index.js';
import { root, monitors, observe } from '../plugins/dsh-desktop-observe/bridge.js';

const sdk = await import(pathToFileURL('E:/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js'));
const tools = definitions();
const samples = { desktop_activate: { hwnd: 1 }, desktop_click: { observation: 'results/vision/example/observation.json', label: 'x', center: [0, 0] },
  desktop_scroll: { observation: 'results/vision/example/observation.json', label: 'x', center: [0, 0], notches: -1 },
  desktop_key: { observation: 'results/vision/example/observation.json', label: 'x', center: [0, 0], key: 'Left' },
  desktop_text: { observation: 'results/vision/example/observation.json', label: 'x', center: [0, 0], text: 'abc' },
  desktop_combo: { observation: 'results/vision/example/observation.json', label: 'x', center: [0, 0], combo: 'Ctrl+Left' },
  desktop_drag: { observation: 'results/vision/example/observation.json', label: 'x', start: [0, 0], end: [10, 10] },
  desktop_replay: { program_id: 'notepad-open-file-menu' } };
for (const tool of tools) {
  sdk.assertObjectJsonSchema(tool.parameters);
  sdk.assertSupportedJsonSchema(tool.output.schema);
  const errors = sdk.validateJsonSchemaValue(tool.parameters, samples[tool.name] ?? {}, '');
  if (errors.length) throw new Error(JSON.stringify(errors));
}
const { Context } = await import(pathToFileURL('E:/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'));
const ctx = new Context();
const { CommandRuntime } = await import(pathToFileURL('E:/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-commands/lib/index.js'));
const commands = new CommandRuntime(ctx);
// Stub only prompt registration: no agents, model routes, sessions or network.
ctx.provide('systemPrompt', { tools: () => () => {} });
const registry = new sdk.ToolRuntime(ctx);
const dispose = apply(ctx);
const mounted = registry.wireSchemas().knownNames;
if (!commands.find(undefined, 'desktop-check')) throw new Error('Missing local desktop-check command');
for (const tool of tools) {
  if (!mounted.includes(tool.name)) throw new Error(`Missing native tool ${tool.name}`);
}
dispose();
if (commands.find(undefined, 'desktop-check')) throw new Error('Command was not disposed');
for (const tool of tools) {
  if (registry.get(tool.name)) throw new Error(`Disposal did not remove ${tool.name}`);
}
const report = { checked_against: 'DSH bundled 0.2.1-rc.2 tool schemas and native registry', tools: tools.map(t => t.name),
  schemas_valid: true, model_calls: 0, native_registry_mount_tested: true,
  running_desktop_host_tested: false, prompt_registration_stubbed: true };
if (process.argv.includes('--capture')) {
  const exec = { agent: { session: { header: { cwd: root, id: 'offline-harness-bridge-smoke' } } },
    signal: new AbortController().signal };
  report.monitors = await monitors({}, exec);
  const regionOption = process.argv.find(value => value.startsWith('--region='));
  const region = regionOption?.slice('--region='.length).split(',').map(Number);
  const observation = await observe({ monitor: 1, ...(region ? { region } : {}) }, exec);
  report.capture = { run_id: observation.run_id, image: observation.image,
    capture_bounds: observation.capture_bounds, observation_path: observation.observation_path };
  const observeTool = tools.find(tool => tool.name === 'desktop_observe');
  const outputErrors = sdk.validateJsonSchemaValue(observeTool.output.schema, observation, '');
  if (outputErrors.length) throw new Error(JSON.stringify(outputErrors));
}
await writeFile(join(root, process.argv.includes('--capture') ? 'results/a04/dsh-observe-smoke.json' : 'results/a04/dsh-observe-contract.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
