// Offline integration against the installed Harness loop. The only provider is
// a deterministic fixture; captures use an existing development screenshot.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdir, mkdtemp, readFile, copyFile, writeFile, rm, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { root } from '../plugins/dsh-desktop-observe/bridge.js';
import { definitions } from '../plugins/dsh-desktop-observe/index.js';
import { createObserver, pointToDesktop } from '../plugins/dsh-desktop-observe/image-delivery.js';
import { installRequestLimit } from '../plugins/dsh-desktop-observe/request-limit.js';

globalThis.fetch = () => { throw new Error('Network forbidden in offline agent-loop check'); };
const sdkRoot='E:/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/';
const sdk=async name=>import(pathToFileURL(`${sdkRoot}${name}/lib/index.js`));
const {Context}=await sdk('cordis');
const {SessionStore}=await sdk('dsh-session');
const {SessionProjectionRegistry}=await sdk('dsh-session-projection');
const {SystemPrompt}=await sdk('dsh-system-prompt');
const {ToolRuntime}=await sdk('dsh-tools');
const {AgentRegistry}=await sdk('dsh-agent');
const {AgentLoop}=await sdk('dsh-agent-loop');
const {LlmRuntime,LlmAdapter,contentHasImage,createUserMessage}=await sdk('dsh-llm');
const {default:LocalAttachmentStore}=await sdk('dsh-attachment-local');
const evidenceRoot=await realpath(join(root,'results','vision'));
const source=JSON.parse(await readFile(join(root,'results/vision/c0c3534f-312b-4cd7-b9f3-4597eadad655/observation.json'),'utf8'));
const temp=await mkdtemp(join(evidenceRoot,'tmp-agent-loop-'));
const reports=[];

