import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createOrbMemoryService} from '../plugins/dsh-orb-memory/service.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const workspace=fileURLToPath(new URL('../dsh_orb_work',import.meta.url));
const session={id:'orb',header:{cwd:workspace,agentPreset:'computer-use'}};
function fixture(){
  const calls=[];let enabled=true;
  const memory={async v2(s,op,args){calls.push({s,op,args});
    if(op==='daily_configure')enabled=args.enabled;
    if(op==='daily_pending')return {events:[]};
    return {enabled,status:enabled?'recorded':'disabled'};
  },async panelMemory(s,args){calls.push({s,op:'panelMemory',args});return '本地记忆内容';}};
  const service=createOrbMemoryService({root,workspace,memory,sessionForId:id=>id==='orb'?session:null,
    ctx:{llm:{stream(){throw new Error('Controls must not call models');}}},isBusy:()=>false});
  return {service,calls};
}
test('UI controls map the project and return local results without model calls',async()=>{
  const {service,calls}=fixture();
  try {
    assert.match(await service.control('关闭自动记忆','orb'),/已关闭/);
    assert.match(await service.control('自动记忆状态','orb'),/关闭/);
    assert.match(await service.control('开启自动记忆','orb'),/已开启/);
    assert.equal(await service.control('查记忆：编辑器','orb'),'本地记忆内容');
    assert.equal(calls.at(-1).s.header.cwd,root);
    assert.equal(await service.control('记住：测试','orb'),'本地记忆内容');
    assert.match(await service.control('查记忆：测试','foreign'),/未执行/);
  }finally{await service.dispose();}
});
test('only foreground user admissions are captured, disposal stops capture',async()=>{
  const {service,calls}=fixture();
  const event={type:'user/message',surfaceOp:'append',data:{id:'m',source:{kind:'user',rpcId:'r'},content:[{type:'text',text:'我习惯用 PyCharm'}]}};
  await service.onEvent({...session,header:{...session.header,agentPreset:'standard'}},event);
  await service.onEvent(session,{...event,data:{...event.data,source:{kind:'computer-use'}}});
  assert.equal(calls.length,0);
  await service.onEvent(session,event);assert.equal(calls[0].op,'daily_ingest');
  assert.equal(calls[0].args.source_channel,'orb_daily');
  await service.dispose();await service.onEvent(session,event);assert.equal(calls.length,1);
});
test('manual consolidation observes the ended-day pipeline, not a model chat',async()=>{
  const {service,calls}=fixture();
  try {assert.match(await service.control('整理昨日记忆','orb'),/仅处理已经结束/);assert.equal(calls[0].op,'daily_pending');}
  finally{await service.dispose();}
});
