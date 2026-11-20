/**
 * character-card.js — Orb 的「角色卡」：一张用户可编辑的人设表，喂给 Orb 自己发起的调用。
 *
 * 为什么要有它：现在的人格散落在三处硬编码里（`companionVoice` / `COMPANION_SYSTEM` /
 * `panel-model.js` 现场拼的指导后缀），用户改了不知道改哪儿，改了也互相不一致。
 *
 * 边界（这一条必须写进每一次注入）：角色卡只决定**人设与语气**。
 * 输出格式、能力边界（陪伴没有工具、不能写记忆）、长度上限由宿主说了算 ——
 * 用户写"帮我点一下"时模型只会编，写多长就多长会把面板撑爆。
 *
 * 所以 `characterSystem()` 把卡放在前面、把一句固定边界放在后面、再带回模块原有的
 * system 全文。模块的硬约束永远在最后，因为模型对末尾更敏感。
 */

import {readFile, mkdir, writeFile, rename} from 'node:fs/promises';
import {dirname} from 'node:path';

/** 单段人设的字符上限。再长就是在拿 token 堆语气，而且会把模块约束挤到后面。 */
export const MAX_FIELD = 800;
/** 从全局人设插件抄过来的文本上限。它允许导入 64k 的卡，但每次陪伴都带一遍不划算。 */
export const MAX_EXTERNAL_CHARS = 4000;
/** 陪伴一句话的上限范围（字）。默认 30：一句话、一眼看完，弹幕不会跑成跑马灯。 */
export const MAX_COMPANION_CHARS = 120;
export const MIN_COMPANION_CHARS = 20;

export const DEFAULT_CHARACTER = Object.freeze({
  name: '鲸鱼',
  persona: '',
  guidancePersona: '',
  maxCompanionChars: 30,
});

const BOUNDARY = '角色卡只决定人设与语气；与下面的输出格式、能力边界冲突时，以下面的格式为准。';

/**
 * 进程内的"当前卡"。面板、陪伴、指导各在自己的模块里读这张卡；用模块级缓存而不是
 * 层层传参，是因为**保存发生在设置路由里、使用方在别处** —— 传参会漏，漏一处就是
 * "改了没生效"。所有使用者都走 `currentCharacter()`，永远读到最新的那张。
 */
let cached = {...DEFAULT_CHARACTER};

/**
 * 全局人设（dsh-persona-dafeiyu）里的"当前那一段"。
 *
 * 它注册在 `ctx.systemPrompt` 上，只覆盖经过 agent 的回合；Orb 自己的陪伴/指导是
 * `companionStream` 直传 system，绕开注册表。所以这里主动去它的 HTTP 桥把人设文本
 * 抄一份过来，让三条链路说的是同一个人 —— 否则就会出现"主会话是 A、陪伴是 B"。
 *
 * 抄不到（没装/没起/关了）就退回我们自己那张卡：人格读不到不该让陪伴起不来。
 */
let external = {text: '', name: '', id: null, at: 0};
let bridgeResolver = null;
let refreshTimer = null;

/** 桥的地址由宿主注入（`ctx.webServer.port`），不写死端口。可以是字符串，也可以是
 *  "每次现取"的函数 —— 宿主里 webServer 可能比本插件晚就绪，一次取不到不该永久失效。 */
export function configurePersonaSource(source) {
  bridgeResolver = typeof source === 'function'
    ? source
    : (typeof source === 'string' && source ? () => source : null);
  return bridgeResolver;
}

