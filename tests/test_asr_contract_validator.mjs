/**
 * ASR 契约校验器自身的单元测试。
 *
 * 为什么要测"检查器"：`tools/asr/check_asr_contract.mjs` 的判断会被用来给真服务判合格/不合格，
 * 它自己错了比没有检查更糟（会把时间码整体偏移这种致命问题放过去）。这里只喂纯函数，
 * 不联网、不起服务。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {validateTranscription, makeWav, wavPayload} from '../tools/asr/check_asr_contract.mjs';

const good = {
  text: '第一句 第二句',
  model: 'sensevoice-small-int8',
  language: 'zh',
  segments: [{start: 0.4, end: 1.1, text: '第一句'}, {start: 1.6, end: 2.2, text: '第二句'}],
};

test('合法响应没有问题', () => {
  assert.deepEqual(validateTranscription(good, {duration: 3}), []);
});

test('缺 segments 要报出来（只有 text 会退化成整段一句）', () => {
  const problems = validateTranscription({text: '只有整段文字', model: 'x'});
  assert.match(problems.join(' '), /segments/);
});

test('start >= end 要报出来', () => {
  const problems = validateTranscription({...good, segments: [{start: 2, end: 1, text: '倒着'}]});
  assert.match(problems.join(' '), /start>=end/);
});

test('非有限数字要报出来（NaN/字符串都不行）', () => {
  assert.match(validateTranscription({...good, segments: [{start: Number.NaN, end: 1, text: 'x'}]}).join(' '), /有限数字/);
  assert.match(validateTranscription({...good, segments: [{start: '0.4', end: 1, text: 'x'}]}).join(' '), /有限数字/);
});

test('超过上传时长的时间码 = 服务端加了视频绝对偏移，必须报出来', () => {
  const problems = validateTranscription({...good, segments: [{start: 300, end: 302, text: '绝对时间'}]}, {duration: 3});
  assert.match(problems.join(' '), /绝对偏移/);
});

test('空文本的片段要报出来（宁可没有段，也别返回空壳）', () => {
  assert.match(validateTranscription({...good, segments: [{start: 0.4, end: 1, text: '   '}]}).join(' '), /text 为空/);
});

test('makeWav 生成的是合法 WAV，并且能取回 PCM', () => {
  const wav = makeWav({seconds: 1, kind: 'tone'});
  assert.equal(wav.toString('latin1', 0, 4), 'RIFF');
  assert.equal(wav.toString('latin1', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  const pcm = wavPayload(wav);
  assert.ok(pcm && pcm.length === 16000 * 2, `PCM 长度应为 32000，实际 ${pcm?.length}`);
});

test('pipeHeader 复刻 ffmpeg 管道写出的 0xFFFFFFFF 长度，仍然能取回 PCM', () => {
  const wav = makeWav({seconds: 0.5, kind: 'tone', pipeHeader: true});
  assert.equal(wav.readUInt32LE(4), 0xFFFFFFFF);
  assert.equal(wav.readUInt32LE(40), 0xFFFFFFFF);
  const pcm = wavPayload(wav);
  assert.ok(pcm && pcm.length === 16000, `PCM 长度应为 16000，实际 ${pcm?.length}`);
});

test('静音的 PCM 全是 0（假服务用它判断"没人说话"）', () => {
  const pcm = wavPayload(makeWav({seconds: 0.2, kind: 'silence'}));
  assert.ok(pcm.every(byte => byte === 0));
  const tone = wavPayload(makeWav({seconds: 0.5, kind: 'tone'}));
  assert.ok(tone.some(byte => byte !== 0));
});
