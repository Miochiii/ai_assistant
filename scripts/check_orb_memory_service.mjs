// Exercise the installed development bundle's exact UI method with a local UI
// fixture and the real CLI/SQLite backend. No app startup or model request.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdtemp,mkdir,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createMemoryHost} from '../plugins/dsh-desktop-observe/memory.js';
import {callMemory} from '../plugins/dsh-desktop-observe/memory-client.js';
import {createOrbMemoryService} from '../plugins/dsh-orb-memory/service.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const dir=await mkdtemp(join(root,'tmp/orb-memory-ui-'));
const previousDb=process.env.DSH_MEMORY_DB,previousPython=process.env.DSH_MEMORY_PYTHON;
process.env.DSH_MEMORY_DB=join(dir,'memory.sqlite3');
process.env.DSH_MEMORY_PYTHON='E:/file/agent/python.v/.venv/Scripts/python.exe';
let memory,service;
try {
  await mkdir(join(dir,'configs'));
  await writeFile(join(dir,'configs/memory-v2.json'),JSON.stringify({enabled:true,allowed_workspace:dir}));
  memory=createMemoryHost({root:dir,call:args=>callMemory({...args,root,runRoot:dir})});
  const sessions=new Map(['one','two'].map(id=>[id,{id,header:{cwd:root,agentPreset:'computer-use'}}]));
  service=createOrbMemoryService({root:dir,workspace:root,memory,sessionForId:id=>sessions.get(id),ctx:{},isBusy:()=>false});
  const code=await readFile(join(root,'dsh_orb_full_orig/dist/host/index.js'),'utf8');
  const start=code.indexOf('\tasync onPrompt(text, lassoId) {'),end=code.indexOf('\n\t/** Start one new turn',start);
  assert(start>=0&&end>start);
  const method=code.slice(start,end).trim().replace(/^async onPrompt/,'async function');
  const onPrompt=new Function('randomUUID',`return (${method});`)(randomUUID);
  const shown=[];let modelPrompts=0,current='one';
  const ui={ctx:{get:name=>name==='orbMemory'?service:undefined},block:(_id,role,text)=>shown.push({role,text}),
    ensureSession:async()=>current,preempt:async()=>{modelPrompts++;}};
  await onPrompt.call(ui,'自动记忆状态');assert.match(shown.at(-1).text,/Orb 记忆接入已加载/);
  await onPrompt.call(ui,'记住：测试项目代号是星桥');assert.equal(shown.at(-1).text,'已记住。');
  current='two';await onPrompt.call(ui,'查记忆：星桥');assert.match(shown.at(-1).text,/星桥/);
  await onPrompt.call(ui,'关闭自动记忆');assert.match(shown.at(-1).text,/已关闭/);
  await service.onEvent(sessions.get('two'),{type:'user/message',surfaceOp:'append',data:{id:'m',source:{kind:'user',rpcId:'r'},content:[{type:'text',text:'我习惯用 PyCharm'}]}});
  await onPrompt.call(ui,'自动记忆状态');assert.match(shown.at(-1).text,/最近采集：disabled/);
  await onPrompt.call(ui,'查记忆：星桥');assert.match(shown.at(-1).text,/星桥/);
  await onPrompt.call(ui,'记住：不应写入圈选内容','lasso-fixture');assert.match(shown.at(-1).text,/纯文本/);
  assert.equal(modelPrompts,0);
  await onPrompt.call(ui,'正常聊天');assert.equal(modelPrompts,1);
  const report={passed:true,real_cli_sqlite:true,exact_development_onPrompt:true,ui_fixture:true,
    real_orb_app:false,cross_session_explicit_recall:true,disabled_capture_rejected:true,
    local_controls_not_sent_to_model:true,ordinary_chat_preserved:true,production_database_accessed:false,paid_requests:0};
  await writeFile(join(root,'results/memory/orb-ui-memory-smoke.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
} finally {
  await service?.dispose();memory?.dispose();
  if(previousDb===undefined)delete process.env.DSH_MEMORY_DB;else process.env.DSH_MEMORY_DB=previousDb;
  if(previousPython===undefined)delete process.env.DSH_MEMORY_PYTHON;else process.env.DSH_MEMORY_PYTHON=previousPython;
  await rm(dir,{recursive:true,force:true});
}
