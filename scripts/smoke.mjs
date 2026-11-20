/**
 * 冒烟检查（不需要人操作，约 10 秒）。
 *
 * 覆盖两类"只有真跑才会炸"的问题：
 *   A. 静态检查：helper 必须纯 ASCII（PS 5.1 读无 BOM 的 UTF-8 会乱码）、
 *      工具 schema 里不能出现 required: false（会让整个插件加载失败）。
 *   B. 运行时检查：真的启动 UIA helper、真的遍历窗口、真的按名字找控件、验证缓存。
 *
 * 用法：
 *   node scripts/smoke.mjs                 # 自动挑一个在跑的应用
 *   node scripts/smoke.mjs --process EXCEL # 指定应用
 *
 * 退出码：0 全部通过；1 有失败；2 跳过（没有可用窗口）
 */
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {uiaFind, uiaListControls, uiaCapability, uiaShutdown} from '../dsh_orb_full_orig/dist/computer-use/uia-bridge.js';

const CANDIDATES = ['DeepSeek Harness', 'Code', 'msedge', 'WINWORD', 'EXCEL', 'QQ'];
const results = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function record(name, run, fallbackDetail = '') {
  try {
    const detail = run();
    results.push({name, ok: true, detail});
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    results.push({name, ok: false, detail: error.message});
    console.log(`  ✗ ${name} — ${error.message}`);
  }
}

// ── A. 静态检查 ─────────────────────────────────────────────────────────────
console.log('\n[静态检查]');

record('UIA helper 是纯 ASCII（PS 5.1 读无 BOM 的 UTF-8 会解析失败）', () => {
  const text = readFileSync('dsh_orb_full_orig/dist/computer-use/uia-helper.ps1', 'utf8');
  const bad = [...text].map(char => char.charCodeAt(0)).filter(code => code > 0x7f);
  assert(bad.length === 0, `发现 ${bad.length} 个非 ASCII 字符`);
  return `${text.length} 字符`;
});

record('工具 schema 里没有 required: false（会让插件整包加载失败）', () => {
  const files = [
    'dsh_orb_full_orig/dist/computer-use/index.js',
    'dsh_orb_full_orig/dist/computer-use/lasso-BVa38J49.js',
    'plugins/dsh-assistant-host/orb-companion.js',
  ];
  const hits = [];
  for (const file of files) {
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (line.trim().startsWith('//')) return;
      if (/required:\s*false/.test(line)) hits.push(`${file}:${index + 1}`);
    });
  }
  assert(hits.length === 0, `发现 required: false → ${hits.slice(0, 3).join(', ')}`);
  return `${files.length} 个文件`;
});

// ── B. 运行时检查 ───────────────────────────────────────────────────────────
function hwndOf(processName) {
  try {
    const script = `(Get-Process -Name '${processName}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).MainWindowHandle`;
    const raw = execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', script,
    ], {encoding: 'utf8'}).trim();
    return Number(raw) || 0;
  } catch {
    return 0;
  }
}

const wantedIndex = process.argv.indexOf('--process');
const wanted = wantedIndex >= 0 ? process.argv[wantedIndex + 1] : null;
const targets = wanted ? [wanted] : CANDIDATES;

let target = null;
for (const name of targets) {
  const hwnd = hwndOf(name);
  if (hwnd > 0) { target = {name, hwnd}; break; }
}

if (target === null) {
  console.log('\n[运行时检查] 跳过：没有找到任何在跑的目标应用（先打开 Word / Excel / VS Code / 浏览器任一）');
  uiaShutdown();
  console.log('\n结果：静态检查通过，运行时检查跳过');
  process.exit(2);
}

console.log(`\n[运行时检查] 目标：${target.name} (#${target.hwnd})`);

const startedAt = Date.now();
const first = await uiaListControls({app: target.name, hwnd: target.hwnd, limit: 60});
const firstMs = Date.now() - startedAt;

record('UIA helper 能启动并列出控件', () => {
  assert(first !== undefined, 'uiaListControls 返回 undefined（helper 没起来或该窗口没有 UIA 树）');
  assert(first.named > 0, '该窗口有 0 个有名控件（可能是 C 档应用，换 --process 再试）');
  return `named=${first.named} walk=${first.walkMs}ms 总耗时=${firstMs}ms`;
});

const secondStart = Date.now();
const second = await uiaListControls({app: target.name, hwnd: target.hwnd, limit: 10});
const secondMs = Date.now() - secondStart;

record('名字表缓存生效', () => {
  assert(second !== undefined, '第二次调用失败');
  assert(second.cached === true, '第二次没有命中缓存（TTL 10 分钟，除非刚重启）');
  assert(secondMs <= Math.max(50, firstMs), `缓存反而更慢：${firstMs}ms → ${secondMs}ms`);
  return `${firstMs}ms → ${secondMs}ms`;
});

const firstName = first.elements[0]?.name;
const found = firstName === undefined ? undefined : await uiaFind({hwnd: target.hwnd, name: firstName});

record('按名字能精确找到控件并拿到矩形', () => {
  assert(firstName !== undefined, '列表为空，无法验证');
  assert(found !== undefined, 'uiaFind 返回 undefined');
  assert(found.found !== false, `找不到 "${firstName}"`);
  assert(found.rect !== undefined, '找到了但没有可用矩形');
  assert(Number.isFinite(found.rect.x) && Number.isFinite(found.rect.y), '矩形不是有限数');
  return `${found.type} · ${found.name}`;
});

const capability = uiaCapability(target.name);
record('应用能力表有记录', () => {
  assert(capability !== undefined, '能力表里没有这个应用');
  return `tier ${capability.tier} · named ${capability.named}`;
});

uiaShutdown();

const failed = results.filter(item => item.ok === false);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
