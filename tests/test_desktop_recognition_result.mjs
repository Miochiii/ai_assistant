import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRecognition } from '../scripts/desktop_recognition_result.mjs';
const size = { width: 730, height: 796 };
const value = { application: 'fixture', visible_text: ['0'], occlusion: 'none', uncertainty: '',
  targets: [{ label: '=', center: [636, 762] }] };
test('valid saved observation remains non-actionable', () => {
  const result = validateRecognition(JSON.stringify(value), size);
  assert.equal(result.valid, true); assert.equal(result.actionable, false);
});
test('malformed JSON is rejected without silent repair', () => {
  const result = validateRecognition(JSON.stringify(value) + ']', size);
  assert.deepEqual(result.issues, ['INVALID_JSON']); assert.equal(result.value, null);
});
test('wrong shape, non-numeric coordinates and image boundary points are rejected', () => {
  for (const v of [[], null, { ...value, targets: null }, { ...value, visible_text: '0' },
    ...[[730, 0], [0, 796], [-1, 0], ['1', 2], [0, null]].map(center => ({ ...value, targets: [{ label: '=', center }] }))])
    assert.equal(validateRecognition(JSON.stringify(v), size).valid, false);
});
