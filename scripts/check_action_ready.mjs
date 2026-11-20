// Read-only chain check: list windows, create one action-ready observation,
// verify its binding/RGB baseline, then remove the temporary observation.
// No input, no image delivery, no model call.
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { observeAction, root, windows } from '../plugins/dsh-desktop-observe/bridge.js';
import { createClicker } from '../plugins/dsh-desktop-observe/action.js';

const exec = { agent: { session: { header: { cwd: root, id: 'action-ready-check' } } },
  signal: new AbortController().signal };
const list = await windows({}, exec);
const target = list.windows.find(window => /notepad/i.test(window.class_name))
  ?? list.windows.find(window => window.rect[2] - window.rect[0] > 200 && window.rect[3] - window.rect[1] > 150);
if (!target) throw new Error('No visible window is available for the read-only check');
const [left, top, right, bottom] = target.rect;
const width = Math.min(400, right - left - 10);
const height = Math.min(300, bottom - top - 10);
if (width <= 0 || height <= 0) throw new Error('Selected window is too small');
const observation = await observeAction({ hwnd: target.hwnd, region: [left + 5, top + 5, width, height] }, exec);
const folder = dirname(observation.observation_path);
const binding = JSON.parse(await readFile(join(folder, 'click-binding.json'), 'utf8'));
const manifest = JSON.parse(await readFile(observation.observation_path, 'utf8'));
let contractRequest;
const clicker = createClicker({}, {
  run: async request => { contractRequest = request;
    return { ok: true, outcome: 'contract_only', task_success_verified: false }; },
  policy: async () => ({ image_attachment_enabled: false }),
});
await clicker({ observation: observation.observation_path, label: '文件(F)', center: [22, 47],
  coordinate_space: 'image', expected: 'menu opens' }, exec);
const report = { checked_at: new Date().toISOString(), read_only: true, gui_actions: 0,
  window: { hwnd: target.hwnd, class_name: target.class_name },
  observation_path: observation.observation_path, action_ready: observation.action_ready === true,
  observation_id: manifest.observation_id, capture_bounds: manifest.capture_bounds,
  image: manifest.image, binding_source_sha256: binding.source_sha256,
  baseline_present: Boolean(binding.rgb_sha256),
  contract_request: contractRequest ? { observation: contractRequest.observation,
    target: contractRequest.target, action: contractRequest.action } : null,
  notice: observation.notice };
const log = join(root, 'results', 'b02', 'single-click-20261025', 'action-ready-check.json');
await writeFile(log, JSON.stringify({ ...report, temporary_observation_removed: true }, null, 2));
await rm(folder, { recursive: true, force: true });
console.log(JSON.stringify({ ...report, log, temporary_observation_removed: true }));
