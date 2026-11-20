import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { root } from '../plugins/dsh-desktop-observe/bridge.js';
import { createObserver, imageRoute, pointToDesktop, renderObservation, readDeliveryPolicy } from '../plugins/dsh-desktop-observe/image-delivery.js';

function execution(cwd = root) {
  return { agent: { options: { provider: 'fallback', model: 'fallback' }, session: {
    header: { cwd, id: 'offline-test' }, requestHeader: () => ({ config: { provider: 'selected', model: 'flash' } }),
  } }, signal: new AbortController().signal };
}

test('project image delivery is enabled by the user', async () => {
  assert.equal((await readDeliveryPolicy()).image_attachment_enabled, true);
});

test('metadata-only capture never resolves a model or saves an attachment', async () => {
  let captured = 0;
  const observe = createObserver({ get() { throw new Error('service must not be accessed'); } }, {
    capture: async args => { captured++; return { args, recognition_status: 'not_run' }; },
    policy: async () => { throw new Error('not needed'); },
  });
  assert.deepEqual(await observe({ monitor: 1 }, execution()), { args: { monitor: 1 }, recognition_status: 'not_run' });
  assert.equal(captured, 1);
});

test('disabled policy fails before model lookup, capture or attachment', async () => {
  const observer = createObserver({ get() { throw new Error('unexpected service access'); } }, {
    policy: async () => ({ image_attachment_enabled: false }),
    capture: async () => { throw new Error('unexpected capture'); },
  });
  await assert.rejects(observer({ include_image: true }, execution()), /Image delivery is disabled/);
});

test('workspace and argument rejection happen before policy or model access', async () => {
  const observer = createObserver({}, { policy: async () => { throw new Error('unexpected policy'); } });
  await assert.rejects(observer({ include_image: true }, execution(join(root, '..'))), /assistant workspace/);
  for (const args of [{ include_image: 'true' }, { include_image: true, command: 'calc' }, { region: [0, 0, 0, 2] }]) {
    await assert.rejects(observer(args, execution()), /boolean|Unknown argument|region/);
  }
});

test('resolved session route takes priority and text-only routes stop before capture', async () => {
  let selected;
  const ctx = { get(name) { return name === 'attachments' ? { saveImage() {} } : {
    async resolveModelInfo(provider, model) { selected = { provider, model }; return { inputModalities: ['text'] }; },
  }; } };
  const observer = createObserver(ctx, { policy: async () => ({ image_attachment_enabled: true }),
    capture: async () => { throw new Error('unexpected capture'); } });
  await assert.rejects(observer({ include_image: true }, execution()), /does not declare image/);
  assert.deepEqual(selected, { provider: 'selected', model: 'flash' });
  await assert.rejects(imageRoute({}, execution()), /route is unavailable/);
});

test('image-capable route passes capture result to attachment stage without inference', async () => {
  const fixture = { observation_id: 'test-image' };
  let delivered = 0;
  const ctx = { get(name) { return name === 'attachments' ? { saveImage() {} } : {
    resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
  }; } };
  const observer = createObserver(ctx, { policy: async () => ({ image_attachment_enabled: true }),
    capture: async args => { assert.deepEqual(args, { monitor: 2 }); return fixture; },
    attach: async (_ctx, observation, route) => { assert.equal(observation, fixture);
      assert.deepEqual(route, { provider: 'selected', model: 'flash' }); delivered++; return fixture; },
  });
  assert.equal(await observer({ monitor: 2, include_image: true }, execution()), fixture);
  assert.equal(delivered, 1);
});

test('cancelled calls never resolve the model or capture', async () => {
  const exec = execution();
  exec.signal = AbortSignal.abort();
  const ctx = { get(name) { return name === 'attachments' ? { saveImage() {} } : {
    resolveModelInfo() { throw new Error('must not resolve'); },
  }; } };
  const observer = createObserver(ctx, { policy: async () => ({ image_attachment_enabled: true }) });
  await assert.rejects(observer({ include_image: true }, exec), { name: 'AbortError' });
});

test('hwnd uses the action-ready capture path without resolving an image', async () => {
  let seen;
  const observer = createObserver({ get() { throw new Error('service must not be accessed'); } }, {
    capture: async () => { throw new Error('unexpected read-only capture'); },
    actionCapture: async (args, exec) => { seen = { args, session: exec.agent.session.header.id };
      return { action_ready: true, observation_id: 'ready' }; },
    policy: async () => { throw new Error('policy must not be accessed'); },
  });
  const result = await observer({ hwnd: 123, region: [10, 20, 100, 80] }, execution());
  assert.deepEqual(seen, { args: { hwnd: 123, region: [10, 20, 100, 80] }, session: 'offline-test' });
  assert.equal(result.action_ready, true);
  await assert.rejects(observer({ hwnd: 123, monitor: 1 }, execution()), /cannot be combined/);
});

test('action-ready renderer tells the model to use desktop_click once', () => {
  const attachment = { attachmentId: 'sha256:test', mediaType: 'image/png', bytes: 80, width: 600, height: 450 };
  const blocks = renderObservation({}, { action_ready: true, observation_path: 'results/vision/x/observation.json',
    model_image: { attachment } });
  assert.match(blocks[1].text, /ACTION-READY/);
  assert.match(blocks[1].text, /desktop_click once/);
  assert.match(blocks[1].text, /Task success requires/);
});

test('scaled attachment coordinates respect crop and negative desktop origins', () => {
  const bounds = { left: -400, top: 235, width: 1200, height: 900 };
  const attachment = { width: 600, height: 450 };
  assert.deepEqual(pointToDesktop(bounds, attachment, 300, 225), { x: 200, y: 685 });
  assert.deepEqual(pointToDesktop(bounds, attachment, 599.9, 449.9), { x: 799, y: 1134 });
  for (const [x, y] of [[600, 0], [0, 450], [-1, 0], [NaN, 0], [Infinity, 0], [true, 0]]) {
    assert.throws(() => pointToDesktop(bounds, attachment, x, y));
  }
});

test('renderer supplies one native image and explains actual attached pixel dimensions', () => {
  const attachment = { attachmentId: 'sha256:test', mediaType: 'image/png', bytes: 80, width: 600, height: 450 };
  const blocks = renderObservation({}, { model_image: { attachment } });
  assert.deepEqual(blocks.filter(b => b.type === 'image'), [{ type: 'image', attachment }]);
  assert.match(blocks[1].text, /width=600, height=450/);
  assert.equal(renderObservation({}, { read_only: true }).some(b => b.type === 'image'), false);
  assert.throws(() => renderObservation({}, { model_image: { attachment: { ...attachment, width: 0 } } }));
});
