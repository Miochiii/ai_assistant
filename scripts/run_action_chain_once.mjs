// Controlled live chain: prepare an action-ready Notepad observation, then
// optionally execute one real click through the fixed executor. Run --prepare
// first, inspect the PNG, then pass its path to --click.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { observeAction, root, windows } from '../plugins/dsh-desktop-observe/bridge.js';
import { createClicker } from '../plugins/dsh-desktop-observe/action.js';

const mode = process.argv[2];
const exec = { agent: { session: { header: { cwd: root, id: 'action-chain-live' } } },
  signal: new AbortController().signal };

if (mode === '--prepare') {
  const list = await windows({}, exec);
  const target = list.windows.find(window => /^Notepad$/i.test(window.class_name));
  if (!target) throw new Error('No visible Notepad window; open Notepad first');
  const [left, top, right, bottom] = target.rect;
  const width = Math.min(400, right - left - 10);
  const height = Math.min(300, bottom - top - 10);
  const observation = await observeAction({ hwnd: target.hwnd, region: [left + 5, top + 5, width, height] }, exec);
  const report = { mode: 'prepare', read_only: true, gui_actions: 0, window: target,
    observation_path: observation.observation_path, observation_id: observation.observation_id,
    capture_bounds: observation.capture_bounds, image: observation.image,
    expected_target: [22, 47] };
  console.log(JSON.stringify(report, null, 2));
} else if (mode === '--click' && process.argv[3]) {
  const observationPath = process.argv[3];
  const manifest = JSON.parse(await readFile(observationPath, 'utf8'));
  const clicker = createClicker({}, { policy: async () => ({ image_attachment_enabled: false }) });
  const result = await clicker({ observation: observationPath, label: '文件(F)', center: [22, 47],
    coordinate_space: 'image', expected: 'File menu opens' }, exec);
  const report = { mode: 'click', checked_at: new Date().toISOString(),
    observation_id: manifest.observation_id, observation_path: observationPath,
    target_image_pixels: result.target_image_pixels, screen_point: result.screen_point,
    ok: result.ok, error_code: result.error_code ?? null, outcome: result.outcome,
    gui_clicks_attempted: result.gui_clicks_attempted, input_events_sent: result.input_events_sent,
    input_delivery_observed: result.input_delivery_observed, cursor_after: result.cursor_after,
    after_observation_path: result.after_observation_path, after_image: result.after_image,
    post_action_delta: result.post_action_delta, after_image_attached: result.after_image_attached,
    task_success_verified: result.task_success_verified };
  const log = join(root, 'results', 'b02', 'single-click-20261025', 'action-chain-live.json');
  await writeFile(log, JSON.stringify({ ...report, log }, null, 2));
  console.log(JSON.stringify({ ...report, log }, null, 2));
} else {
  throw new Error('usage: node scripts/run_action_chain_once.mjs --prepare | --click <observation.json>');
}
