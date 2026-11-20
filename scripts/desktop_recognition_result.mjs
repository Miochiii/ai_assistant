// Structural validation only. Valid coordinates still need visual/task checks.
export function validateRecognition(answer, size) {
  const issues = [];
  let value;
  try { value = JSON.parse(answer); }
  catch { return { valid: false, issues: ['INVALID_JSON'], value: null, actionable: false }; }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { valid: false, issues: ['EXPECTED_OBJECT'], value: null, actionable: false };
  if (!['application', 'occlusion', 'uncertainty'].every(k => typeof value[k] === 'string')) issues.push('INVALID_TEXT_FIELDS');
  if (!Array.isArray(value.visible_text) || value.visible_text.length > 5
      || !value.visible_text.every(s => typeof s === 'string')) issues.push('INVALID_VISIBLE_TEXT');
  if (!size || ![size.width, size.height].every(n => Number.isSafeInteger(n) && n > 0)) issues.push('INVALID_IMAGE_SIZE');
  if (!Array.isArray(value.targets) || value.targets.length > 3) issues.push('INVALID_TARGETS');
  else for (const target of value.targets) {
    if (!target || typeof target.label !== 'string' || !target.label.trim()
        || !Array.isArray(target.center) || target.center.length !== 2
        || !target.center.every(Number.isFinite)) { issues.push('INVALID_TARGET'); continue; }
    const [x, y] = target.center;
    if (x < 0 || y < 0 || x >= size?.width || y >= size?.height) issues.push('POINT_OUTSIDE_IMAGE');
  }
  return { valid: issues.length === 0, issues: [...new Set(issues)],
    value: issues.length ? null : value, actionable: false };
}
