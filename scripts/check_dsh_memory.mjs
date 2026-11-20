// Offline schema/registry check for the memory host; no Python, model or desktop action.
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { apply, definitions } from '../plugins/dsh-desktop-observe/memory.js';
import { root } from '../plugins/dsh-desktop-observe/bridge.js';

const sdk = await import(pathToFileURL('E:/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js'));
const { Context } = await import(pathToFileURL('E:/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'));
const { CommandRuntime } = await import(pathToFileURL('E:/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-commands/lib/index.js'));

const ctx = new Context();
ctx.provide('systemPrompt', { tools: () => () => {}, section: () => () => {} });
const commands = new CommandRuntime(ctx);
const registry = new sdk.ToolRuntime(ctx);
const tools = definitions({ recall: async () => ({}), propose: async () => ({}),
  checkpoint: async () => ({}), resume: async () => ({}) });
const samples = {
  memory_recall: {},
  memory_propose: { kind: 'fact', key: 'example.key', content: 'example' },
  memory_checkpoint: { task_id: 't', goal: 'g', completed: [], next_step: 'n', blockers: [], status: 'in_progress' },
  memory_resume: { task_id: 't' },
};
for (const tool of tools) {
  sdk.assertObjectJsonSchema(tool.parameters);
  sdk.assertSupportedJsonSchema(tool.output.schema);
  const errors = sdk.validateJsonSchemaValue(tool.parameters, samples[tool.name] ?? {}, '');
  if (errors.length) throw new Error(`${tool.name}: ${JSON.stringify(errors)}`);
}
const dispose = apply(ctx, { enabled: true });
const mounted = registry.wireSchemas().knownNames;
if (!commands.find(undefined, 'memory')) throw new Error('Missing /memory command');
for (const tool of tools) if (!mounted.includes(tool.name)) throw new Error(`Missing native tool ${tool.name}`);
dispose();
if (commands.find(undefined, 'memory')) throw new Error('Command was not disposed');
for (const tool of tools) if (registry.get(tool.name)) throw new Error(`Disposal did not remove ${tool.name}`);
const report = {
  checked_against: 'DSH bundled 0.2.1-rc.2 tool schemas and native registry',
  tools: tools.map(tool => tool.name), schemas_valid: true,
  native_registry_mount_tested: true, command_registered: true,
  model_calls: 0, memory_cli_calls: 0, desktop_actions: 0,
};
await writeFile(join(root, 'results/memory/dsh-memory-contract.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
