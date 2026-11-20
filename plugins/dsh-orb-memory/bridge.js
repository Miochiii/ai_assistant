// Trusted host adapter. Not a model tool and not a history importer.
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createMemoryHost } from '../dsh-desktop-observe/memory.js';

function canonical(path) {
  if (typeof path !== 'string' || !path.trim()) return null;
  try { return realpathSync.native(path).toLowerCase(); } catch { return null; }
}
const hash = value => createHash('sha256').update(value).digest('hex');

/** Exact configured roots only. Neither arbitrary descendants nor model cwd apply. */
export function createOrbMemoryBridge({ root, workspace, enabled = false, host, userId } = {}) {
  const memoryRoot = canonical(root), orbRoot = canonical(workspace);
  if (!memoryRoot || !orbRoot) throw new Error('ORB_MEMORY_ROOT_UNAVAILABLE');
  const memory = host ?? createMemoryHost({ root, userId });
  let closed = false;
  function mapped(session) {
    const header = session?.header;
    if (closed || !enabled || typeof session?.id !== 'string' || !session.id
        || header?.agentPreset !== 'computer-use' || header?.origin === 'subagent'
        || header?.parentSessionId || header?.parentSession || canonical(header?.cwd) !== orbRoot) return null;
    // Preserve real session identity; explicitly reuse the existing project's scope.
    // This private object is passed only to MemoryHost, never back to Harness.
    return { id: session.id, header: { ...header, cwd: root } };
  }
  async function v2(session, op, args = {}, signal) {
    const target = mapped(session);
    return target ? memory.v2(target, op, args, signal) : null;
  }
  async function onSessionEvent(session, event, signal) {
    const target = mapped(session);
    if (!target || event?.type !== 'user/message' || event.surfaceOp !== 'append'
        || event.data?.source?.kind !== 'user') return { status: 'ignored' };
    const { id, content, source } = event.data;
    if (typeof id !== 'string' || !id || typeof source.rpcId !== 'string' || !source.rpcId
        || source.rpcId.startsWith('code-agent-') || !Array.isArray(content)) return { status: 'ignored' };
    const text = content.filter(b => b?.type === 'text' && typeof b.text === 'string')
      .map(b => b.text).join('\n').trim();
    if (!text || text.length > 8000) return { status: 'ignored' };
    // Mutation controls are admitted only by the actual Orb UI control entry,
    // never by replaying a stored session event or an external prompt source.
    if (['自动记忆状态','关闭自动记忆','开启自动记忆','整理昨日记忆'].includes(text)) return {status:'control_requires_ui'};
    // Stable RPC admission identity also deduplicates retries with a new message id.
    const eventId = `orb-user-${hash(JSON.stringify([session.id, source.rpcId]))}`;
    return memory.v2(target, 'daily_ingest', {
      text, event_id: eventId, session_id: session.id, source_channel: 'orb_daily',
    }, signal);
  }
  return {
    onSessionEvent, v2,
    // No automatic recall or prompt mutation: persistent-context invalidation is unresolved.
    accepts: session => mapped(session) !== null,
    dispose() { closed = true; if (!host) memory.dispose(); },
  };
}
