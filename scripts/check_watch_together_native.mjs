import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {join} from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(join(root, 'runtime'), {recursive: true});
const isolated = await mkdtemp(join(root, 'runtime/watch-native-'));
process.env.DSH_HOME = isolated;
process.env.DSH_VIDEO_DEBUG = '1';
// Exercise the plugin's built-in compatibility path, as used by the linked install.
delete process.env.DSH_TOOLS_PATH;
globalThis.fetch = () => { throw new Error('Network disabled in native fixture'); };
const sdk = name => import(pathToFileURL(`E:/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/${name}/lib/index.js`));
const {Context} = await sdk('cordis');
const {SystemPrompt} = await sdk('dsh-system-prompt');
const {ToolRuntime} = await sdk('dsh-tools');
const ctx = new Context();
const routes = [];
let dispose;
try {
  new SystemPrompt(ctx, {includeHarnessIdentity: false, includeRuntimeContext: false});
  const runtime = new ToolRuntime(ctx);
  ctx.provide('webServer', {
    getOrigin: () => 'http://127.0.0.1:38471',
    register: route => { routes.push(route); return () => routes.splice(routes.indexOf(route), 1); },
  });
  const plugin = await import('../third_party/dsh-watch-together/src/index.js');
  dispose = await plugin.apply(ctx);
  for (let i = 0; i < 50 && !runtime.get('watch_together_settings'); i++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert(runtime.get('watch_together'), 'Native watch tool missing');
  assert(runtime.get('watch_together_settings'), 'Native settings tool missing');
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, '/dsh-watch-together/settings');
  dispose(); dispose = undefined;
  assert(!runtime.get('watch_together'), 'Tool leaked after unload');
  assert(!runtime.get('watch_together_settings'), 'Settings tool leaked after unload');
  assert.equal(routes.length, 0);
  const report = {passed: true, native_sdk: true, linked_compatibility_registration: true,
    watch_tool: true, settings_tool: true, settings_route: true, unload: true,
    paid_requests: 0, browser_extension_verified: false, live_video_verified: false};
  await mkdir(join(root, 'results/watch'), {recursive: true});
  await writeFile(join(root, 'results/watch/watch-together-native.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  dispose?.();
  await ctx.fiber.dispose();
  await rm(isolated, {recursive: true, force: true});
}
