// Exact installed UI method + real SQLite/daily commit/resident retrieval.
// Synthetic data and a fake LLM only; no production database or paid request.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createMemoryHost} from '../plugins/dsh-desktop-observe/memory.js';
import {callMemory} from '../plugins/dsh-desktop-observe/memory-client.js';
import {createOrbMemoryService} from '../plugins/dsh-orb-memory/service.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const workspace=join(root,'dsh_orb_work');
const dir=await mkdtemp(join(root,'tmp/orb-natural-recall-'));
const oldDb=process.env.DSH_MEMORY_DB,oldPython=process.env.DSH_MEMORY_PYTHON;
const config=JSON.parse(await readFile(join(root,'configs/memory-v2.json'),'utf8'));
process.env.DSH_MEMORY_DB=join(dir,'synthetic.sqlite3');process.env.DSH_MEMORY_PYTHON=config.python;
let memory,service;
try{
  memory=createMemoryHost({root,userId:'synthetic-orb-natural-recall',residentGeneration:true});
  const scope=memory.scope({header:{cwd:root}});
  const seed=`import sys,json
from pathlib import Path
sys.path.insert(0,str(Path(sys.argv[1])/'src'))
from assistant_memory import MemoryGateway,Scope
from assistant_memory.v2 import dispatch
now=['2026-11-07T10:00:00+00:00']
with MemoryGateway(sys.argv[2],Scope(sys.argv[3],sys.argv[4]),clock=lambda:now[0]) as m:
 text='我习惯使用 PyCharm 写 Python 进行开发'
 dispatch(m,sys.argv[1],'daily_ingest',dict(text=text,event_id='synthetic-editor',session_id='seed',source_channel='orb_daily'))
 now[0]='2026-11-08T10:00:00+00:00'
 batch=dispatch(m,sys.argv[1],'daily_pending',{})
 result=dispatch(m,sys.argv[1],'daily_commit',dict(batch=batch,candidates=[dict(source_event_id=batch['events'][0]['event_id'],quote=text,key='software.editor')]))
 assert result['automatic']==1,result
 print(json.dumps(result))`;
  const {stdout}=await promisify(execFile)(config.python,['-B','-c',seed,root,process.env.DSH_MEMORY_DB,scope.user,scope.project],{windowsHide:true});
  const memoryId=JSON.parse(stdout).memory_ids[0];
  let calls=0,revoke=false;
  const ctx={llm:{async *stream(request){
    calls++;assert.deepEqual(request.tools,[]);assert.equal(request.messages.length,1);
    const payload=JSON.parse(request.messages[0].content[0].text);
    assert(payload.memory_context.some(item=>item.memory_id===memoryId&&item.content.includes('PyCharm')));
    if(revoke)await callMemory({root,...scope,op:'revoke',args:{memory_id:memoryId}});
    yield {type:'text-delta',index:0,text:JSON.stringify({supported:true,answer:'你习惯用 PyCharm 写 Python。'})};
    yield {type:'finish',reason:{kind:'stop'}};
  }}};
  const sessions=new Map(['one','two'].map(id=>[id,{id,header:{cwd:workspace,agentPreset:'computer-use'}}]));
  service=createOrbMemoryService({root,workspace,memory,ctx,sessionForId:id=>sessions.get(id),isBusy:()=>false});
  const code=await readFile(join(root,'dsh_orb_full_orig/dist/host/index.js'),'utf8');
  const start=code.indexOf('\tasync onPrompt(text, lassoId) {'),end=code.indexOf('\n\t/** Start one new turn',start);
  assert(start>=0&&end>start);
  const onPrompt=new Function('randomUUID',`return (${code.slice(start,end).trim().replace(/^async onPrompt/,'async function')});`)(randomUUID);
  const shown=[];let native=0;
  const ui={ctx:{get:()=>service},sessionId:'one',transcriptEpoch:1,turnRunning:false,
    block:(id,role,text)=>shown.push({role,text}),ensureSession:async()=>ui.sessionId,preempt:async()=>native++};
  const started=performance.now();
  await onPrompt.call(ui,'我用什么写 Python');assert.match(shown.at(-1).text,/PyCharm/);
  const coldMs=Math.round(performance.now()-started);
  const task=await service.taskContext('帮我打开 Python 开发工具','one',new AbortController().signal);
  assert(task.enabled&&/^[a-f0-9]{64}$/.test(task.generation));
  assert(task.items.some(item=>item.memory_id===memoryId&&item.content.includes('PyCharm')));
  ui.sessionId='two';revoke=true;
  await onPrompt.call(ui,'我用什么写 Python');assert.match(shown.at(-1).text,/旧结果未显示/);
  await onPrompt.call(ui,'我用什么写 Python');assert.match(shown.at(-1).text,/没有查到/);
  assert.equal(native,0);assert.equal(calls,2);
  const report={passed:true,real_sqlite:true,real_daily_commit:true,real_resident_retrieval:true,
    exact_development_onPrompt:true,ui_fixture:true,real_orb_app:false,fake_model_requests:calls,
    task_action_semantic_recall:true,revoked_answer_suppressed:true,revoked_memory_not_recalled:true,cold_recall_ms:coldMs,
    production_database_accessed:false,paid_requests:0};
  await writeFile(join(root,'results/memory/orb-natural-recall-smoke.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
}finally{
  await service?.dispose();memory?.dispose();
  if(oldDb===undefined)delete process.env.DSH_MEMORY_DB;else process.env.DSH_MEMORY_DB=oldDb;
  if(oldPython===undefined)delete process.env.DSH_MEMORY_PYTHON;else process.env.DSH_MEMORY_PYTHON=oldPython;
  await rm(dir,{recursive:true,force:true});
}
