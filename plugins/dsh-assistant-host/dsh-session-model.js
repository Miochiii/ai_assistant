/**
 * DSH current-session model port.
 *
 * This module does not call an API directly. It uses the host services that
 * dsh-see-now also uses:
 *   - attachments.saveImage() to register the current frame
 *   - sessionController.resolveAgent(sessionId)
 *   - agent.followup() to wake the current DSH session
 *   - session/event assistant messages to collect the reply
 *
 * The plugin must inject a filtered event source for its own session. Tests use
 * a fake event source. No desktop action is executed here.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export function extractAssistantText(event) {
  if (!event || event.type !== 'assistant/message') return null;
  const message = event.data?.message ?? event.message ?? null;
  const content = message?.content ?? event.data?.content ?? null;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim();
  return text || null;
}

export class SessionEventCollector {
  constructor({ events, sessionId = null } = {}) {
    if (!events || typeof events.subscribe !== 'function') {
      throw new Error('events.subscribe is required');
    }
    this.events = events;
    this.sessionId = sessionId;
    this.messages = [];
    this.off = null;
    this.startedAt = 0;
  }

  start() {
    if (this.off) return;
    this.startedAt = Date.now();
    this.off = this.events.subscribe((event, session) => {
      if (this.sessionId && session?.header?.id && session.header.id !== this.sessionId) return;
      const text = extractAssistantText(event);
      if (text) this.messages.push({ at: Date.now(), text });
    });
  }

  stop() {
    this.off?.();
    this.off = null;
  }

  last() {
    return this.messages.at(-1)?.text ?? null;
  }
}

function withTimeout(promise, ms, label) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export class DshSessionModel {
  constructor({
    sessionController,
    attachments = null,
    sessionId,
    events = null,
    timeoutMs = 60000,
    eventGraceMs = 1000,
    clock = () => new Date(),
  } = {}) {
    if (!sessionController || typeof sessionController.resolveAgent !== 'function') {
      throw new Error('sessionController.resolveAgent is required');
    }
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId is required');
    this.sessionController = sessionController;
    this.attachments = attachments;
    this.sessionId = sessionId;
    this.events = events;
    this.timeoutMs = timeoutMs;
    this.eventGraceMs = eventGraceMs;
    this.clock = clock;
    this.calls = 0;
  }

  async _imageRef(frame) {
    if (!this.attachments || typeof this.attachments.saveImage !== 'function' || !frame?.thumbnail_ref) {
      return null;
    }
    const data = await readFile(frame.thumbnail_ref);
    return this.attachments.saveImage.call(this.attachments, {
      data,
      mediaType: 'image/png',
      name: `assistant-frame-${frame.frame_id ?? Date.now()}.png`,
    });
  }

  _prompt({ kind, text, task, step, frame }) {
    if (kind === 'chat') {
      return [
        '[桌面陪伴面板对话]',
        '你正在通过紧凑助手面板和用户对话。直接回答用户，不要提“截图”或“探测”。',
        '不要执行任何鼠标键盘操作；不要声称已经操作桌面。',
        `用户：${String(text ?? '').slice(0, 2000)}`,
      ].join('\n');
    }
    const lines = [
      '[桌面助手唤醒]',
      '你是常驻桌面助手。只看当前提供的画面和任务上下文，给用户一句有用的建议或说明。',
      '不要执行任何鼠标键盘操作；不要声称已经点击或完成任务。',
      '如果画面没有值得说的变化，返回空文本。',
    ];
    if (kind === 'user') lines.push(`用户插话：${String(text ?? '').slice(0, 500)}`);
    if (task) {
      lines.push(`任务：${task.title}`);
      lines.push(`当前步骤 ${Number(task.step_index) + 1}/${task.steps?.length ?? 0}：${step?.text ?? ''}`);
    }
    if (frame) {
      lines.push(`画面：frame=${frame.frame_id} changed_score=${frame.changed_score ?? 0} `
        + `changed_ratio=${frame.changed_ratio ?? 0}`);
      if (frame.change_bbox) lines.push(`变化区域：${JSON.stringify(frame.change_bbox)}`);
    }
    lines.push('只输出给用户看的一句话；不要输出 JSON，不要输出工具调用。');
    return lines.join('\n');
  }

  async complete(request) {
    this.calls += 1;
    const image = await this._imageRef(request.frame);
    const resolved = await this.sessionController.resolveAgent(this.sessionId);
    if (!resolved || resolved.error || !resolved.agent) {
      const reason = resolved?.error?.message ?? resolved?.error ?? 'resolve-failed';
      return { should_speak: false, error: String(reason).slice(0, 200) };
    }
    const collector = this.events ? new SessionEventCollector({
      events: this.events, sessionId: this.sessionId,
    }) : null;
    collector?.start();
    const content = [{ type: 'text', text: this._prompt(request) }];
    if (image) content.push({ type: 'image', attachment: image });
    try {
      resolved.agent.followup({
        id: randomUUID(),
        role: 'user',
        content,
        source: { kind: 'assistant-host' },
      });
      try {
        if (typeof resolved.agent.whenIdle === 'function') {
          await withTimeout(resolved.agent.whenIdle(), this.timeoutMs, 'model turn');
        }
      } catch (error) {
        return { should_speak: false, error: String(error?.message ?? error).slice(0, 200) };
      }
      if (collector && !collector.last() && this.eventGraceMs > 0) {
        await new Promise(resolve => setTimeout(resolve, this.eventGraceMs));
      }
      const reply = collector?.last() ?? null;
      if (!reply) return { should_speak: false, error: 'no_assistant_message' };
      return { should_speak: true, text: reply };
    } finally {
      collector?.stop();
    }
  }
}

export function createDshSessionModel(options) {
  return new DshSessionModel(options);
}
