import assert from 'node:assert/strict';
import test from 'node:test';

import { ObservationService } from '../plugins/dsh-assistant-host/observation-service.js';
import { createSeeNowAdapter } from '../plugins/dsh-assistant-host/see-now-adapter.js';

function fixture() {
  let now = new Date('2026-11-03T12:00:00.000Z');
  const clock = () => now;
  const service = new ObservationService({ clock, maxFrames: 3, maxAgeMs: 5000 });
  const scope = {
    kind: 'window',
    scope_id: 'scope-1',
    geometry_revision: 'geo-1',
    hwnd: 1234,
    bounds: { left: 10, top: 20, width: 800, height: 600 },
  };
  function frame(id, overrides = {}) {
    return {
      frame_id: id,
      scope_id: scope.scope_id,
      geometry_revision: scope.geometry_revision,
      captured_at: now.toISOString(),
      changed_score: 12,
      width: 800,
      height: 600,
      image_ref: `fixture/${id}.png`,
      source: 'synthetic',
      ...overrides,
    };
  }
  return { service, scope, frame, tick: ms => { now = new Date(now.getTime() + ms); } };
}

test('starts synthetic observation, accepts current frame and reports latest', () => {
  const { service, scope, frame } = fixture();
  assert.equal(service.status().status, 'stopped');
  assert.equal(service.start({ scope }).started, true);
  assert.equal(service.status().status, 'running');
  assert.equal(service.pushFrame(frame('f1')).accepted, true);
  const latest = service.latest();
  assert.equal(latest.status, 'found');
  assert.equal(latest.frame.frame_id, 'f1');
  const summary = service.takeSummary();
  assert.equal(summary.frames_seen, 1);
  assert.equal(summary.frames_kept, 1);
  assert.equal(summary.latest_frame_id, 'f1');
  assert.equal(service.takeSummary().frames_seen, 0);
});

test('rejects frames with wrong scope, wrong geometry and bad scores', () => {
  const { service, scope, frame } = fixture();
  service.start({ scope });
  assert.equal(service.pushFrame(frame('wrong-scope', { scope_id: 'other' })).reason, 'scope_or_geometry_mismatch');
  assert.equal(service.pushFrame(frame('wrong-geometry', { geometry_revision: 'geo-2' })).reason, 'scope_or_geometry_mismatch');
  assert.equal(service.pushFrame(frame('bad-score', { changed_score: 999 })).reason, 'invalid_frame');
  assert.equal(service.status().frames_dropped, 3);
});

test('pause clears pending frames and rejects new frames until resume', () => {
  const { service, scope, frame } = fixture();
  service.start({ scope });
  service.pushFrame(frame('f1'));
  assert.equal(service.pause('user').paused, true);
  assert.equal(service.latest().status, 'not_found');
  assert.equal(service.pushFrame(frame('during-pause')).reason, 'not_running');
  assert.equal(service.resume({ scope }).resumed, true);
  assert.equal(service.status().status, 'running');
  assert.equal(service.pushFrame(frame('f2')).accepted, true);
  assert.equal(service.latest().frame.frame_id, 'f2');
});

test('latest enforces freshness and after/geometry filters', () => {
  const { service, scope, frame, tick } = fixture();
  service.start({ scope });
  service.pushFrame(frame('f1'));
  tick(6000);
  assert.equal(service.latest().reason, 'stale');
  assert.equal(service.latest({ maxAgeMs: 0 }).status, 'found');
  assert.equal(service.latest({ after: '2026-11-03T12:00:01.000Z' }).reason, 'not_newer');
  service.pushFrame(frame('f2'));
  assert.equal(service.latest({ after: '2026-11-03T11:59:59.000Z' }).status, 'found');
  assert.equal(service.latest({ geometryRevision: 'geo-2' }).reason, 'geometry_mismatch');
});

test('frame cache is bounded and latest remains the newest frame', () => {
  const { service, scope, frame } = fixture();
  service.start({ scope });
  for (let i = 0; i < 5; i += 1) {
    assert.equal(service.pushFrame(frame(`f${i}`)).accepted, true);
  }
  assert.equal(service.status().frames_kept, 3);
  assert.equal(service.latest().frame.frame_id, 'f4');
  assert.equal(service.takeSummary().frames_dropped, 2);
});

test('stop clears scope and frames; fault is explicit', () => {
  const { service, scope, frame } = fixture();
  service.start({ scope });
  service.pushFrame(frame('f1'));
  service.stop('user');
  assert.equal(service.status().status, 'stopped');
  assert.equal(service.latest().reason, 'no_frame');
  assert.equal(service.pushFrame(frame('after-stop')).reason, 'not_running');
  service.start({ scope });
  service.fail('capture lost');
  assert.equal(service.status().status, 'fault');
  assert.equal(service.status().fault_reason, 'capture lost');
});

test('low-change frames are dropped after the first frame', () => {
  let now = new Date('2026-11-03T12:00:00.000Z');
  const clock = () => now;
  const scope = { kind: 'monitor', scope_id: 'scope-low', geometry_revision: 'geo-low' };
  const service = new ObservationService({
    clock, maxFrames: 3, minChangedScore: 2, minChangedRatio: 0.01,
  });
  const frame = (id, score, ratio) => ({
    frame_id: id, scope_id: scope.scope_id, geometry_revision: scope.geometry_revision,
    captured_at: now.toISOString(), changed_score: score, changed_ratio: ratio,
  });
  service.start({ scope });
  assert.equal(service.pushFrame(frame('first', 0, 0)).accepted, true);
  assert.equal(service.pushFrame(frame('quiet', 1, 0)).reason, 'low_change');
  assert.equal(service.status().frames_low_change, 1);
  assert.equal(service.pushFrame(frame('active', 3, 0.2)).accepted, true);
  assert.equal(service.latest().frame.frame_id, 'active');
  assert.equal(service.takeSummary().frames_low_change, 1);
});

test('See Now adapter refuses without ffmpeg and never captures', () => {
  const adapter = createSeeNowAdapter();
  assert.equal(adapter.available, false);
  assert.equal(adapter.status().reason, 'ffmpeg-unavailable');
  assert.equal(adapter.start().ok, false);
  assert.equal(adapter.status().started, false);
});
