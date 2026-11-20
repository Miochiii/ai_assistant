import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {apply} from '../third_party/dsh-memory-evolve/lib/index.js';
import {MemoryStore} from '../third_party/dsh-memory-evolve/lib/store.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const base='E:/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/';
const sdk=name=>import(pathToFileURL(`${base}${name}/lib/index.js`));
const {Context,Service}=await sdk('cordis');
const {SessionStore}=await sdk('dsh-session');
const {SessionProjectionRegistry}=await sdk('dsh-session-projection');
const {SystemPrompt}=await sdk('dsh-system-prompt');
const {ToolRuntime}=await sdk('dsh-tools');
const {apply:installExecutor}=await sdk('dsh-tool-executor-native');
const {AgentRegistry}=await sdk('dsh-agent');
const {AgentLoop}=await sdk('dsh-agent-loop');
const {LlmRuntime,LlmAdapter,createUserMessage}=await sdk('dsh-llm');
globalThis.fetch=()=>{throw new Error('Network disabled in fixture');};
const require=createRequire('E:/dsh/resources/app.asar/dsh/package.json');
const YAML=require('yaml');
const profile='C:/Users/Mio/.dsh/profiles/desktop';
const patch=YAML.parse(await readFile(join(profile,'cordis.patch.yml'),'utf8'));
assert.equal(patch.find(r=>r.id==='orb-memory').disabled,true);
assert.equal(patch.find(r=>r.id==='orb-host').config.taskMemory.legacyGuardOnly,true);
const config=patch.find(r=>r.id==='dsh-memory-evolve').config;
const profileRequire=createRequire(join(profile,'package.json'));
assert(profileRequire.resolve('dsh-memory-evolve').replaceAll('\\','/').includes('third_party/dsh-memory-evolve/lib/index.js'));
const dir=await mkdtemp(join(root,'tmp/evolve-native-'));const ctx=new Context();let handle,requests=0;
try{
  new SessionStore(ctx);new SessionProjectionRegistry(ctx);
  new SystemPrompt(ctx,{includeHarnessIdentity:false,includeRuntimeContext:true});
  const tools=new ToolRuntime(ctx);installExecutor(ctx);
  const llm=new LlmRuntime(ctx);const agents=new AgentRegistry(ctx);await agents[Service.init]();
  const loop=new AgentLoop(ctx,{agents:[],maxParallelToolCalls:{get:()=>1}});await loop[Service.init]();
  ctx.provide('sessionTitle',{get:()=>undefined});
  ctx.provide('settings',{describe:()=>undefined});
  apply(ctx,{...config,memoryDir:dir,skillDir:join(dir,'skills')});
  assert(tools.get('memory'));assert(!tools.get('dtodo'));
  const store=new MemoryStore(dir);assert(store.add('key','SYNTHETIC_EVOLVE_EDITOR_PYCHARM',{session:{header:{cwd:root}}}).ok);
  class Fixture extends LlmAdapter{
    resolveModel(provider,id){return {provider,id,name:'offline',inputModalities:['text'],context:{contextWindow:32000},defaultMaxTokens:256};}
    async prepareCall(provider,id){return {model:this.resolveModel(provider,id),stream:o=>this.stream(o)};}
    async *stream(o){requests++;assert(JSON.stringify(o.messages).includes('SYNTHETIC_EVOLVE_EDITOR_PYCHARM'));assert(o.tools.some(t=>t.name==='memory'));
      yield {type:'block-end',index:0,block:{type:'text',text:'fixture reply'}};yield {type:'finish',reason:{kind:'stop'}};}
  }
  llm.registerAdapter(['evolve-test'],new Fixture());
  handle=await agents.create({sessionId:'evolve-native',meta:{cwd:root,agentPreset:'computer-use'},agentOptions:{provider:'evolve-test',model:'fixture',maxTokens:256}});
  handle.agent.followup(createUserMessage({content:[{type:'text',text:'Which editor?'}],source:{kind:'user'}}));
  let timer;try{await Promise.race([handle.agent.whenIdle(),new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('timeout')),10000))]);}finally{clearTimeout(timer);}
  assert.equal(requests,1);
  const report={passed:true,installed_profile_resolves:true,yaml_valid:true,legacy_writer_disabled:true,native_sdk:true,
    plugin_registered_tools:true,memory_reaches_native_model:true,fake_model:true,live_app:false,paid_requests:0};
  await writeFile(join(root,'results/memory/evolve-native.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{await handle?.dispose();await ctx.fiber.dispose();await rm(dir,{recursive:true,force:true});}
