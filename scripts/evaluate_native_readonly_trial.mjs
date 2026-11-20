// Evaluate the recorded trial against an explicit local visual review; no API.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { root } from '../plugins/dsh-desktop-observe/bridge.js';
import { pointToDesktop } from '../plugins/dsh-desktop-observe/image-delivery.js';
const directory = join(root, 'results/b01/readonly-954f7af6-5114-4a89-9488-16935d48ee73');
const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
const observationPath = join(root, 'results/vision/ed721669-52a1-4468-ac4f-ddc5f9134a39/observation.json');
const observation = JSON.parse(await readFile(observationPath, 'utf8'));
const sha = createHash('sha256').update(await readFile(observation.image.path)).digest('hex');
assert.equal(sha, result.source_sha256);
assert.equal(result.attachment_size.width, observation.image.width);
assert.equal(result.attachment_size.height, observation.image.height);
const answer = JSON.parse(result.answer);
const references = [
  { label: 'C (clear)', bbox: [384, 403, 570, 513] },
  { label: '7', bbox: [5, 631, 191, 742] },
  { label: '= (equals)', bbox: [572, 973, 757, 1083] },
];
const review = { source_sha256: sha, coordinate_space: 'attachment_pixels',
  method: 'Assistant visual inspection of the original selected PNG, after model response; approximate boxes, not blind ground truth',
  application: 'Windows Calculator', mode: 'Standard', display_value: '0', occlusion: 'none', references };
const points = answer.targets.map(target => {
  const reference = references.find(r => r.label === target.label);
  assert(reference, 'Unexpected target needs a separate visual review');
  const [x, y] = target.center, [left, top, right, bottom] = reference.bbox;
  return { label: target.label, attachment_point: target.center, approximate_reference_box: reference.bbox,
    center_inside_control: Number.isFinite(x) && Number.isFinite(y) && x >= left && x < right && y >= top && y < bottom,
    screen_point_at_capture: pointToDesktop(observation.capture_bounds, result.attachment_size, x, y) };
});
const usages = result.model_messages.map(m => m.data.usage);
const output = usages.reduce((sum, u) => sum + u.outputTokens, 0);
const total = usages.reduce((sum, u) => sum + u.totalTokens, 0);
// Native SDK total includes cache-read tokens separately from inputTokens.
const allInput = total - output;
const report = { trial_id: result.trial_id, evaluated_at: new Date().toISOString(), source_sha256: sha,
  implementation: 'Real Flash with installed native AgentLoop, tools, attachments and SDK in the plugin isolated worker',
  live_host_online_command_invoked: false, live_host_offline_command_previously_verified: true,
  requests: result.paid_model_requests, requests_with_image: result.ledger.filter(r => r.images > 0).length,
  actual_model_selected_tool: result.model_messages[0].data.message.content[0],
  checks: { native_tool_image_loop_completed: result.passed,
    application_and_mode_correct: /Calculator/.test(answer.application) && /Standard/.test(answer.application),
    display_value_reported_correctly: /Display shows '0'/.test(answer.uncertainty),
    no_occlusion_reported: answer.occlusion.startsWith('None;'),
    all_reported_centers_inside_controls: points.every(p => p.center_inside_control) },
  points,
  response_quality_issues: [
    { code: 'CAPTURE_STATUS_REPEATED_AS_ANSWER_STATUS', quote: 'No recognition was run',
      explanation: 'Conflicts with the completed visual response; capture-only status must not be repeated as a claim about the final response.' },
    { code: 'HISTORY_PANEL_DESCRIBED_AS_EMPTY_BACKGROUND',
      explanation: 'The right side is the calculator history/memory panel; calling it empty background is imprecise even though no history entries are present.' },
  ],
  usage: { all_input_tokens_including_cache: allInput, output_tokens: output, total_tokens: total, per_request: usages },
  cost: { actual_billed_cny: null, conservative_peak_estimate_no_cache_discount_cny: (allInput * 2 + output * 8) / 1e6,
    basis: 'All input charged at reviewed peak uncached rate, output at peak rate; estimate, not account bill',
    approved_budget_cny: 6.4, reserved_for_used_attempts_cny: result.ledger.reduce((sum, r) => sum + r.reserved_micro_cny, 0) / 1e6 },
  outcome: 'partial', actionable: false, new_screenshots_during_trial: 0, gui_actions: 0,
  limitations: ['Same image bytes as the first trial; not an independent layout sample.',
    'Approximate post-response visual review, not a formal benchmark.',
    'Points refer to the captured state only; no click authorization.',
    'Paid trial launched through the plugin launcher from CLI, not by clicking the live host online command.'] };
await writeFile(join(directory, 'local-visual-review.json'), JSON.stringify(review, null, 2), { flag: 'wx' });
await writeFile(join(directory, 'evaluation.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ checks: report.checks, requests: report.requests, usage: report.usage,
  cost: report.cost, quality_issues: report.response_quality_issues.map(i => i.code), outcome: report.outcome }));
