/**
 * check_asr_contract.mjs — 按 dsh-video-storyboard 的 `docs/asr-contract.md` 逐条验收一个 ASR 端点。
 *
 * 它验的是**契约**，不是识别质量：形状对不对、时间戳是不是相对本次上传、静音会不会报错、
 * 坏数据会不会真的返回非 2xx。这几条错一条，插件的错误分类就会把"没人说话"写成"服务坏了"，
 * 或者把每一格台词整体偏移几十秒 —— 两种都比"没有台词"更难查。
 *
 * 用法：
 *   node tools/asr/check_asr_contract.mjs --fake                    # 先自检检查器本身
 *   node tools/asr/check_asr_contract.mjs                           # 打本机 8100
 *   node tools/asr/check_asr_contract.mjs --baseUrl http://127.0.0.1:8100/v1
 *   node tools/asr/check_asr_contract.mjs --wav some.wav --expect-text   # 带真台词样例
 *
 * 退出码：全部通过 0；有失败 1。
 */

import {createServer} from 'node:http';

const TARGET_RATE = 16000;

function parseArgs(argv) {
  const out = {baseUrl: 'http://127.0.0.1:8100/v1', wav: null, expectText: false, fake: false};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--baseUrl') out.baseUrl = next();
    else if (arg === '--wav') out.wav = next();
    else if (arg === '--expect-text') out.expectText = true;
    else if (arg === '--fake') out.fake = true;
    else if (arg === '--help' || arg === '-h') { console.log('see the header of this file'); process.exit(0); }
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

/** 生成 16k 单声道 PCM16 WAV。kind: tone | silence | speechlike
 *
 * `pipeHeader: true` 复刻客户端真实的发送方式：ffmpeg 往管道写时无法回填长度，
 * RIFF size 与 data size 都是 0xFFFFFFFF，而且可能多一个 LIST chunk。
 * 服务端必须容忍这种头，否则"接上就永远没台词"。
 */
export function makeWav({seconds = 3, kind = 'tone', rate = TARGET_RATE, pipeHeader = false} = {}) {
  const count = Math.max(1, Math.round(rate * seconds));
  const dataLen = count * 2;
  const buf = Buffer.alloc(44 + dataLen);
  const write = (offset, text) => buf.write(text, offset, 'latin1');
  write(0, 'RIFF');
  buf.writeUInt32LE(pipeHeader ? 0xFFFFFFFF : 36 + dataLen, 4);
  write(8, 'WAVE');
  write(12, 'fmt ');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);       // PCM
  buf.writeUInt16LE(1, 22);       // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  write(36, 'data');
  buf.writeUInt32LE(pipeHeader ? 0xFFFFFFFF : dataLen, 40);
  for (let i = 0; i < count; i += 1) {
    const t = i / rate;
    let sample = 0;
    if (kind === 'tone') {
      // 0.4–0.9s 与 1.6–2.2s 两段"像在说话"的响动，其余静音
      const on = (t > 0.4 && t < 0.9) || (t > 1.6 && t < 2.2);
      sample = on ? Math.sin(2 * Math.PI * 220 * t) * 0.25 : 0;
    } else if (kind === 'speechlike') {
      // 带包络的复合音：不是人声，只保证"有响动"，用来验证服务不会把它当静音
      const env = Math.min(1, Math.max(0, Math.sin(Math.PI * t)));
      sample = env * (Math.sin(2 * Math.PI * 180 * t) * 0.2 + Math.sin(2 * Math.PI * 320 * t) * 0.1);
    }
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), 44 + i * 2);
  }
  return buf;
}

function rootOf(baseUrl) {
  return baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '');
}

