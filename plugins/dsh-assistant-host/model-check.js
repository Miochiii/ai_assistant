import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { createMssAdapter } from './mss-adapter.js';
import { companionStream, companionVoice } from './companion-stream.js';
import { SpeechPort } from './speech-bus.js';

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));

export function parseModelReply(raw) {
  const original = String(raw ?? '').trim();
  let candidate = original
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) candidate = candidate.slice(start, end + 1);
  try {
    const value = JSON.parse(candidate);
    if (typeof value?.speak === 'boolean') {
      return {
        speak: value.speak,
        text: typeof value.text === 'string' ? value.text.trim() : '',
        reason: typeof value.reason === 'string' ? value.reason.trim() : null,
        raw_text: original,
        structured: true,
      };
    }
  } catch { /* fall through */ }
  return {
    speak: false,
    text: '',
    reason: 'unstructured_reply',
    raw_text: original,
    structured: false,
  };
}

function frameScope() {
  return {
    kind: 'monitor',
    scope_id: 'model-check-monitor-1',
    geometry_revision: `model-check-${Date.now()}`,
    monitor: 1,
  };
}

export class ModelCheck {
  constructor({
    ctx,
    root = ROOT,
    sessionId,
    captureFrame = null,
    attachments = null,
    now = () => new Date(),
    speechPort = null,
    resultDir = null,
    onReply = null,
    onDecision = null,
    characterCard = companionVoice,
    route = {},
  } = {}) {
    if (!ctx || typeof ctx.on !== 'function') throw new Error('plugin ctx.on is required');
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId is required');
    this.ctx = ctx;
    this.root = root;
    this.sessionId = sessionId;
    this.captureFrame = captureFrame ?? (() => createMssAdapter({
      pythonPath: join(root, '.venv', 'Scripts', 'python.exe'),
      scriptPath: join(root, 'tools', 'coach_overlay', 'capture_once.py'),
      outdir: join(root, 'runtime', 'assistant-model', 'frames'),
    }).capture({ scope: frameScope(), frameId: `model-frame-${Date.now()}` }));
    this.attachments = attachments;
    this.now = now;
    this.speechPort = speechPort ?? new SpeechPort();
    this.resultDir = resultDir ?? join(root, 'runtime', 'assistant-model');
    this.statusFile = 'last-' + createHash('sha256').update(sessionId).digest('hex').slice(0, 24) + '.json';
    this.onReply = onReply;
    this.onDecision = onDecision;
    this.characterCard = characterCard;
    this.pending = null;
    this.last = null;
    this.route = route;
    this.lastSpoken = '';
    this.stopped = false;
  }

  start() {
    this.stopped = false;
  }

  _receive(request, text) {
    if (this.pending !== request || this.stopped) return;
    const parsed = parseModelReply(text);
    const record = {
      schema_version: 1,
      session_id: this.sessionId,
      request_id: this.pending.request_id,
      frame_id: this.pending.frame?.frame_id ?? null,
      attachment_id: this.pending.attachment?.attachmentId ?? null,
      new_scene: Boolean(this.pending.new_scene),
      speak: parsed.speak,
      text: parsed.text,
      reason: parsed.reason,
      raw_text: parsed.raw_text,
      structured: parsed.structured,
      received_at: this.now().toISOString(),
      request_started_at: this.pending.started_at,
      automatic_action: false,
    };
    if (parsed.speak && parsed.text) this.lastSpoken = parsed.text.slice(0, 240);
    this.last = record;
    this.pending = null;
    try { this.onDecision?.(record); } catch { /* gate is optional */ }
    if (parsed.speak && parsed.text) {
      try { this.onReply?.(parsed.text, record); } catch { /* panel is optional */ }
      this.speechPort.speak(parsed.text, { origin: 'model_check' });
    }
    void this._writeResult(record);
  }

  stop() {
    this.stopped = true;
    this.pending?.controller.abort();
    this.pending = null;
  }

  async _writeResult(record) {
    try {
      await mkdir(this.resultDir, { recursive: true });
      await writeFile(join(this.resultDir, this.statusFile), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    } catch { /* status command can still report in memory */ }
  }

  async status() {
    if (this.pending) return { status: 'pending', request_id: this.pending.request_id };
    if (this.last) return { status: this.last.failed ? 'failed' : 'received', result: this.last };
    try {
      const raw = await readFile(join(this.resultDir, this.statusFile), 'utf8');
      const result = JSON.parse(raw);
      return { status: result.failed ? 'failed' : 'received', result };
    } catch {
      return { status: 'idle' };
    }
  }

  _attachmentService() {
    return this.attachments ?? (() => {
      try {
        if (typeof this.ctx.get === 'function') {
          const value = this.ctx.get('attachments');
          if (value) return value;
        }
      } catch { /* proxy */ }
      return this.ctx.attachments ?? null;
    })();
  }

  async request({ frame: suppliedFrame = null, newScene = false } = {}) {
    if (this.pending) {
      return { ok: false, reason: 'pending', request_id: this.pending.request_id };
    }
    if (this.stopped) return { ok: false, reason: 'stopped' };
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]);
    const request = { controller, request_id: randomUUID(), started_at: this.now().toISOString(), new_scene: newScene };
    this.pending = request;
    try {
      const frame = suppliedFrame ?? await this.captureFrame();
      signal.throwIfAborted();
      const attachmentService = this._attachmentService();
      let attachment = null;
      if (attachmentService?.saveImage && frame?.thumbnail_ref) {
        const data = await readFile(frame.thumbnail_ref);
        signal.throwIfAborted();
        attachment = await attachmentService.saveImage.call(attachmentService, {
          data, mediaType: 'image/png', name: `assistant-model-${frame.frame_id ?? Date.now()}.png`,
        });
      }
      signal.throwIfAborted();
      if (!attachment) throw new Error('缺少本次看屏图像');
      Object.assign(request, { frame, attachment });
      const content = [{
        type: 'text',
        text: '[桌面陪伴角色] '
          + (this.lastSpoken ? '上次已说：' + this.lastSpoken + '\n' : '')
          + (newScene
            ? '用户刚进入一个新画面/新场景。请按角色设定主动发表一句自然反应、观察或提问，而不是判断“是否需要提醒”。'
            : '画面没有明显的新场景变化。只有出现新的、值得角色回应的信息时才说话；否则保持安静。')
          + '\n只输出一个 JSON 对象，不要 Markdown：\n'
          + '{"speak":true或false,"text":"角色说的一句话","reason":"为什么说/为什么沉默"}\n'
          + '不要执行任何鼠标键盘操作，不要声称完成任务。',
      }];
      if (attachment) content.push({ type: 'image', attachment });
      void companionStream(this.ctx, { system: this.characterCard, content, route: this.route, signal })
        .then(text => this._receive(request, text))
        .catch(() => {
          if (this.pending !== request) return;
          this.last = { failed: true, request_id: request.request_id };
          this.pending = null;
        });
      return { ok: true, queued: true, request_id: request.request_id, frame_id: frame.frame_id,
        new_scene: newScene, attachment_id: attachment.attachmentId };
    } catch (error) {
      if (this.pending === request) this.pending = null;
      throw error;
    }
  }
}

export function createModelCheck(options) {
  return new ModelCheck(options);
}