async function checkCase(name) {
  const ctx=new Context();
  let handle, timer;
  let requests=0, captures=0, imageReceived=false, point;
  const events=[];
  const failures=[];
  try {
    new SessionStore(ctx);
    new SessionProjectionRegistry(ctx);
    new SystemPrompt(ctx,{includeHarnessIdentity:false,includeRuntimeContext:false});
    const tools=new ToolRuntime(ctx);
    const llm=new LlmRuntime(ctx);
    new AgentRegistry(ctx);
    // Direct service construction supplies the resolved volatile config cell.
    new AgentLoop(ctx,{agents:[],maxParallelToolCalls:{get:()=>1}});
    new LocalAttachmentStore(ctx,{dshHome:join(temp,name),normalizedImageMaxPixels:80000});
    // Each receipt needs its own directory. The fixture capture is read only.
    const captureDir=join(temp,`capture-${name}`);
    await mkdir(captureDir);
    await copyFile(source.image.path,join(captureDir,'screen.png'));
    const observation={...source,image:{...source.image,path:join(captureDir,'screen.png'),
      ...(name==='bad-hash'?{sha256:'wrong'}:{})}};
    const observer=createObserver(ctx,{
      policy:async()=>({image_attachment_enabled:name!=='disabled'}),
      capture:async(_args,exec)=>{
        captures++;
        if(name==='cancel'){handle.agent.cancel({kind:'user'});exec.signal.throwIfAborted();}
        return observation;
      },
    });
    for(const tool of definitions(ctx)) tools.register({...tool,
      execute:tool.name==='desktop_observe'?observer:async()=>{throw new Error('Unexpected monitor call in fixture');}});
    ctx.on('session/event',(_session,event)=>events.push(event));
    ctx.on('agent/error',({error})=>failures.push(error.message));
    const limiter=installRequestLimit(ctx,{sessionId:`offline-loop-${name}`,provider:'offline-fixture',
      model:'fixture',maxRequests:2,maxOutputTokens:1024,maxRequestBytes:64000});
    class FixtureAdapter extends LlmAdapter {
      resolveModel(provider,id) {return {provider,id,name:'Offline fixture',inputModalities:['text','image'],
        context:{contextWindow:32000},defaultMaxTokens:1024};}
      async prepareCall(provider,id) {return {model:this.resolveModel(provider,id),stream:options=>this.stream(options)};}
      async *stream(options) {
        requests++;
        assert(requests<=2,'Unexpected third fixture request');
        assert.deepEqual(options.tools.map(t=>t.name).sort(),['desktop_monitors','desktop_observe']);
        if(requests===1 || name==='request-limit') {
          if(requests===1) assert(!options.messages.some(m=>contentHasImage(m.content)));
          yield {type:'block-end',index:0,block:{type:'tool-call',id:`fixture-${name}-${requests}`,name:'desktop_observe',
            arguments:JSON.stringify({monitor:1,include_image:name!=='request-limit'})}};
          yield {type:'finish',reason:{kind:'tool-calls'}};
          return;
        }
        imageReceived=options.messages.some(m=>contentHasImage(m.content));
        assert.equal(imageReceived,name==='success');
        const result=events.find(e=>e.type==='tool/result');
        assert(result,'Tool result must be committed before the second model request');
        if(name==='success') {
          const receipt=JSON.parse(await readFile(join(captureDir,'model-image.json'),'utf8'));
          const attached=receipt.model_image.attachment;
          const images=[];
          const visit=value=>{
            if(!value||typeof value!=='object')return;
            if(value.type==='image')images.push(value.attachment);
            for(const child of Object.values(value))visit(child);
          };
          visit(options.messages);
          assert.equal(images.length,1);
          assert.deepEqual(images[0],attached,'The next request must contain this exact native attachment');
          assert(attached.width<source.image.width,'Exercise actual native image scaling');
          point=pointToDesktop(source.capture_bounds,attached,attached.width/2,attached.height/2);
          assert.deepEqual(point,{x:812,y:781});
          assert.equal(receipt.model_image.source_sha256,source.image.sha256);
        }
        yield {type:'block-end',index:0,block:{type:'text',text:JSON.stringify({fixture:true,
          outcome:name==='success'?'image_received':'observation_refused',point})}};
        yield {type:'finish',reason:{kind:'stop'}};
      }
    }
    llm.registerAdapter(['offline-fixture'],new FixtureAdapter());
    handle=await ctx.agents.create({sessionId:`offline-loop-${name}`,meta:{cwd:root},
      agentOptions:{provider:'offline-fixture',model:'fixture',maxTokens:1024}});
    handle.agent.followup(createUserMessage({content:[{type:'text',text:'Offline fixture: request the observation tool once, then report whether its image arrived.'}],source:{kind:'user'}}));
    await Promise.race([handle.agent.whenIdle(),new Promise((_,reject)=>{
      timer=setTimeout(()=>{handle.agent.cancel({kind:'user'});reject(new Error('Offline loop timed out'));},15000);
    })]);
    if(name==='request-limit') {
      assert(failures.some(x=>x.includes('SESSION_REQUEST_LIMIT')));
      assert.equal(limiter.snapshot().rejected,1);
    } else assert.deepEqual(failures,[]);
    assert.equal(requests,name==='cancel'?1:2);
    assert.equal(captures,name==='disabled'?0:name==='request-limit'?2:1);
    assert.equal(events.filter(e=>e.type==='tool/call').length,name==='request-limit'?2:1);
    assert.equal(events.filter(e=>e.type==='tool/result').length,name==='request-limit'?2:1);
    const final=events.filter(e=>e.type==='assistant/message').at(-1);
    assert(final,'The loop must commit a final assistant message');
    assert(events.some(e=>e.type==='turn/end'));
    reports.push({case:name,passed:true,fixture_model_requests:requests,fixture_captures:captures,
      image_received_in_next_request:imageReceived,screen_point:point??null,
      request_limit:limiter.snapshot(),
      event_types:events.map(e=>e.type)});
  } finally {
    clearTimeout(timer);
    await handle?.dispose();
    await ctx.fiber.dispose();
  }
}
try {for(const name of ['success','disabled','bad-hash','request-limit','cancel'])await checkCase(name);}
finally {
  const resolved=await realpath(temp),sub=relative(evidenceRoot,resolved);
  if(!sub||sub.startsWith('..')||isAbsolute(sub))throw new Error('Refusing unsafe temporary cleanup');
  await rm(resolved,{recursive:true,force:true});
}
const report={checked_at:new Date().toISOString(),sdk:'DSH 0.2.1-rc.2',
  native_agent_loop:true,native_tools:true,native_attachments:true,
  provider:'offline-fixture',paid_model_requests:0,new_screenshots:0,gui_actions:0,
  running_desktop_host_tested:false,recognition_accuracy_tested:false,
  temporary_files_removed:true,cases:reports};
await writeFile(join(root,'results/a04/dsh-agent-loop-offline.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