async function postAudio(baseUrl, bytes, {name = 'audio.wav', type = 'audio/wav', extra = {}} = {}) {
  const form = new FormData();
  form.append('file', new Blob([bytes], {type}), name);
  form.append('model', 'contract-check');
  form.append('response_format', 'verbose_json');
  form.append('language', 'zh');
  form.append('hotword', '测试词');
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/audio/transcriptions`, {method: 'POST', body: form});
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return {status: res.status, text, json};
}

/** 契约的形状检查。返回问题列表（空 = 通过）。 */
export function validateTranscription(json, {duration = null} = {}) {
  const problems = [];
  if (!json || typeof json !== 'object') return ['响应不是 JSON 对象'];
  if (typeof json.text !== 'string') problems.push('缺少 text 字符串');
  if (!Array.isArray(json.segments)) {
    problems.push('缺少 segments 数组（只有 text 会退化成整段一句）');
    return problems;
  }
  json.segments.forEach((seg, index) => {
    const where = `segments[${index}]`;
    if (!seg || typeof seg !== 'object') { problems.push(`${where} 不是对象`); return; }
    const {start, end} = seg;
    if (!Number.isFinite(start) || !Number.isFinite(end)) problems.push(`${where} 的 start/end 不是有限数字`);
    if (Number.isFinite(start) && start < 0) problems.push(`${where}.start < 0`);
    if (Number.isFinite(start) && Number.isFinite(end) && end <= start) problems.push(`${where} start>=end（${start}..${end}）`);
    if (typeof seg.text !== 'string' || seg.text.trim() === '') problems.push(`${where}.text 为空`);
    if (duration !== null && Number.isFinite(end) && end > duration + 0.5) {
      problems.push(`${where}.end=${end} 超过上传时长 ${duration}s —— 服务端很可能加了视频绝对偏移`);
    }
  });
  if (json.model !== undefined && typeof json.model !== 'string') problems.push('model 不是字符串');
  return problems;
}

const results = [];
function record(name, ok, detail = '') {
  results.push({name, ok, detail});
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function checkEndpoint(baseUrl, {wav = null, expectText = false} = {}) {
  // 1) 探活：/health 不通就退到 /v1/models（插件的 asr-lifecycle 也是这两下）
  let alive = null;
  for (const path of ['/health', '/v1/models']) {
    try {
      const res = await fetch(`${rootOf(baseUrl)}${path}`, {signal: AbortSignal.timeout(3000)});
      if (res.ok) { alive = path; break; }
    } catch { /* 换下一个 */ }
  }
  record('探活端点可应答（/health 或 /v1/models）', Boolean(alive), alive ?? '两个都不通');

  // 2) 有响动的音频 → 200 + 合法形状
  const tone = wav ? null : makeWav({seconds: 3, kind: 'tone'});
  const bytes = wav ?? tone;
  const duration = wav ? null : 3;
  const toneRes = await postAudio(baseUrl, bytes);
  record('POST /audio/transcriptions 返回 2xx', toneRes.status >= 200 && toneRes.status < 300, `HTTP ${toneRes.status} ${toneRes.text.slice(0, 120)}`);
  const problems = validateTranscription(toneRes.json, {duration});
  record('响应形状符合契约（segments/时间戳/相对时间）', problems.length === 0, problems.join('；'));
  if (expectText) {
    const withText = (toneRes.json?.segments ?? []).some(seg => String(seg.text ?? '').trim());
    record('样例音频识别出至少一句台词', withText, withText ? '' : '一句都没有 —— 确认 --wav 里真的有人说话');
  }

  // 3) 数字静音 → 200 + 空 segments（不能报错，否则"没人说话"会被写成"服务坏了"）
  const silent = await postAudio(baseUrl, makeWav({seconds: 1.0, kind: 'silence'}));
  const silentEmpty = silent.status === 200 && Array.isArray(silent.json?.segments) && silent.json.segments.length === 0;
  record('静音返回 200 且 segments 为空（不是 5xx）', silentEmpty, `HTTP ${silent.status} · ${JSON.stringify(silent.json)?.slice(0, 100)}`);

  // 4) 坏音频 → 必须是真的 4xx（客户端靠状态码区分 asr-failed 与 no-audio）
  const garbage = await postAudio(baseUrl, Buffer.from('this is not a wav file at all'), {name: 'broken.wav'});
  record('坏音频返回 4xx', garbage.status >= 400 && garbage.status < 500, `HTTP ${garbage.status}`);

  // 5) ffmpeg 管道头（size=0xFFFFFFFF）→ 必须也能解析
  const piped = await postAudio(baseUrl, makeWav({seconds: 2, kind: 'tone', pipeHeader: true}), {name: 'piped.wav'});
  const pipedProblems = piped.status >= 200 && piped.status < 300 ? validateTranscription(piped.json) : [`HTTP ${piped.status}`];
  record('容忍 ffmpeg 管道 WAV（0xFFFFFFFF 长度字段）', pipedProblems.length === 0, pipedProblems.join('；'));
}

/** 从 buffer 里找到 WAV 并取出 PCM 段（假服务用来判断"这段是不是静音"）。 */
export function wavPayload(buffer) {
  const at = buffer.indexOf('RIFF');
  if (at < 0) return null;
  let pos = at + 12;
  while (pos + 8 <= buffer.length) {
    const id = buffer.toString('latin1', pos, pos + 4);
    const size = buffer.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'data') {
      const end = size === 0xFFFFFFFF ? buffer.length : Math.min(buffer.length, body + size);
      return buffer.subarray(body, end);
    }
    if (size === 0xFFFFFFFF || body + size > buffer.length) return null;
    pos = body + size + (size & 1);
  }
  return null;
}

/** 一个"教科书式正确"的假服务：先证明检查器本身不会误报。 */
function startFake() {
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'GET') {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify(url.endsWith('/health') ? {ok: true} : {object: 'list', data: []}));
      return;
    }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const pcm = wavPayload(body);
      // 垃圾数据：连 RIFF/WAVE 都没有就当坏音频
      if (!pcm) {
        res.writeHead(400, {'content-type': 'application/json'});
        res.end(JSON.stringify({error: 'bad audio'}));
        return;
      }
      // 数字静音（PCM 全是 0）→ 空 segments，和真服务该有的行为一致
      const silent = !pcm.some(byte => byte !== 0);
      const payload = silent
        ? {text: '', model: 'fake', language: 'zh', segments: []}
        : {text: '假服务的一句话', model: 'fake', language: 'zh', segments: [{start: 0.4, end: 0.9, text: '假服务的一句话'}]};
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({server, port: server.address().port}));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let baseUrl = args.baseUrl;
  let fake = null;
  if (args.fake) {
    fake = await startFake();
    baseUrl = `http://127.0.0.1:${fake.port}/v1`;
    console.log(`[fake] 假服务起在 ${baseUrl}（这一轮的失败说明检查器本身有问题）\n`);
  } else {
    console.log(`[check] ${baseUrl}\n`);
  }
  try {
    await checkEndpoint(baseUrl, {wav: args.wav ? (await import('node:fs')).readFileSync(args.wav) : null, expectText: args.expectText});
  } finally {
    fake?.server.close();
  }
  const failed = results.filter(r => !r.ok);
  console.log(`\n${failed.length === 0 ? '全部通过' : `失败 ${failed.length} 项`}（共 ${results.length} 项）`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}` || process.argv[1]?.endsWith('check_asr_contract.mjs')) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
