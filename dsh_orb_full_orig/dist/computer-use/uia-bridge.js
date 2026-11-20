/**
 * UI Automation 桥：常驻一个 PowerShell 小工，按需问"这个点是什么控件"、"某个名字的元素在哪"。
 *
 * 为什么常驻：单次 `powershell -File` 启动要 300ms 以上，而每次点击都要问一次命中信息，
 * 那样点击会被拖慢一倍。常驻之后 ElementFromPoint 约 1ms、FindFirst 约 35ms（Word 实测）。
 *
 * 失败策略：任何异常都只让 UIA 这一路失效（返回 undefined），**绝不抛给点击路径** ——
 * 拿不到控件信息可以退化成窗口级描述，点不了事。
 */
import {spawn} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HELPER = fileURLToPath(new URL('./uia-helper.ps1', import.meta.url));
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const DEFAULT_TIMEOUT_MS = 1500;
const WALK_TIMEOUT_MS = 4000;
// 名字表按「应用 + 窗口句柄」缓存 10 分钟：UIA 树会随布局/弹窗变化，不能永久缓存；
// 但同一个窗口十分钟内反复列清单没意义。
const CONTROLS_TTL_MS = 10 * 60 * 1000;
const controlsCache = new Map();
const START_TIMEOUT_MS = 4000;

let child = null;
let ready = false;
let starting = null;
let nextId = 1;
const pending = new Map();
let buffer = '';
let exitHookInstalled = false;

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => { try { stop(); } catch { /* 退出路径上不再折腾 */ } });
}

function failAll(error) {
  for (const [, entry] of pending) entry.reject(error);
  pending.clear();
}

function handleLine(line) {
  if (line.trim().length === 0) return;
  let message = null;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const entry = pending.get(message.id);
  if (entry === undefined) return;
  pending.delete(message.id);
  clearTimeout(entry.timer);
  entry.resolve(message);
}

function stop() {
  ready = false;
  starting = null;
  if (child !== null) {
    try { child.kill(); } catch { /* 已经没了 */ }
    child = null;
  }
  failAll(new Error('uia helper stopped'));
}

function startChild() {
  installExitHook();
  const ps = spawn(POWERSHELL, ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', HELPER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child = ps;
  ps.stdout.setEncoding('utf8');
  ps.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      handleLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
    }
    if (!ready) {
      ready = true;
      starting = null;
    }
  });
  ps.stderr.setEncoding('utf8');
  ps.stderr.on('data', () => { /* 小工的报错走协议里的 ok:false，这里只是别让它堵住管道 */ });
  ps.on('exit', () => {
    if (child === ps) {
      child = null;
      ready = false;
      starting = null;
      failAll(new Error('uia helper exited'));
    }
  });
  ps.on('error', () => {
    if (child === ps) {
      child = null;
      ready = false;
      starting = null;
      failAll(new Error('uia helper failed to start'));
    }
  });
  return ps;
}

function ensureReady() {
  if (ready && child !== null) return Promise.resolve(true);
  if (starting !== null) return starting;
  if (!existsSync(HELPER)) return Promise.resolve(false);
  if (process.platform !== 'win32') return Promise.resolve(false);
  starting = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), START_TIMEOUT_MS);
    const ps = startChild();
    const check = setInterval(() => {
      if (ready) {
        clearInterval(check);
        clearTimeout(timer);
        resolve(true);
      }
    }, 40);
    check.unref?.();
    timer.unref?.();
    ps.once('exit', () => {
      clearInterval(check);
      clearTimeout(timer);
      resolve(false);
    });
  });
  return starting;
}

async function request(op, payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const ok = await ensureReady();
  if (!ok || child === null) return undefined;
  const id = nextId++;
  const line = JSON.stringify({id, op, ...payload});
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(undefined);
      // 超时说明小工卡住了，杀掉重启
      stop();
    }, timeoutMs);
    timer.unref?.();
    pending.set(id, {resolve, reject: () => resolve(undefined), timer});
    try {
      child.stdin.write(`${line}\n`);
    } catch {
      pending.delete(id);
      clearTimeout(timer);
      resolve(undefined);
      stop();
    }
  });
}

function infoOf(message) {
  if (message === undefined || message.ok !== true || message.element === null || message.element === undefined) return undefined;
  const el = message.element;
  const rect = Array.isArray(el.rect) && el.rect.length === 4 ? el.rect : null;
  return {
    name: el.name || '',
    type: el.type || '',
    class: el.class || '',
    aid: el.aid || '',
    rect: rect === null ? undefined : {x: rect[0], y: rect[1], width: rect[2], height: rect[3]},
    window: el.window || '',
  };
}

