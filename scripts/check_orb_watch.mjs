import assert from 'node:assert/strict';
import {mkdtemp, rm, mkdir, readFile, writeFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {OrbWatch, createWatchCapture} from '../plugins/dsh-assistant-host/orb-watch.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(join(root, 'runtime/watch-smoke-'));
const watch = new OrbWatch({root: temp, capture: createWatchCapture(root), startDelayMs: 60000});
try {
  // Actual local screenshot, not a model request or mouse/keyboard action.
  await watch.start('local-smoke'); await watch.tick(); await watch.stop();
  assert.equal(watch.run.samples, 1, watch.run.error); assert.equal(watch.run.frames.length, 1);
  assert.equal(watch.run.reason, '用户停止');
  assert.deepEqual(await readdir(join(watch.run.directory, 'scratch')), []);
  const png = await readFile(join(watch.run.directory, watch.run.frames[0].file));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  const report = {passed: true, real_local_capture: true, scratch_clean: true,
    width: watch.run.frames[0].width, height: watch.run.frames[0].height,
    paid_requests: 0, input_events: 0, live_orb_ui: false, screenshot_retained: false};
  await mkdir(join(root, 'results/watch'), {recursive: true});
  await writeFile(join(root, 'results/watch/local-capture.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await watch.dispose();
  // mkdtemp-owned path only; no user captures under runtime/watch are touched.
  await rm(temp, {recursive: true, force: true});
}
