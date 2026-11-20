// Run with bundled Electron in Node mode. Never starts an agent or calls a provider.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdtemp, readFile, copyFile, writeFile, rm, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { root } from '../plugins/dsh-desktop-observe/bridge.js';
import { attachObservation, renderObservation, pointToDesktop } from '../plugins/dsh-desktop-observe/image-delivery.js';
import { definitions } from '../plugins/dsh-desktop-observe/index.js';

globalThis.fetch = () => { throw new Error('Network forbidden in offline image-delivery check'); };
const sdkRoot = 'E:/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/';
const { Context } = await import(pathToFileURL(`${sdkRoot}cordis/lib/index.js`));
const { default: LocalAttachmentStore } = await import(pathToFileURL(`${sdkRoot}dsh-attachment-local/lib/index.js`));
const { contentHasImage, createUserMessage } = await import(pathToFileURL(`${sdkRoot}dsh-llm/lib/index.js`));
const { validateJsonSchemaValue } = await import(pathToFileURL(`${sdkRoot}dsh-tools/lib/index.js`));
const ctx = new Context();
const evidenceRoot = await realpath(join(root, 'results', 'vision'));
const temp = await mkdtemp(join(evidenceRoot, 'tmp-image-delivery-'));
let report;
try {
  // Use a formal existing screenshot; no new desktop access. Store only under our temp home.
  const source = JSON.parse(await readFile(join(root, 'results', 'vision', 'c0c3534f-312b-4cd7-b9f3-4597eadad655', 'observation.json'), 'utf8'));
  await copyFile(source.image.path, join(temp, 'screen.png'));
  const observation = { ...source, image: { ...source.image, path: join(temp, 'screen.png') } };
  new LocalAttachmentStore(ctx, { dshHome: join(temp, 'isolated-harness'), normalizedImageMaxPixels: 80000 });
  const exec = { agent: { session: { header: { cwd: root, id: 'offline-native-image-check' } } }, signal: new AbortController().signal };
  await assert.rejects(attachObservation(ctx, { ...observation, image: { ...observation.image, sha256: 'wrong' } },
    { provider: 'offline', model: 'offline-fixture' }, exec), /hash mismatch/);
  const result = await attachObservation(ctx, observation, { provider: 'offline', model: 'offline-fixture' }, exec);
  const attached = result.model_image.attachment;
  assert(attached.width < source.image.width, 'The native service must actually downscale in this test');
  assert(attached.height < source.image.height);
  const blocks = renderObservation({}, result);
  assert(contentHasImage(blocks));
  const message = createUserMessage({ content: blocks, source: { kind: 'user' } });
  assert(contentHasImage(message.content));
  const renderedByRegisteredDefinition = definitions()[1].output.render({}, result);
  assert.deepEqual(renderedByRegisteredDefinition, blocks);
  assert.deepEqual(validateJsonSchemaValue(definitions()[1].output.schema, result, ''), []);
  const stored = await ctx.attachments.readImage(attached, exec.signal);
  assert(stored.data.byteLength > 0);
  const point = pointToDesktop(result.capture_bounds, attached, attached.width / 2, attached.height / 2);
  assert.deepEqual(point, { x: 812, y: 781 });
  const receipt = JSON.parse(await readFile(result.image_delivery_receipt, 'utf8'));
  assert.equal(receipt.model_image.source_sha256, source.image.sha256);
  assert.equal(receipt.model_image.delivery_status, 'prepared_for_tool_result');
  report = { checked_against: 'DSH 0.2.1-rc.2 native local attachment service',
    source_sha256: source.image.sha256, source_size: [source.image.width, source.image.height],
    attachment_size: [attached.width, attached.height], attachment_bytes: attached.bytes,
    normalized_image_sha256: createHash('sha256').update(stored.data).digest('hex'),
    native_image_content_valid: true, source_hash_mismatch_rejected: true, native_downscale_verified: true,
    center_screen_point: point, receipt_verified: true, output_schema_valid: true,
    provider_calls: 0, live_host_tested: false, new_screenshot_taken: false };
} finally {
  await ctx.fiber.dispose();
  // Verify the exact resolved target is a child of the intended evidence directory before deletion.
  const resolved = await realpath(temp);
  const subpath = relative(evidenceRoot, resolved);
  if (!subpath || subpath.startsWith('..') || isAbsolute(subpath)) throw new Error('Refusing cleanup outside evidence root');
  await rm(resolved, { recursive: true, force: true });
}
report.temporary_files_removed = true;
await writeFile(join(root, 'results', 'a04', 'dsh-image-delivery-offline.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