function bridgeBaseUrl() {
  if (!bridgeResolver) return null;
  try {
    const value = bridgeResolver();
    return typeof value === 'string' && value ? value.replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
}

export function externalPersona() {
  return external;
}

/**
 * 拉一次当前人设。**只认"插件启用 + 有当前人设 + 没全局静音"**，
 * 其余情况一律当没有 —— 否则用户关掉人格后，陪伴还会偷偷用旧文本。
 */
export async function refreshPersona({fetchImpl = fetch, timeoutMs = 2500, now = Date.now} = {}) {
  const base = bridgeBaseUrl();
  if (!base) return currentCharacter();
  try {
    const status = await fetchImpl(`${base}/api/dsh-persona-dafeiyu/status`, {signal: AbortSignal.timeout(timeoutMs)})
      .then(res => (res.ok ? res.json() : null));
    const value = status?.value;
    if (!value || value.enabled === false || value.active === false || value.globalOff === true || !value.current) {
      external = {text: '', name: '', id: null, at: now()};
      return currentCharacter();
    }
    const one = await fetchImpl(`${base}/api/dsh-persona-dafeiyu/persona?id=${encodeURIComponent(value.current)}`, {signal: AbortSignal.timeout(timeoutMs)})
      .then(res => (res.ok ? res.json() : null));
    const text = typeof one?.value?.text === 'string' ? one.value.text : '';
    external = {
      text: trim(text, MAX_EXTERNAL_CHARS),
      name: trim(one?.value?.name ?? value.currentName ?? '', 40),
      id: String(value.current),
      at: now(),
    };
  } catch {
    /* 插件没装、端口拿不到、桥挂了：保留上一次的结果，别把陪伴拖垮 */
  }
  return currentCharacter();
}

/** 定期刷新（默认 60 秒）。返回停止函数；定时器 unref，不挡宿主退出。 */
export function startPersonaRefresh({baseUrl, intervalMs = 60_000, fetchImpl = fetch} = {}) {
  if (baseUrl !== undefined) configurePersonaSource(baseUrl);
  void refreshPersona({fetchImpl}).catch(() => {});
  if (!refreshTimer) {
    refreshTimer = setInterval(() => { void refreshPersona({fetchImpl}).catch(() => {}); }, intervalMs);
    refreshTimer.unref?.();
  }
  return () => stopPersonaRefresh();
}

export function stopPersonaRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/**
 * 合并视图：我们的卡优先，空着就跟全局人设。
 *
 * `persona` 为空时**不带名字前缀** —— 人设文本自己会说"我叫什么"，再叠一句
 * 「你的名字是鲸鱼」就会和它对打（用户实报过"两个名字来回打架"）。
 */
export function mergedCharacter() {
  const own = cached;
  const persona = own.persona || external.text || '';
  return {
    ...own,
    persona,
    guidancePersona: own.guidancePersona || persona,
    name: own.persona ? own.name : '',
    externalName: external.name || '',
    externalId: external.id,
  };
}

export function currentCharacter() {
  return mergedCharacter();
}

export function setCharacter(card) {
  cached = validateCharacter(card);
  return currentCharacter();
}

export async function loadCharacter(path) {
  try {
    cached = await characterStore(path).read();
  } catch {
    /* 读不出来就用默认卡：人格读失败不该让陪伴起不来 */
  }
  return currentCharacter();
}

const trim = (value, max) => String(value ?? '').trim().slice(0, max);

export function validateCharacter(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('角色卡格式无效');
  const text = (key, fallback) => {
    const raw = value[key];
    if (raw === undefined || raw === null) return fallback;
    if (typeof raw !== 'string') throw new Error(`${key} 必须是文本`);
    return trim(raw, MAX_FIELD);
  };
  const limit = value.maxCompanionChars === undefined ? DEFAULT_CHARACTER.maxCompanionChars : Number(value.maxCompanionChars);
  if (!Number.isInteger(limit) || limit < MIN_COMPANION_CHARS || limit > MAX_COMPANION_CHARS) {
    throw new Error(`陪伴回复上限必须是 ${MIN_COMPANION_CHARS}–${MAX_COMPANION_CHARS} 的整数`);
  }
  return {
    name: trim(value.name ?? DEFAULT_CHARACTER.name, 24) || DEFAULT_CHARACTER.name,
    persona: text('persona', DEFAULT_CHARACTER.persona),
    guidancePersona: text('guidancePersona', DEFAULT_CHARACTER.guidancePersona),
    maxCompanionChars: limit,
  };
}

/** 串行 + 原子写：面板上连点保存不会写出半个文件。 */
export function characterStore(path) {
  let queue = Promise.resolve();
  return {
    async read() {
      try {
        return validateCharacter(JSON.parse(await readFile(path, 'utf8')));
      } catch (error) {
        if (error.code === 'ENOENT') return {...DEFAULT_CHARACTER};
        throw error;
      }
    },
    save(value) {
      const card = validateCharacter(value);
      const task = queue.then(async () => {
        await mkdir(dirname(path), {recursive: true});
        await writeFile(`${path}.tmp`, JSON.stringify(card, null, 2));
        await rename(`${path}.tmp`, path);
        return card;
      });
      queue = task.catch(() => {});
      return task;
    },
  };
}

/**
 * 拼一段可直接当 system 用的文本。
 *
 * `module: 'guidance'` 时优先用 `guidancePersona`（用户要求"指导单独"），空则继承全局。
 * 一个字都没有时**原样返回 base**，保证默认行为与加角色卡之前逐字节一致。
 */
export function characterSystem(card, {module = 'companion', base = ''} = {}) {
  const own = module === 'guidance'
    ? (card?.guidancePersona || card?.persona || '')
    : (card?.persona || '');
  const name = trim(card?.name, 24);
  // **没写人设就不注入**：默认卡必须与加角色卡之前逐字节一致，否则"什么都没填"
  // 也会悄悄改变提示词（名字单独出现对模型没有意义，容易变成无谓的 token）。
  if (!own) return base;
  const head = name ? `你的名字是${name}。${own}` : own;
  return `${head}\n\n${BOUNDARY}\n\n${base}`;
}

export function companionTextLimit(card) {
  const limit = Number(card?.maxCompanionChars);
  return Number.isInteger(limit) && limit >= MIN_COMPANION_CHARS && limit <= MAX_COMPANION_CHARS
    ? limit
    : DEFAULT_CHARACTER.maxCompanionChars;
}

/**
 * 超长就**按最后一个完整句子**截断；一个句号都没有（英文/口播碎片）才硬截并补省略号。
 *
 * 不按固定下标切：切在词中间比超长更难看，而且会把"…不是这个意思"截成"…不是这个意"。
 */
export function trimToSentence(text, limit) {
  const value = String(text ?? '').trim();
  const max = Number(limit);
  if (!Number.isInteger(max) || max <= 0 || value.length <= max) return value;
  const head = value.slice(0, max);
  const stops = ['。', '！', '？', '；', '!', '?', ';', '. '];
  let cut = -1;
  for (const stop of stops) {
    const at = head.lastIndexOf(stop);
    if (at > cut) cut = at + (stop === '. ' ? 1 : stop.length);
  }
  // 太靠前的句号（前 40% 以内）截出来只剩半句，宁可按上限硬切
  if (cut >= Math.floor(max * 0.4)) return head.slice(0, cut).trim();
  return `${head.slice(0, Math.max(1, max - 1)).trim()}…`;
}
