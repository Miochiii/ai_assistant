/**
 * 面板卡片的**渲染路径**测试（交接 03）。
 *
 * 为什么单独一份：client.js 只能由 DSH 启动时加载，改完不重启就看不到它渲染。
 * 这里把卡片那段源码切出来、用假 React 直接调用它，能抓住"少写一个变量""用了
 * 未定义的字段"这类错误 —— 这类错误只有真正渲染时才炸，语法检查看不见。
 *
 * 它证明的是渲染不抛错、文案与按钮状态符合三态规则；**不证明**真的连上了浏览器
 * 或真的启动了视频陪看（那要重启后实测）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source = readFileSync(new URL('../dsh_orb_full_orig/client.js', import.meta.url), 'utf8');
const START = source.indexOf('    /** 两个模块的名字。');
const END = source.indexOf('\n    function OrbSettingsSection()');
if (START < 0 || END < 0 || END <= START) throw new Error('companion card block not found in client.js');
const body = source.slice(START, END);

/** 极简元素构造：只要 tag/props/children，够走完整棵树。 */
const h = (tag, props, ...children) => ({tag, props: props ?? {}, children: children.flat(Infinity).filter(x => x !== null && x !== false && x !== undefined)});

function hooks(values) {
  const queue = [...values];
  return {
    useState: (init) => [queue.length ? queue.shift() : (typeof init === 'function' ? init() : init), () => {}],
    useEffect: () => {},
    useRef: (value) => ({current: value}),
  };
}

function make(React, request, extra = {}) {
  const factory = new Function('React', 'h', 'request', 'orbIcon', 'Toggle', 'document', 'window',
    `${body}\nreturn CompanionSettingsCard;`);
  return factory(React, h, request,
    () => null, () => null,
    {hidden: false, addEventListener() {}, removeEventListener() {}},
    {setInterval: () => 0, clearInterval() {}});
}

/** 收集整棵树里的文字，函数组件顺手展开。 */
function textOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const child of node) textOf(child, out); return out; }
  if (typeof node === 'function') return textOf(node(), out);
  for (const child of node.children ?? []) textOf(child, out);
  return out;
}

/** 按 tag 找按钮，返回「文案 → 是否禁用」。 */
function buttonsOf(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const child of node) buttonsOf(child, out); return out; }
  if (node.tag === 'button') out.push({text: textOf(node).join(''), disabled: node.props.disabled === true});
  for (const child of node.children ?? []) buttonsOf(child, out);
  return out;
}

const baseStatus = {
  ok: true, revision: 3, updatedAt: 1_700_000_000_000, selectedMode: 'video', runningMode: null,
  mismatch: false, sessionId: null, phase: 'stopped',
  bridge: {service: 'down', extension: 'none', fresh: false, ageMs: null, helloAgeMs: null},
  media: {title: null, positionSeconds: null, durationSeconds: null, confidence: 'unknown', paused: false, url: null},
  transcript: {source: null, phase: 'idle', ready: 0, fed: 0, inflight: null, lines: null},
  screen: {state: 'stopped', samples: null, calls: null, spoken: null, intervalSeconds: null, lookSeconds: null, speakSeconds: null, proactive: null, backoff: null, reason: ''},
  video: {available: true, loop: true, active: false, paused: null, segments: 0, spoken: 0, segment: null, reason: null},
  lastError: null, sources: {loop: 'module', bridge: 'file'},
};
const videoSettings = {mode: 'video', captureSeconds: 2, lookSeconds: 30, speakSeconds: 30, backoff: true, proactive: true};

test('首次渲染（设置和状态都还没回来）不抛错，并说明正在读取', () => {
  const React = hooks([null, null, null, '', false, '', '', '', '']);
  const Card = make(React, async () => {});
  const tree = Card();
  const text = textOf(tree).join(' ');
  assert.match(text, /正在读取设置…/);
  assert.match(text, /已保存：未选择/);
  assert.match(text, /正在读取状态…/);
});

test('视频模式：三态条、桥三层、四个按钮都在，且未启动时只能开始', () => {
  const React = hooks([videoSettings, videoSettings, baseStatus, '', false, '', '', '', '']);
  const Card = make(React, async () => {});
  const tree = Card();
  const text = textOf(tree).join(' ');
  assert.match(text, /已保存：视频陪看/);
  assert.match(text, /正在运行：未运行/);
  assert.match(text, /本机服务/);
  assert.match(text, /浏览器扩展/);
  assert.match(text, /等待播放信息/);
  assert.match(text, /对白来源/);
  const buttons = buttonsOf(tree);
  const start = buttons.find(b => b.text.includes('开始陪伴'));
  assert.ok(start, '要有开始按钮');
  assert.equal(start.disabled, false);
  const pause = buttons.find(b => b.text === '暂停');
  assert.equal(pause.disabled, true, '没在跑时暂停必须禁用');
  const stop = buttons.find(b => b.text === '停止');
  assert.equal(stop.disabled, true);
});

