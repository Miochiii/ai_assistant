/**
 * Explicit live scene-wake → DSH model probe.
 *
 * This is the real frame path: ObservationService accepts mss frames,
 * SceneWakeScheduler decides when a new frame is worth a model turn, and
 * ModelCheck sends the attached frame in a separate model request.
 *
 * It is only created by an explicit command. It never executes desktop input.
 */
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ObservationService } from './observation-service.js';
import { MssObservationRunner } from './mss-observation-runner.js';
import { createMssAdapter } from './mss-adapter.js';
import { SceneWakeScheduler } from './scene-wake.js';
import { ModelCheck } from './model-check.js';
import { CandidateGate } from './candidate-gate.js';

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));

export class ModelWatch {
  constructor({
    ctx,
    sessionId,
    root = ROOT,
    captureIntervalMs = 2000,
    scanIntervalMs = 8000,
    makeObservation = () => new ObservationService({ maxFrames: 8, maxAgeMs: 15000 }),
    makeRunner = ({ onFrame, onError }) => new MssObservationRunner({
      adapter: createMssAdapter({
        pythonPath: join(root, '.venv', 'Scripts', 'python.exe'),
        scriptPath: join(root, 'tools', 'coach_overlay', 'capture_once.py'),
        outdir: join(root, 'runtime', 'assistant-model', 'frames'),
      }),
      intervalMs: captureIntervalMs,
    }),
    makeCheck = () => new ModelCheck({ ctx, root, sessionId }),
    onReply = null,
    isSuppressed = () => false,
    gate = null,
    maxModelCalls = 0,
    characterCard = null,
    makeScheduler = ({ service, onWake }) => new SceneWakeScheduler({
      observationService: service,
      onWake,
      tickMs: Math.min(2000, scanIntervalMs),
      minWakeGapMs: scanIntervalMs,
      userCooldownMs: 3000,
      maxAutonomousWakes: Number.POSITIVE_INFINITY,
      idleStopMs: Number.POSITIVE_INFINITY,
    }),
  } = {}) {
    if (!ctx || typeof ctx.on !== 'function') throw new Error('plugin ctx.on is required');
    if (!sessionId) throw new Error('sessionId is required');
    this.ctx = ctx;
    this.sessionId = sessionId;
    this.root = root;
    this.makeObservation = makeObservation;
    this.makeRunner = makeRunner;
    this.makeCheck = makeCheck;
    this.onReply = onReply;
    this.isSuppressed = isSuppressed;
    this.characterCard = characterCard;
    this.makeScheduler = makeScheduler;
    this.gate = gate ?? new CandidateGate({ cooldownMs: scanIntervalMs });
    this.maxModelCalls = maxModelCalls;
    this.modelCalls = 0;
    this.budgetPaused = false;
    this.scanIntervalMs = scanIntervalMs;
    this.captureIntervalMs = captureIntervalMs;
    this.started = false;
    this.service = null;
    this.runner = null;
    this.check = null;
    this.scheduler = null;
    this.scope = null;
  }

  async start() {
    if (this.started) return { started: true, already: true };
    this.service = this.makeObservation();
    this.check = this.makeCheck();
    if (this.characterCard && this.check && this.check.characterCard) {
      this.check.characterCard = this.characterCard;
    }
    this.modelCalls = 0;
    this.budgetPaused = false;
    if (this.onReply && this.check && !this.check.onReply) {
      this.check.onReply = this.onReply;
    }
    if (this.check && !this.check.onDecision) {
      this.check.onDecision = record => {
        this.gate.recordDecision(Boolean(record?.speak));
      };
    }
    this.check.start();
    this.scope = {
      kind: 'monitor', scope_id: 'model-watch-monitor-1',
      geometry_revision: `model-watch-${Date.now()}`, monitor: 1,
    };
    this.scheduler = this.makeScheduler({
      service: this.service,
      onWake: async payload => {
        if (payload.kind !== 'frame' || !payload.frame) return { ok: true };
        if (this.isSuppressed()) return {ok:true,skipped:true,reason:'guidance_active'};
        if (this.budgetPaused) return { ok: true, skipped: true, reason: 'model_budget_paused' };
        const candidate = this.gate.shouldRequest(payload.frame);
        if (!candidate.candidate) return { ok: true, skipped: true, reason: candidate.reason };
        if (this.maxModelCalls > 0 && this.modelCalls >= this.maxModelCalls) {
          // Keep observing; stop buying model turns until the user restarts.
          this.budgetPaused = true;
          return { ok: true, skipped: true, reason: 'model_budget_paused' };
        }
        this.modelCalls += 1;
        const result = await this.check.request({
          frame: payload.frame,
          newScene: Boolean(candidate.new_scene),
        });
        if (!result.ok && result.reason === 'pending') {
          // A slow model turn must not be treated as a wake failure.
          return { ok: true, skipped: true, reason: 'model_pending' };
        }
        if (!result.ok) return { ok: false, reason: result.reason };
        return { ok: true };
      },
    });
    this.runner = this.makeRunner({
      onFrame: frame => this.service.pushFrame(frame),
      onError: error => this.service.fail(`capture: ${error?.message ?? error}`),
    });
    this.service.start({ scope: this.scope });
    this.runner.start({
      scope: this.scope,
      onFrame: frame => this.service.pushFrame(frame),
      onError: error => this.service.fail(`capture: ${error?.message ?? error}`),
    });
    this.scheduler.start();
    this.started = true;
    return { started: true, scope: this.scope };
  }

  stop(reason = 'user') {
    if (!this.started) return { stopped: true, already: true };
    this.scheduler?.stop(reason);
    this.runner?.stop(reason);
    this.service?.stop(reason);
    this.check?.stop();
    this.started = false;
    return { stopped: true };
  }

  status() {
    return {
      started: this.started,
      observation: this.service?.status() ?? null,
      scheduler: this.scheduler?.state?.() ?? null,
      last: this.check?.last ?? null,
      pending: Boolean(this.check?.pending),
      gate: this.gate?.status?.() ?? null,
      model_calls: this.modelCalls,
      max_model_calls: this.maxModelCalls,
      budget_paused: this.budgetPaused,
      scan_interval_ms: this.scanIntervalMs,
    };
  }
}

export function createModelWatch(options) {
  return new ModelWatch(options);
}
