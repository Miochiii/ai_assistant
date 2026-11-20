import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseVisualReply } from '../plugins/dsh-assistant-host/visual-target.js';
import { PanelChatModel } from '../plugins/dsh-assistant-host/panel-model.js';
const frame = { bounds: { left:-1920, top:120, width:1920, height:1080 },
  frame_id:'fixture', geometry_revision:'g1', captured_at:new Date().toISOString() };
const reply = position => JSON.stringify({text:'点击目标',target:{label:'目标',position}});

test('Orb normalized coordinates preserve negative monitor origin and physical size', () => {
  const target = parseVisualReply(reply([500,500]), frame).highlight;
  assert.deepEqual(target.rect, [-978,642,36,36]);
  assert.equal(target.observationId, 'fixture');
  for (const point of [[0,0],[1000,1000]]) {
    const [x,y,w,h] = parseVisualReply(reply(point),frame).highlight.rect;
    assert.ok(x >= -1920 && x+w <= 0 && y >= 120 && y+h <= 1200);
  }
  for (const point of [[-1,0],[1001,0],['500',0],[0],null]) {
    assert.throws(() => parseVisualReply(reply(point),frame));
  }
  assert.equal(parseVisualReply('{"text":"目标不可见","target":null}',frame).highlight,null);
  assert.throws(() => parseVisualReply('点击右上角',frame));
});

test('guidance attaches the actual image, releases capture files, and keeps images out of history', async () => {
  const root = await mkdtemp(join(tmpdir(),'orb-image-test-'));
  let released=0, captured=0, saved=0, request;
  const image = join(root,'fixture.png');
  const bytes = Buffer.from('offline image bytes');
  await writeFile(image,bytes);
  const model = new PanelChatModel({sessionId:'fixture', memory:{guidancePreference:async()=>null},
    observe:async()=>{captured++; return {...frame,image_ref:image,release:async()=>{released++;}};},
    ctx:{attachments:{saveImage:async ({data})=>{assert.deepEqual(data,bytes);saved++;return {id:'image-fixture'};}},
      llm:{async *stream(req){request=req;yield {type:'text-delta',index:0,text:reply([500,500])};yield {type:'finish',reason:{kind:'stop'}};}}},
  });
  try {
    const result = await model.complete({text:'教我点击目标'});
    assert.deepEqual(result.highlightTarget.rect,[-978,642,36,36]);
    assert.equal(request.messages.at(-1).content.filter(c=>c.type==='image').length,1);
    assert.equal(captured,1); assert.equal(saved,1); assert.equal(released,1);
    assert.doesNotMatch(JSON.stringify(model.history),/image-fixture|image_ref|position/);
    model.ctx.attachments.saveImage=async()=>{throw Error('attachment failed');};
    await assert.rejects(model.complete({text:'继续'}),/attachment failed/);
    assert.equal(released,2);
  } finally {await rm(root,{recursive:true,force:true});}
});
