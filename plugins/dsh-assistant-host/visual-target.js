import { mapNormalizedToGlobal, requireNormalizedPosition } from './vendor/orb/coordinates.js';

export function parseVisualReply(raw, frame) {
  const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  if (typeof value.text !== 'string' || !value.text.trim()) throw Error('视觉回复缺少步骤文字');
  if (value.target === null) return { text: value.text, highlight: null };
  if (typeof value.target?.label !== 'string' || !value.target.label.trim()) throw Error('视觉目标缺少名称');
  const position = requireNormalizedPosition(value.target.position);
  const b = frame.bounds;
  if (!b || !['left', 'top', 'width', 'height'].every(key => Number.isFinite(b[key])) || b.width <= 0 || b.height <= 0) throw Error('截图缺少屏幕区域');
  const point = mapNormalizedToGlobal(position, { bounds: { x: b.left, y: b.top, width: b.width, height: b.height } });
  const x = Math.max(b.left, Math.min(b.left + b.width - 1, Math.round(point.x)));
  const y = Math.max(b.top, Math.min(b.top + b.height - 1, Math.round(point.y)));
  const left = Math.max(b.left, x - 18), top = Math.max(b.top, y - 18);
  let windowPoint = null;
  if (frame.capture_scope === 'desktop' && value.window?.position) {
    const windowPosition = requireNormalizedPosition(value.window.position);
    const p = mapNormalizedToGlobal(windowPosition, {bounds:{x:b.left,y:b.top,width:b.width,height:b.height}});
    windowPoint = [Math.max(b.left,Math.min(b.left+b.width-1,Math.round(p.x))),
      Math.max(b.top,Math.min(b.top+b.height-1,Math.round(p.y)))];
  }
  return { text: value.text, windowPoint, targetPoint:[x,y], highlight: {
    target: value.target.label, text: value.text,
    rect: [left, top, Math.min(36, b.left + b.width - left), Math.min(36, b.top + b.height - top)],
    observationId: frame.frame_id, geometryRevision: frame.geometry_revision,
    capturedAt: frame.captured_at,
    ...(frame.target_window ? {targetHwnd:frame.target_window.foreground,
      windowGeometry:frame.target_window.window_geometry ?? null} : {}),
  } };
}

export function parseGuidancePlan(raw) {
  const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  if (value.steps === undefined) return null;
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 12
      || value.steps.some(s => typeof s?.text !== 'string' || !s.text.trim() || s.text.length > 300
        || typeof s.expected !== 'string' || !s.expected.trim() || s.expected.length > 500)) {
    throw Error('指导计划缺少有效步骤或可见完成条件');
  }
  if (typeof value.text !== 'string' || !value.text.trim()) throw Error('指导计划缺少首步提示');
  if (value.text !== value.steps[0].text) {
    // The visible reply and first planned step are often punctuated slightly
    // differently. Keep the reply as the first step instead of failing the
    // whole guidance turn over that cosmetic mismatch.
    value.steps[0] = { ...value.steps[0], text: value.text };
  }
  return value.steps;
}
