/**
 * Local, display-only guidance step verifier.
 *
 * It captures fresh evidence after the user says the step is done, sends the
 * current frame through an independent model stream, and parses a structured
 * passed/failed/unknown decision. It never sends desktop input and never treats
 * a missing or malformed response as success.
 */
import { readFile } from 'node:fs/promises';

import { companionStream, companionVoice } from './companion-stream.js';
import { characterSystem, currentCharacter } from './character-card.js';
import { parseVisualReply } from './visual-target.js';

export function parseStepVerification(raw) {
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
    if (['passed', 'failed', 'unknown'].includes(value?.status)) {
      return {
        status: value.status,
        reason: typeof value.reason === 'string' ? value.reason.slice(0, 500) : '',
        evidence: value.evidence ?? null,
        raw_text: original,
        structured: true,
      };
    }
  } catch { /* fall through */ }
  return {
    status: 'unknown',
    reason: 'verification_reply_unstructured',
    evidence: null,
    raw_text: original,
    structured: false,
  };
}

export class PanelStepVerifier {
  constructor({
    ctx,
    sessionId,
    captureFrame,
    attachments = null,
    route = {},
    characterCard = companionVoice,
  } = {}) {
    if (!ctx || typeof ctx.llm?.stream !== 'function') {
      throw new Error('llm service is required');
    }
    if (typeof captureFrame !== 'function') throw new Error('captureFrame is required');
    this.ctx = ctx;
    this.sessionId = sessionId;
    this.captureFrame = captureFrame;
    this.attachments = attachments;
    this.route = route;
    this.characterCard = characterCard;
  }

  _attachmentService() {
    if (this.attachments) return this.attachments;
    try { return this.ctx.get?.('attachments') ?? this.ctx.attachments ?? null; } catch { return null; }
  }

  async verify({ task, step, frame = null, signal: parentSignal } = {}) {
    const current = frame ?? await this.captureFrame({ task, step });
    if (!current?.image_ref && !current?.thumbnail_ref) {
      await current?.release?.();
      return { status: 'unknown', reason: 'no_fresh_frame', evidence: null };
    }
    let attachment = null;
    try {
    const data = await readFile(current.image_ref ?? current.thumbnail_ref);
    const attachments = this._attachmentService();
    if (attachments?.saveImage) {
      attachment = await attachments.saveImage.call(attachments, {
        data,
        mediaType: 'image/png',
        name: `guidance-verify-${current.frame_id ?? Date.now()}.png`,
      });
    }
    } finally { await current.release?.(); }
    if (!attachment) {
      return { status: 'unknown', reason: 'no_image_attachment', evidence: null };
    }
    const content = [{
      type: 'text',
      text: '[指导步骤验证]\n'
        + `任务：${task?.title ?? '指导任务'}\n`
        + `当前步骤：${step?.text ?? ''}\n`
        + `完成条件：${task?.conditions?.[step?.index] ?? '当前步骤完成后的可见结果'}\n`
        + `后续步骤：${task?.steps?.[step?.index + 1] ?? '无，这是最后一步'}\n`
        + '这是观察到的当前屏幕，用户未必已操作。请核对可见完成条件，不要把目标按钮仍然可见当成点击成功。\n'
        + '只输出 JSON，不要 Markdown：\n'
        + '{"status":"passed|failed|unknown","reason":"简短依据","target":null}\n'
        + '仅当 passed 且有后续步骤时，若下一步目标当前可见，target 返回 {"label":"名称","position":[x,y]}，坐标为整张图的0到1000；否则为null。\n'
        + '若 failed 且当前步骤目标可见，可用相同格式返回当前步骤的目标；unknown 不返回目标。\n'
        + (current.capture_scope === 'desktop'
          ? '原窗口可能已切换。本次为桌面截图：仅当新界面明确满足上述完成条件且属于当前任务时才 passed；用户切到无关软件时 unknown。新窗口出现本身不是完成证据。若 passed 但没有可见的下一步 target，另返回 evidence_window:{"position":[x,y]}，点选能证明完成条件的窗口内部，坐标同为整图0到1000；有歧义时 unknown。\n' : '')
        + '没有新鲜证据、无法判断或画面不清晰时用 unknown；不要因为用户声称完成就判 passed。'
        + '不要执行任何鼠标键盘操作。',
    }];
    if (attachment) content.push({ type: 'image', attachment });
    const signal = AbortSignal.any([AbortSignal.timeout(60000), ...(parentSignal ? [parentSignal] : [])]);
    try {
      const raw = await companionStream(this.ctx, {
        system: characterSystem(currentCharacter(), {module: 'guidance', base: this.characterCard}),
        content,
        route: this.route,
        signal,
      });
      signal.throwIfAborted();
      const result = parseStepVerification(raw);
      const targetText = result.status === 'passed' ? task?.steps?.[step.index + 1]
        : result.status === 'failed' ? step.text : null;
      if (targetText) {
        try {
          const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
          result.highlight = parseVisualReply(JSON.stringify({text: targetText, target: value.target ?? null}), current).highlight;
        } catch { result.highlight = null; }
      }
      if (current.capture_scope === 'desktop' && result.status === 'passed') {
        try {
          const value=JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));
          const target=value.target ?? (value.evidence_window?.position
            ? {label:'步骤完成证据窗口',position:value.evidence_window.position} : null);
          const visual=parseVisualReply(JSON.stringify({text:targetText || '验证完成条件',target}),current);
          if (!visual.targetPoint) throw Error('missing transition evidence');
          result.visual=visual;
        } catch {return {status:'unknown',reason:'transition_target_missing'};}
      }
      return result;
    } catch (error) {
      return {
        status: 'unknown',
        reason: `verification_model: ${String(error?.message ?? error).slice(0, 300)}`,
        evidence: null,
      };
    }
  }
}

export function createPanelStepVerifier(options) {
  return new PanelStepVerifier(options);
}
