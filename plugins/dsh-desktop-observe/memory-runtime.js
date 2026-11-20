// Shared in-process host registration. No model-facing API or startup work.
let current = null;

export function registerMemoryRuntime(host) {
  current = host;
  return () => { if (current === host) current = null; };
}

export const memoryRuntime = {
  async v2(session, op, args, signal) {
    return current?.v2(session, op, args, signal) ?? null;
  },
  async guidancePreference(session, signal) {
    return current ? current.guidancePreference(session, signal) : null;
  },
  async panelMemory(session, input) {
    if (!current) throw new Error('记忆服务尚未加载');
    return current.panelMemory(session, input);
  },
  async context(session) {
    try { return await current?.runContext(session) ?? null; }
    catch { return null; } // Memory unavailable must not prevent desktop work.
  },
  async checkpoint(session, runId) {
    if (!current) return { status: 'skipped', reason: 'memory_host_not_loaded' };
    return current.autoCheckpoint(session, { run_id: runId });
  },
};
