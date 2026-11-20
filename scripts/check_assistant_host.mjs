import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { runOfflineCheck } from '../plugins/dsh-assistant-host/offline-check.js';

const root = join('runtime', 'assistant-host-check', `run-${Date.now()}`);
const report = await runOfflineCheck({ baseDir: root });
const evidenceDir = join('results', 'assistant-host');
await mkdir(evidenceDir, { recursive: true });
const path = join(evidenceDir, 'rh02-offline.json');
await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, evidence: path, root }, null, 2));
