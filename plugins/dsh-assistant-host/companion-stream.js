import { randomUUID } from 'node:crypto';

export const companionVoice = '你是常驻桌面的鲸鱼助手。自然、简短地交流，只根据提供的信息回答。'
  + '本轮没有可调用的工具，不能执行点击、输入或打开软件，不要生成工具调用或声称已完成操作。'
  + '用户要求代操作时，简短说明可用“交给主会话：任务”转交执行；想获得看屏指导可说“教我……”。';

export class CompanionStreamError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CompanionStreamError';
    this.code = code;
    this.details = details;
  }
}

// Build the entire request here. The host agent's messages, tools, memory and
// followup queue are never inputs to a companion turn.
export async function companionStream(ctx, { system, content, history = [], signal, route = {}, maxTokens = 2048, timing = null }) {
  // 陪伴的回复被压到 30 字（约 70 token），所以下限不能按"正常对话"来卡 256 ——
  // 之前把 192 传进来会直接抛 Invalid companion output limit，整个陪伴请求全失败。
  if (!Number.isInteger(maxTokens) || maxTokens < 64 || maxTokens > 4096) throw new Error('Invalid companion output limit');
  const { provider = 'deepseek-official', model = 'deepseek-flash' } = route;
  const messages = history.map(({ role, text }) => ({
    id: randomUUID(), role, content: [{ type: 'text', text }],
    source: role === 'assistant' ? { kind: 'model', provider, model } : { kind: 'user' },
  }));
  messages.push({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content });
  const llm = ctx.llm ?? ctx.get?.('llm');
  if (!llm?.stream) throw new Error('Harness 模型服务不可用');
  const blocks = new Map();
  let finished = false;
  let toolCall = false;
  const started=performance.now();
  try {
  for await (const chunk of llm.stream({
    provider, model, messages, system, tools: [], signal,
    sessionId: randomUUID(), reasoningEffort: 'off', maxTokens,
  })) {
    signal.throwIfAborted();
    if (chunk.type === 'tool-call-delta' || (chunk.type === 'block-start' && chunk.blockType === 'tool-call')
        || (chunk.type === 'block-end' && chunk.block?.type === 'tool-call')) toolCall = true;
    if (chunk.type === 'text-delta') {
      if(timing && timing.first_text_ms === undefined && chunk.text) timing.first_text_ms=Math.round(performance.now()-started);
      blocks.set(chunk.index, (blocks.get(chunk.index) ?? '') + chunk.text);
    } else if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
      blocks.set(chunk.index, chunk.block.text);
    } else if (chunk.type === 'finish') {
      const reason = chunk.reason?.kind;
      const details = { finishReason: reason ?? 'missing', maxTokens, toolCall };
      if (reason === 'max-tokens') throw new CompanionStreamError('COMPANION_MAX_TOKENS',
        `回复达到输出上限（${maxTokens} token），未采用不完整内容。请缩小问题范围。`, details);
      if (reason === 'tool-calls' || toolCall) throw new CompanionStreamError('COMPANION_TOOL_CALL',
        '模型尝试调用工具，但面板没有动作工具。未执行操作；请使用“交给主会话：任务”，或用“教我……”获取看屏指导。', details);
      if (reason !== 'stop') throw new CompanionStreamError('COMPANION_FINISH',
        `模型回复异常结束（${String(reason ?? 'missing').slice(0, 60)}），未采用不完整内容。`, details);
      finished = true;
    }
  }
  signal.throwIfAborted();
  const text = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, value]) => value).join('').trim();
  if (!finished || !text) throw new CompanionStreamError('COMPANION_INCOMPLETE',
    '模型没有返回完整文本', { finished, maxTokens });
  return text;
  } finally { if(timing)timing.model_total_ms=Math.round(performance.now()-started); }
}
