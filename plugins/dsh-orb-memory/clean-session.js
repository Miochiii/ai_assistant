// Prepare a blank successor without copying messages, summaries, tools or inbox.
// Orb must own the eventual UI/durable binding transaction; this module never
// changes that binding or stops a user task. Call only from a trusted host.
function idle(agent) {
  return agent?.status === 'idle'
    && Array.isArray(agent.inbox?.nextTurn) && agent.inbox.nextTurn.length === 0
    && Array.isArray(agent.inbox?.nextStep) && agent.inbox.nextStep.length === 0;
}
export class CleanSessionError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const busy = new Set();

export async function prepareCleanSession({ source, agents, newId, meta, agentOptions,
  readVersion, backgroundState, expectedVersion, signal }) {
  if (!source?.id || !newId || newId === source.id || busy.has(source.id)) {
    throw new CleanSessionError('CLEAN_SESSION_CONFLICT');
  }
  // Unknown/missing background registry is not evidence of no active workers.
  async function check() {
    signal?.throwIfAborted();
    if (!idle(source)) throw new CleanSessionError('SOURCE_NOT_IDLE');
    if (agents.get(source.id) !== source) throw new CleanSessionError('SOURCE_CHANGED');
    if (await backgroundState(source.id) !== 'clear') throw new CleanSessionError('BACKGROUND_NOT_CLEAR');
    const version = await readVersion();
    if (typeof version !== 'string' || !version || version !== expectedVersion) {
      throw new CleanSessionError('MEMORY_VERSION_CHANGED');
    }
    signal?.throwIfAborted();
    if (!idle(source) || agents.get(source.id) !== source) throw new CleanSessionError('SOURCE_CHANGED');
  }
  busy.add(source.id);
  let handle;
  try {
    await check();
    if (agents.get(newId)) throw new CleanSessionError('TARGET_ALREADY_EXISTS');
    // Whitelist metadata so seed, parent identities and old context cannot leak.
    if (typeof meta?.cwd !== 'string' || !meta.cwd || meta.agentPreset !== 'computer-use') {
      throw new CleanSessionError('INVALID_TARGET_METADATA');
    }
    handle = await agents.create({ sessionId: newId,
      meta: { cwd: meta.cwd, agentPreset: 'computer-use' },
      agentOptions, signal });
    await check();
    if (handle.agent.id !== newId || !idle(handle.agent)
        || handle.agent.session.deriveMessages().length !== 0) {
      throw new CleanSessionError('TARGET_NOT_CLEAN');
    }
    return { handle, previousSessionId: source.id, sessionId: newId,
      memoryVersion: expectedVersion, status: 'prepared', bindingChanged: false };
  } catch (error) {
    await handle?.dispose();
    throw error;
  } finally { busy.delete(source.id); }
}