test('视频运行中：显示模块与阶段，暂停/停止可用、开始禁用', () => {
  const status = {...baseStatus, phase: 'running', runningMode: 'video', revision: 4,
    bridge: {service: 'up', extension: 'live', fresh: true, ageMs: 800, helloAgeMs: 800},
    media: {title: '测试片', positionSeconds: 754, durationSeconds: 3600, confidence: 'fresh', paused: false, url: 'u'},
    transcript: {source: 'subtitle', phase: 'ready', ready: 3, fed: 2, inflight: null, lines: 12},
    video: {...baseStatus.video, active: true}};
  const React = hooks([videoSettings, videoSettings, status, '', false, '', '', '', '']);
  const Card = make(React, async () => {});
  const tree = Card();
  const text = textOf(tree).join(' ');
  assert.match(text, /正在运行：视频陪看 · 运行中/);
  assert.match(text, /《测试片》 12:34 \/ 1:00:00/);
  assert.match(text, /站点字幕/);
  const buttons = buttonsOf(tree);
  assert.equal(buttons.find(b => b.text.includes('开始陪伴')).disabled, true);
  assert.equal(buttons.find(b => b.text === '暂停').disabled, false);
  assert.equal(buttons.find(b => b.text === '停止').disabled, false);
});

test('只改下拉框不保存：出现未保存标记，已保存不动，开始被禁用', () => {
  const screen = {...videoSettings, mode: 'screen'};
  const status = {...baseStatus, selectedMode: 'screen', phase: 'stopped'};
  const React = hooks([screen, {...screen, mode: 'video'}, status, '', false, '', '', '', '']);
  const Card = make(React, async () => {});
  const tree = Card();
  const text = textOf(tree).join(' ');
  assert.match(text, /已保存：屏幕陪伴/);
  assert.match(text, /未保存：改为视频陪看/);
  assert.match(text, /控制按钮作用于已保存的屏幕陪伴/);
  const buttons = buttonsOf(tree);
  assert.equal(buttons.find(b => b.text.includes('开始陪伴')).disabled, true, '有未保存修改时不能启动');
  const save = buttons.find(b => b.text === '保存设置');
  assert.equal(save.disabled, false);
});

test('保存按钮在没改动时显示已保存并禁用', () => {
  const React = hooks([videoSettings, videoSettings, baseStatus, '', false, '', '', '', '']);
  const Card = make(React, async () => {});
  const buttons = buttonsOf(Card());
  const save = buttons.find(b => b.text === '已保存');
  assert.ok(save, '没改动时保存按钮应显示“已保存”');
  assert.equal(save.disabled, true);
});

test('保存失败时错误显示在控件旁，且“已保存”标记不变', () => {
  const React = hooks([videoSettings, {...videoSettings, mode: 'screen'}, baseStatus, '', false, '', '', 'lookSeconds 必须为 10–180 的整数', '']);
  const Card = make(React, async () => {});
  const text = textOf(Card()).join(' ');
  assert.match(text, /保存失败：lookSeconds 必须为 10–180 的整数/);
  assert.match(text, /已保存：视频陪看/);
});

test('实际运行与已保存不一致时给出明确提示', () => {
  const screen = {...videoSettings, mode: 'screen'};
  const status = {...baseStatus, selectedMode: 'screen', runningMode: 'video', mismatch: true, phase: 'running'};
  const React = hooks([screen, screen, status, '', false, '', '', '', '']);
  const text = textOf(make(React, async () => {})()).join(' ');
  assert.match(text, /实际在运行的是视频陪看，与已保存的屏幕陪伴不一致/);
});

test('视频启动失败的原因显示在卡片里，不藏在折叠区', () => {
  const status = {...baseStatus, lastError: {code: 'video-not-started', text: '视频陪看没有启动：请确认浏览器正在播放视频、位置桥扩展已加载，然后重试。', at: 1}};
  const React = hooks([videoSettings, videoSettings, status, '', false, '', '', '', '']);
  const text = textOf(make(React, async () => {})()).join(' ');
  assert.match(text, /视频陪看没有启动/);
});

test('屏幕模式显示三个间隔与计数，不显示视频桥', () => {
  const screen = {...videoSettings, mode: 'screen'};
  const status = {...baseStatus, selectedMode: 'screen', phase: 'running', runningMode: 'screen',
    screen: {...baseStatus.screen, state: 'running', samples: 12, calls: 4, spoken: 3}};
  const React = hooks([screen, screen, status, '', false, '', '', '', '']);
  const text = textOf(make(React, async () => {})()).join(' ');
  assert.match(text, /本地采样间隔（秒）/);
  assert.match(text, /本次已采样 12 次 · 模型请求 4 次 · 发言 3 次/);
  assert.ok(!text.includes('本机服务'), '屏幕模式不该显示视频桥');
});
