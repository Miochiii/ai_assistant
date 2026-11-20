import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UiChannel } from '../plugins/dsh-assistant-host/ui-channel.js';
import { ResidentHost, makeAssistantEvent } from '../plugins/dsh-assistant-host/resident-host.js';
import { ObservationService } from '../plugins/dsh-assistant-host/observation-service.js';
import { MssObservationRunner } from '../plugins/dsh-assistant-host/mss-observation-runner.js';

const SESSION = 'instance-observation-host';

class FakeCapture {
  constructor(clock) {
    this.clock = clock;
    this.calls = 0;
  }

  async capture({ scope, frameId }) {
    this.calls += 1;
    return {
      frame_id: frameId,
      scope_id: scope.scope_id,
      geometry_revision: scope.geometry_revision,
      captured_at: this.clock().toISOString(),
      changed_score: 12,
      width: 800,
      height: 600,
      image_ref: 'fixture/frame.png',
      source: 'fake',
    };
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'assistant-observation-host-'));
  let now = new Date('2026-11-03T12:00:00.000Z');
  const clock = () => now;
  const scope = {
    kind: 'window', scope_id: 'scope-1', geometry_revision: 'geo-1', hwnd: 1234,
  };
  const channel = new UiChannel(root, { assistantSessionId: SESSION, clock });
  const service = new ObservationService({ clock, maxFrames: 3, maxAgeMs: 5000 });
  const capture = new FakeCapture(clock);
  const host = new ResidentHost({
    channel, observationService: service, captureAdapter: capture,
    defaultObservationScope: scope, clock,
  });
  return { root, channel, service, capture, host, scope, clock };
}

function submit(host, kind, payload = {}, seq = 1) {
  const event = makeAssistantEvent({ host, kind, payload, clientSeq: seq });
  host.channel.submitEvent(event);
  return event;
}

test('Host resume starts observation and captures one fresh frame', async () => {
  const { root, host, service, capture } = fixture();
  try {
    host.initialize();
    submit(host, 'resume_observation', {}, 1);
    await host.poll();
    assert.equal(host.state.observation.status, 'running');
    assert.equal(host.state.observation.latest_frame_id?.startsWith('frame-'), true);
    assert.equal(capture.calls, 1);
    assert.equal(service.latest().status, 'found');
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Host pause stops observation and clears latest evidence; resume captures again', async () => {
  const { root, host, service, capture } = fixture();
  try {
    host.initialize();
    submit(host, 'resume_observation', {}, 1);
    await host.poll();
    const firstFrame = host.state.observation.latest_frame_id;
    submit(host, 'pause_observation', {}, 2);
    await host.poll();
    assert.equal(host.state.observation.status, 'paused');
    assert.equal(host.state.observation.latest_frame_id, null);
    assert.equal(service.latest().status, 'not_found');
    submit(host, 'resume_observation', {}, 3);
    await host.poll();
    assert.equal(host.state.observation.status, 'running');
    assert.equal(capture.calls, 2);
    assert.notEqual(host.state.observation.latest_frame_id, firstFrame);
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Host capture failure yields fault without advancing a task', async () => {
  const { root, host } = fixture();
  try {
    host.initialize();
    host.captureAdapter.capture = async () => { throw new Error('capture lost'); };
    submit(host, 'resume_observation', {}, 1);
    await host.poll();
    assert.equal(host.state.observation.status, 'fault');
    assert.match(host.state.observation.fault_reason, /capture lost/);
    assert.equal(host.state.task, null);
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Host low-rate runner keeps frames flowing until pause', async () => {
  const root = mkdtempSync(join(tmpdir(), 'assistant-observation-runner-host-'));
  const clock = () => new Date();
  const scope = {
    kind: 'monitor', scope_id: 'scope-runner', geometry_revision: 'geo-runner',
  };
  const channel = new UiChannel(root, { assistantSessionId: 'instance-runner', clock });
  const service = new ObservationService({ clock, maxFrames: 4, maxAgeMs: 5000 });
  const capture = new FakeCapture(clock);
  const runner = new MssObservationRunner({ adapter: capture, intervalMs: 250, clock });
  const host = new ResidentHost({
    channel, observationService: service, observationRunner: runner,
    defaultObservationScope: scope, clock,
  });
  try {
    host.initialize();
    submit(host, 'resume_observation', {}, 1);
    await host.poll();
    await new Promise(resolve => setTimeout(resolve, 320));
    assert.equal(host.state.observation.status, 'running');
    assert.ok(host.state.observation.frames_seen >= 2);
    const beforePause = capture.calls;
    submit(host, 'pause_observation', {}, 2);
    await host.poll();
    assert.equal(host.state.observation.status, 'paused');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(capture.calls, beforePause);
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
