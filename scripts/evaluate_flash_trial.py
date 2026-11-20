"""Evaluate this development sample against a separate local visual review; no API or input."""
import hashlib
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))
from assistant_core.events import EventStore

directory = ROOT / 'results' / 'b01' / 'flash-readonly-20261023'
if (directory / 'evaluation.json').exists():
    raise SystemExit('Evaluation already recorded; do not duplicate events')
result = json.loads((directory / 'result-1.json').read_text(encoding='utf-8'))
review = json.loads((directory / 'independent-review.json').read_text(encoding='utf-8-sig'))
observation = json.loads(Path(result['observation_path']).read_text(encoding='utf-8'))
digest = hashlib.sha256(Path(observation['image']['path']).read_bytes()).hexdigest()
assert digest == result['source_sha256'] == review['source_sha256']
assert result['model_result']['kind'] == 'stop'
raw = ''.join(block['text'] for block in result['blocks'] if block['type'] == 'text').strip()
raw = re.sub(r'^```(?:json)?\s*|\s*```$', '', raw)
answer = json.loads(raw)
box = answer['equals_button']['bbox']
center = answer['equals_button']['center']
truth = review['equals_button_bbox_approx']
width, height = result['attachment']['width'], result['attachment']['height']
assert len(box) == 4 and len(center) == 2
assert 0 <= box[0] < box[2] <= width and 0 <= box[1] < box[3] <= height
assert 0 <= center[0] < width and 0 <= center[1] < height
intersection = max(0, min(box[2], truth[2])-max(box[0], truth[0])) * max(0, min(box[3], truth[3])-max(box[1], truth[1]))
area = lambda b: (b[2]-b[0])*(b[3]-b[1])
checks = {
    'application_correct': answer['application'] == review['application'],
    'mode_correct': answer['mode'] == review['mode'],
    'display_correct': answer['display_value'] == review['display_value'],
    'occlusion_correct': answer['occlusion'] == review['occlusion'],
    'center_inside_button': truth[0] <= center[0] < truth[2] and truth[1] <= center[1] < truth[3],
    'box_fully_inside_button': truth[0] <= box[0] and truth[1] <= box[1] and box[2] <= truth[2] and box[3] <= truth[3],
}
usage = result['usage']
cost_high = (usage['inputTokens']*2 + usage['outputTokens']*8)/1_000_000
bounds = observation['capture_bounds']
evaluation = {
    'trial_id': result['trial_id'], 'source_sha256': digest, 'checks': checks,
    'bbox_iou_against_approx_visual_review': intersection/(area(box)+area(truth)-intersection),
    'center_attachment_pixels': center,
    'center_screen_pixels_at_capture': [bounds['left']+int(center[0]*bounds['width']/width), bounds['top']+int(center[1]*bounds['height']/height)],
    'model_answer': answer, 'requests_used': 1, 'usage': usage,
    'cost': {'actual_billed_cny': None, 'offpeak_usage_estimate_cny': cost_high/2,
             'peak_usage_estimate_cny': cost_high, 'source': 'provider usage × official rates; not account bill'},
    'outcome': 'partial', 'actionable': False, 'live_harness_agent_tested': False,
    'limitations': ['Single development screenshot only.', 'Visual reference box is approximate.',
                   'State and center point pass; predicted box extends above the button.',
                   'Native SDK path tested in isolated runner; no live desktop agent call or click.'],
}
with EventStore(ROOT / 'runtime' / 'events.sqlite3') as store:
    run = store.start_run(session_id=result['trial_id'], user_scope='local-user',
                          scenario_id='calculator-visual-readonly-development', version='0.2.0')
    evidence = [store.add_evidence(run, kind=kind, reference=str(path)) for kind, path in [
        ('screenshot', Path(observation['image']['path'])), ('model_response', directory/'result-1.json'),
        ('independent_visual_review', directory/'independent-review.json'), ('evaluation', directory/'evaluation.json')]]
    event = store.start_event(run, kind='answer', component='harness-native-flash-trial', version='0.2.0',
                             payload={'imported_after_execution': True, 'request_count': 1, 'usage': usage})
    store.finish_event(event, status='completed', evidence_ids=evidence[:2],
                       cost={'amount': cost_high/2, 'currency':'CNY', 'source':'usage_rate_estimate_not_invoice'})
    verifier = store.start_event(run, kind='verification', component='codex-visual-review', version='0.1.0',
                                 parent_event_id=event, payload={'checks':checks,'full_acceptance':False})
    store.finish_event(verifier, status='completed', outcome='unknown', evidence_ids=evidence)
    store.finish_run(run, verifier_event_id=verifier)
    evaluation['event_run_id'] = run
    (directory/'evaluation.json').write_text(json.dumps(evaluation,ensure_ascii=False,indent=2),encoding='utf-8')
    store.export_jsonl(run,directory/'events.jsonl')
print(json.dumps(evaluation,ensure_ascii=False))
