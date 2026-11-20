/**
 * 小工具：按进程名找到窗口，再用 UIA 按名字找控件，输出 JSON。
 * 给 smoke-click.ps1 这类"没有 JS 运行时"的脚本用。
 *
 * 用法：
 *   node scripts/find-control.mjs --process notepad --name 关闭
 *   node scripts/find-control.mjs --process Weixin --list --limit 5
 *
 * 输出（stdout 一行 JSON）：
 *   {"ok":true,"hwnd":123,"rect":{"x":..,"y":..,"width":..,"height":..},"name":"关闭","type":"Button"}
 *   {"ok":false,"reason":"no-window" | "not-found" | "uia-unavailable","candidates":[...]}
 */
import {execFileSync} from 'node:child_process';
import {uiaFind, uiaListControls, uiaShutdown} from '../dsh_orb_full_orig/dist/computer-use/uia-bridge.js';

function parseArgs(argv) {
  const out = {process: null, name: null, list: false, limit: 20, hwnd: 0};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--process') out.process = argv[++i];
    else if (key === '--name') out.name = argv[++i];
    else if (key === '--list') out.list = true;
    else if (key === '--limit') out.limit = Number(argv[++i]) || 20;
    else if (key === '--hwnd') out.hwnd = Number(argv[++i]) || 0;
  }
  return out;
}

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

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const args = parseArgs(process.argv);
if (args.process === null && args.hwnd === 0) {
  print({ok: false, reason: 'missing --process or --hwnd'});
  process.exit(2);
}

const appName = args.process ?? 'hwnd-' + String(args.hwnd);
const hwnd = args.hwnd > 0 ? args.hwnd : hwndOf(args.process);
if (hwnd === 0) {
  print({ok: false, reason: 'no-window', process: args.process});
  uiaShutdown();
  process.exit(1);
}

if (args.list) {
  const listed = await uiaListControls({app: appName, hwnd, limit: args.limit});
  if (listed === undefined) {
    print({ok: false, reason: 'uia-unavailable', hwnd});
    uiaShutdown();
    process.exit(1);
  }
  print({ok: true, hwnd, named: listed.named, names: listed.elements.map(item => item.name)});
  uiaShutdown();
  process.exit(0);
}

if (args.name === null) {
  print({ok: false, reason: 'missing --name (or use --list)'});
  uiaShutdown();
  process.exit(2);
}

const found = await uiaFind({hwnd, name: args.name});
if (found === undefined) {
  print({ok: false, reason: 'uia-unavailable', hwnd});
  uiaShutdown();
  process.exit(1);
}
if (found.found === false || found.rect === undefined) {
  print({ok: false, reason: 'not-found', hwnd, name: args.name, candidates: (found.candidates ?? []).slice(0, 15)});
  uiaShutdown();
  process.exit(1);
}

print({ok: true, hwnd, name: found.name, type: found.type, rect: found.rect});
uiaShutdown();
process.exit(0);
