// Local UI fixture. No screenshots, memory writes or model calls.
import { PanelSession } from '../plugins/dsh-assistant-host/panel-session.js';
import { join } from 'node:path';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const smoke = process.argv.includes('--smoke');
const parent = join(process.cwd(), 'runtime', 'orb-tests');
await mkdir(parent, { recursive: true });
const root = await mkdtemp(join(parent, 'preview-'));
if (smoke) await writeFile(join(root, 'offline-fixture'), 'no-model');
const panel = new PanelSession({ sessionId: 'orb-preview', root, diagnostics: true,
  ...(smoke ? { panelPath: join(process.cwd(), 'scripts', 'orb-ui-smoke.cjs') } : {}),
  model: { async complete({ text }) { return { text: '收到“' + text + '”。这是离线界面测试。' }; } } });
try {
  console.log(await panel.open());
  panel.publish('悬停展开，点击固定，拖动悬浮球可以移动位置。');
  if (smoke) {
    let result;
    for (let i = 0; i < 150; i++) {
      try { result = JSON.parse(await readFile(join(root, 'smoke-result.json'), 'utf8')); break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    console.log(result);
    assert.equal(result?.ok, true, result?.error ?? 'UI smoke timed out');
  } else {
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 180000);
    process.on('SIGINT', () => { clearTimeout(timer); resolve(); });
  });
  }
} finally {
  await panel.close();
  await rm(root, { recursive: true, force: true });
}
