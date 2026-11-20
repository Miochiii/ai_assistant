import test from 'node:test';
import assert from 'node:assert/strict';
import { draftForObservation } from '../scripts/prepare_desktop_session.mjs';
import { PRICE } from '../scripts/desktop_session_plan.mjs';
const now = Date.parse(PRICE.checkedAt) + 60000;
const observation = { captured_at: new Date(now - 1000).toISOString(), read_only: true, model_calls: 0,
  capture_bounds: { left: -200, top: 50, width: 1000, height: 700 },
  image: { path: 'review-fixture.png', width: 1000, height: 700, sha256: 'a'.repeat(64), resized: false } };
test('preparation never turns selected evidence into consent', () => {
  const { plan, review } = draftForObservation(observation, 'manifest-fixture', 'session-fixture', now);
  assert.equal(plan.status, 'draft'); assert.equal(plan.approved, false);
  assert.equal(plan.image_reviewed, false); assert.equal(plan.budget_micro_cny, 0);
  assert.equal(plan.expires_at, null); assert.equal(review.minimum_budget_cny, 6.316032);
  assert.equal(review.expected_spend_cny, null); assert.equal(review.gui_actions, 0);
});
test('stale, future, resized or inconsistent observations are rejected', () => {
  for (const patch of [{ captured_at: new Date(now - 900001).toISOString() },
    { captured_at: new Date(now + 1).toISOString() }, { model_calls: 1 },
    { image: { ...observation.image, resized: true } }, { image: { ...observation.image, width: 1 } }])
    assert.throws(() => draftForObservation({ ...observation, ...patch }, 'fixture', 'session-fixture', now));
});

test('bounded draft is independent of prices and still awaits image review', () => {
  const later = Date.parse(PRICE.validUntil) + 1000;
  const { plan, review } = draftForObservation({ ...observation, captured_at: new Date(later - 1).toISOString() },
    'fixture', 'session-fixture', later, { boundedValidation: true });
  assert.equal(plan.authorization_mode, 'small_readonly_validation');
  assert.equal(plan.approved, false); assert.equal(plan.image_reviewed, false);
  assert.equal('budget_micro_cny' in plan, false); assert.equal('minimum_budget_cny' in review, false);
  assert.equal(review.needs_user_budget_approval, false);
});
