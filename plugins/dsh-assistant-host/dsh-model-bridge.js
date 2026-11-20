/**
 * Build a DSH-session model port from a cordis plugin context.
 *
 * This is the only place that knows the host service names. It does not start a
 * host or register tools; the caller decides when the resident loop runs.
 */
import { DshSessionModel } from './dsh-session-model.js';

function service(ctx, name) {
  try {
    if (ctx && typeof ctx.get === 'function') {
      const value = ctx.get(name);
      if (value) return value;
    }
  } catch { /* cordis Proxy throws for undeclared services */ }
  try { return ctx?.[name] ?? null; } catch { return null; }
}

export function createDshSessionModelFromContext(ctx, { sessionId, ...options } = {}) {
  if (!ctx || typeof ctx.on !== 'function') throw new Error('plugin ctx.on is required');
  const sessionController = service(ctx, 'sessionController');
  const attachments = service(ctx, 'attachments');
  if (!sessionController) throw new Error('sessionController service is unavailable');
  const events = {
    subscribe(handler) {
      return ctx.on('session/event', (session, event) => handler(event, session));
    },
  };
  return new DshSessionModel({
    sessionController,
    attachments,
    sessionId,
    events,
    ...options,
  });
}
