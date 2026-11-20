/**
 * Local RH03 demo: one Node Host + one Python resident panel.
 * No model/API, no screen capture and no desktop input.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { UiChannel } from '../plugins/dsh-assistant-host/ui-channel.js';
import { ResidentHost } from '../plugins/dsh-assistant-host/resident-host.js';
import { startResidentUi } from '../plugins/dsh-assistant-host/ui-process.js';

const rootArg = process.argv[2];
const root = rootArg && !rootArg.startsWith('--')
  ? rootArg
  : join('runtime', 'assistant-ui-demo', `demo-${Date.now()}`);
await mkdir(root, { recursive: true });
const assistantSessionId = `instance-${randomUUID()}`;
const channel = new UiChannel(root, { assistantSessionId });
const host = new ResidentHost({ channel });
host.initialize();
let ui = null;
let timer = null;
let stopping = false;

async function stop() {
  if (stopping) return;
  stopping = true;
  if (timer) clearInterval(timer);
  host.close();
  if (ui) await ui.stop();
}

try {
  ui = await startResidentUi({
    channelDir: root,
    assistantSessionId,
    timeoutMs: 8000,
    noSound: true,
    excludeCapture: process.argv.includes('--exclude-capture'),
  });
  await writeFile(join(root, 'demo.json'), JSON.stringify({
    assistant_session_id: assistantSessionId,
    host_pid: process.pid,
    ui_pid: ui.child.pid,
    exclude_capture: process.argv.includes('--exclude-capture'),
    started_at: new Date().toISOString(),
  }, null, 2));
  console.log(JSON.stringify({ ready: true, channel: root, assistant_session_id: assistantSessionId,
    host_pid: process.pid, ui_pid: ui.child.pid }));
  timer = setInterval(async () => {
    if (stopping) return;
    try {
      await host.poll();
      const state = channel.readState();
      if (state?.assistant === 'closed') {
        await stop();
        process.exit(0);
      }
    } catch (error) {
      console.error(error);
      await stop();
    }
  }, 150);
  process.once('SIGINT', () => { stop().finally(() => process.exit(0)); });
  process.once('SIGTERM', () => { stop().finally(() => process.exit(0)); });
  // Keep the demo process alive until SIGINT/SIGTERM or close event.
  await new Promise(() => {});
} catch (error) {
  await stop();
  console.error(error);
  process.exitCode = 1;
}