/** 这个全局物理点在什么控件上。 */
export async function uiaElementAt(x, y, timeoutMs) {
  const message = await request('elementAt', {x: Math.round(x), y: Math.round(y)}, timeoutMs);
  return infoOf(message);
}

/** 在某个窗口里按名字找元素；找不到时带回附近可点的名字。 */
export async function uiaFind({hwnd = 0, name, timeoutMs}) {
  const message = await request('find', {hwnd: Math.round(hwnd ?? 0), name}, timeoutMs);
  if (message === undefined) return undefined;
  if (message.ok === true) {
    const info = infoOf(message);
    return info === undefined ? undefined : {...info, found: true};
  }
  return {found: false, candidates: Array.isArray(message.candidates) ? message.candidates : []};
}

/**
 * 列出某个窗口里有名字的可点元素（Button/SplitButton/MenuItem/Edit/ListItem）。
 * 结果按 (app, hwnd) 缓存 10 分钟：缓存的是"名字表"，坐标由调用方每次重新查。
 */
export async function uiaListControls({app, hwnd = 0, filter = '', limit = 40}) {
  const key = `${app ?? '?'}::${Math.round(hwnd)}`;
  const cached = controlsCache.get(key);
  if (cached !== undefined && Date.now() - cached.at < CONTROLS_TTL_MS) {
    const elements = filter.length === 0 ? cached.elements : cached.elements.filter(item => item.name.includes(filter));
    return {elements: elements.slice(0, limit), named: cached.named, total: cached.total, walkMs: cached.walkMs, cached: true};
  }
  const message = await request('controls', {hwnd: Math.round(hwnd ?? 0), filter: '', limit: 500}, WALK_TIMEOUT_MS);
  if (message === undefined || message.ok !== true) return undefined;
  const elements = Array.isArray(message.elements) ? message.elements.map(item => ({
    name: item.name || '',
    type: item.type || '',
    class: item.class || '',
    aid: item.aid || '',
    rect: Array.isArray(item.rect) && item.rect.length === 4
      ? {x: item.rect[0], y: item.rect[1], width: item.rect[2], height: item.rect[3]}
      : undefined
  })) : [];
  const entry = {
    at: Date.now(),
    elements,
    named: message.named ?? elements.length,
    total: message.total ?? elements.length,
    walkMs: message.walkMs ?? 0
  };
  controlsCache.set(key, entry);
  await rememberCapability(app, entry);
  const filtered = filter.length === 0 ? elements : elements.filter(item => item.name.includes(filter));
  return {elements: filtered.slice(0, limit), named: entry.named, total: entry.total, walkMs: entry.walkMs, cached: false};
}

/** 只看缓存的名字表，不触发遍历（用于"探测会打断瞬态菜单"的场景）。 */
export function peekControls({app, hwnd = 0, limit = 24}) {
  const key = `${app ?? '?'}::${Math.round(hwnd)}`;
  const cached = controlsCache.get(key);
  if (cached === undefined || Date.now() - cached.at >= CONTROLS_TTL_MS) return undefined;
  return {elements: cached.elements.slice(0, limit), named: cached.named, total: cached.total, walkMs: cached.walkMs, cached: true};
}

/** 应用级能力表：记"这个软件有多少可点元素"，判断 A/B/C 档（持久化，跨会话）。 */
async function rememberCapability(app, entry) {
  if (typeof app !== 'string' || app.length === 0) return;
  try {
    const dir = join(homedir(), '.dsh', 'storages');
    const file = join(dir, 'uia-capabilities.json');
    let table = {};
    try { table = JSON.parse(await readFile(file, 'utf8')); } catch { table = {}; }
    const tier = entry.named === 0 ? 'C' : entry.named < 30 ? 'B' : 'A';
    table[app] = {named: entry.named, walkMs: entry.walkMs, tier, probedAt: new Date().toISOString()};
    await mkdir(dir, {recursive: true});
    await writeFile(file, JSON.stringify(table, null, 2) + '\n', 'utf8');
  } catch { /* 能力表写不进去不影响点击 */ }
}

/** 读应用能力表；没有记录时返回 undefined。 */
export function uiaCapability(app) {
  if (typeof app !== 'string' || app.length === 0) return undefined;
  try {
    const table = JSON.parse(readFileSync(join(homedir(), '.dsh', 'storages', 'uia-capabilities.json'), 'utf8'));
    return table[app];
  } catch {
    return undefined;
  }
}

/** 关掉小工（进程退出时用）。 */
export function uiaShutdown() {
  stop();
}

/** 小工是否已经在跑（诊断用）。 */
export function uiaRunning() {
  return ready && child !== null;
}
