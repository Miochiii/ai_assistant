/**
 * 角色卡：校验、注入顺序、长度截断。
 *
 * 这些用例守的是三条不能破的约定：
 *   1. 一个字都没填时，system 与加角色卡之前**逐字节相同**（默认行为不变）；
 *   2. 角色卡永远在模块硬约束**前面**，边界句夹在中间；
 *   3. 陪伴的字数上限按完整句子截，不切在词中间。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
  DEFAULT_CHARACTER, MAX_COMPANION_CHARS, characterStore, characterSystem,
  companionTextLimit, trimToSentence, validateCharacter,
} from '../plugins/dsh-assistant-host/character-card.js';

test('默认卡：30 字、空人设', () => {
  assert.equal(DEFAULT_CHARACTER.maxCompanionChars, 30);
  assert.equal(DEFAULT_CHARACTER.persona, '');
});

test('人设为空时 system 原样返回（不改变现有行为）', () => {
  const base = '你是常驻桌面的鲸鱼助手。只输出 JSON。';
  assert.equal(characterSystem(DEFAULT_CHARACTER, {module: 'companion', base}), base);
  assert.equal(characterSystem(null, {module: 'guidance', base}), base);
});

test('角色卡在硬约束前面，边界句夹在中间', () => {
  const base = '只输出 JSON：{"speak":true,"text":"..."}';
  const system = characterSystem({name: '鲸鱼', persona: '说话像朋友。', maxCompanionChars: 60}, {module: 'companion', base});
  const cardAt = system.indexOf('说话像朋友');
  const boundaryAt = system.indexOf('角色卡只决定人设与语气');
  const baseAt = system.indexOf('只输出 JSON');
  assert.ok(cardAt >= 0 && boundaryAt > cardAt && baseAt > boundaryAt, system);
  assert.match(system, /你的名字是鲸鱼/);
});

test('指导单独人设优先；留空则继承全局', () => {
  const card = {name: '鲸鱼', persona: '全局语气', guidancePersona: '指导语气', maxCompanionChars: 60};
  assert.match(characterSystem(card, {module: 'guidance', base: 'B'}), /指导语气/);
  assert.doesNotMatch(characterSystem(card, {module: 'guidance', base: 'B'}), /全局语气/);
  const inherit = {...card, guidancePersona: ''};
  assert.match(characterSystem(inherit, {module: 'guidance', base: 'B'}), /全局语气/);
  assert.match(characterSystem(card, {module: 'panel', base: 'B'}), /全局语气/);
});

test('校验：范围与类型', () => {
  assert.equal(validateCharacter({maxCompanionChars: 20}).maxCompanionChars, 20);
  assert.equal(validateCharacter({maxCompanionChars: MAX_COMPANION_CHARS}).maxCompanionChars, MAX_COMPANION_CHARS);
  assert.throws(() => validateCharacter({maxCompanionChars: 19}), /20–120/);
  assert.throws(() => validateCharacter({maxCompanionChars: 121}), /20–120/);
  assert.throws(() => validateCharacter({persona: 123}), /必须是文本/);
  assert.throws(() => validateCharacter(null), /格式无效/);
  assert.equal(validateCharacter({persona: 'x'.repeat(2000)}).persona.length, 800);
});

test('陪伴 60 字：按最后一个完整句子截断', () => {
  const long = '第一句在这里。第二句也在。第三句写得比较长，一直写到超过六十个字的位置还要继续写下去看看会怎么样。';
  const cut = trimToSentence(long, 60);
  assert.ok(cut.length <= 60, `截断后 ${cut.length} 字`);
  assert.ok(cut.endsWith('。'), `应在句号处收尾：${cut}`);
  assert.equal(trimToSentence('短句。', 60), '短句。');
});

test('没有句读时硬截并补省略号', () => {
  const text = '这是一个没有标点的超长句子需要在边界处截断而不是保留全部内容继续往后写下去';
  const cut = trimToSentence(text, 20);
  assert.equal(cut.length, 20);
  assert.ok(cut.endsWith('…'), cut);
});

test('正文不足上限时一个字都不改', () => {
  assert.equal(trimToSentence('刚好一句话。', 60), '刚好一句话。');
  assert.equal(companionTextLimit({maxCompanionChars: 80}), 80);
  assert.equal(companionTextLimit({}), 30);
  assert.equal(companionTextLimit({maxCompanionChars: 999}), 30, '非法值退回默认，不能变成"不截断"');
});

test('全局人设：留空时自动跟随 dsh-persona-dafeiyu 的当前人设', async t => {
  const hooks = await import('../plugins/dsh-assistant-host/character-card.js');
  t.after(() => hooks.stopPersonaRefresh());
  hooks.configurePersonaSource('http://127.0.0.1:38471/');
  const fake = async url => (url.includes('/status')
    ? {ok: true, json: async () => ({value: {enabled: true, active: true, globalOff: false, current: 'dafeiyu', currentName: '大肥鱼'}})}
    : {ok: true, json: async () => ({value: {text: '# 人设：大肥鱼\n本鱼是大肥鱼。', name: '大肥鱼'}})});
  await hooks.refreshPersona({fetchImpl: fake});
  const card = hooks.currentCharacter();
  assert.equal(card.externalId, 'dafeiyu');
  assert.match(card.persona, /大肥鱼/);
  // 人设文本自己会说名字，不能再叠一句「你的名字是鲸鱼」，否则两个名字打架
  const system = hooks.characterSystem(card, {module: 'companion', base: 'BASE'});
  assert.doesNotMatch(system, /你的名字是/);
  assert.ok(system.endsWith('BASE'));
});

test('我们自己写了人设时优先用它（并带上名字）', async t => {
  const hooks = await import('../plugins/dsh-assistant-host/character-card.js');
  t.after(() => hooks.stopPersonaRefresh());
  hooks.setCharacter({name: '小晴', persona: '本机人设', guidancePersona: '', maxCompanionChars: 60});
  const system = hooks.characterSystem(hooks.currentCharacter(), {module: 'companion', base: 'BASE'});
  assert.match(system, /你的名字是小晴/);
  assert.match(system, /本机人设/);
});

test('全局人设被关掉/插件不在时不能偷偷沿用旧文本', async t => {
  const hooks = await import('../plugins/dsh-assistant-host/character-card.js');
  t.after(() => hooks.stopPersonaRefresh());
  hooks.configurePersonaSource('http://127.0.0.1:38471');
  hooks.setCharacter({name: '鲸鱼', persona: '', guidancePersona: '', maxCompanionChars: 60});
  await hooks.refreshPersona({fetchImpl: async url => (url.includes('/status')
    ? {ok: true, json: async () => ({value: {enabled: true, active: true, globalOff: true, current: 'dafeiyu'}})}
    : {ok: true, json: async () => ({value: {text: '不该被用到的文本'}})})});
  assert.equal(hooks.currentCharacter().persona, '');
  await hooks.refreshPersona({fetchImpl: async () => { throw new Error('ECONNREFUSED'); }});
  assert.equal(hooks.currentCharacter().persona, '', '桥挂了也不能编');
});

test('存盘：原子写 + 读回一致 + 越界拒绝', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'character-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const store = characterStore(join(dir, 'character.json'));
  assert.deepEqual(await store.read(), DEFAULT_CHARACTER, '没有文件时是默认卡');
  const saved = await store.save({name: '鲸鱼', persona: '说话像朋友', guidancePersona: '指导克制', maxCompanionChars: 45});
  assert.equal((await store.read()).maxCompanionChars, 45);
  const raw = JSON.parse(await readFile(join(dir, 'character.json'), 'utf8'));
  assert.equal(raw.persona, '说话像朋友');
  assert.throws(() => store.save({maxCompanionChars: 5}), /20–120/);
  assert.equal((await store.read()).persona, saved.persona, '失败的保存不能覆盖旧卡');
});
