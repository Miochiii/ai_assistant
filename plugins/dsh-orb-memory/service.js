import {randomUUID} from 'node:crypto';
import {createOrbMemoryBridge} from './bridge.js';
import {DailyMemory} from '../dsh-assistant-host/daily-memory.js';
import {isMemoryQuestion,answerMemoryQuestion} from './recall-answer.js';
import {readTaskContext} from './task-context.js';

// UI control results never enter Harness history or model context.
export function createOrbMemoryService({root,workspace,memory,ctx,sessionForId,isBusy=()=>true,route={}}) {
  const bridge=createOrbMemoryBridge({root,workspace,enabled:true,host:memory});
  const controlSession={id:'orb-daily-memory-control',header:{cwd:root}};
  const daily=new DailyMemory({memory,session:controlSession,ctx,route});
  let closed=false,pending=0,queue=Promise.resolve(),lastCapture='none',recallController=null;
  const lifetime=new AbortController();
  const handles=text=>/^(自动记忆状态|关闭自动记忆|开启自动记忆|整理昨日记忆)$/.test(text)
    || /^(记住[，,:：]|查记忆[：:])\s*\S/u.test(text);
  function enqueue(fn){
    pending++;
    const task=queue.then(()=>{if(closed)throw new Error('MEMORY_SERVICE_CLOSED');return fn();});
    queue=task.catch(()=>{}).finally(()=>{pending--;});
    return task;
  }
  async function tick(){
    if(closed||pending||isBusy())return;
    await daily.tick();
  }
  async function onEvent(session,event){
    if(closed||!bridge.accepts(session))return;
    // Avoid scheduling work for chunks/agent events; only committed source input.
    if(event?.type!=='user/message'||event.data?.source?.kind!=='user')return;
    try {await enqueue(async()=>{const result=await bridge.onSessionEvent(session,event,lifetime.signal);lastCapture=result?.status??'unavailable';});}
    catch {lastCapture='failed';}
  }
  async function control(text,sessionId,eventId=randomUUID()){
    if(!handles(text))throw new Error('UNKNOWN_MEMORY_CONTROL');
    const session=sessionForId(sessionId);
    if(!bridge.accepts(session))return '当前会话不属于已启用的 Orb 工作区，未执行记忆操作。';
    return enqueue(async()=>{
      const mapped={id:session.id,header:{...session.header,cwd:root}};
      if(text==='关闭自动记忆'||text==='开启自动记忆'){
        recallController?.abort();
        daily.stop();daily.next=0;
        const result=await memory.v2(mapped,'daily_configure',{enabled:text==='开启自动记忆'},lifetime.signal);
        if(!result)throw new Error('MEMORY_UNAVAILABLE');
        return result.enabled?`自动记忆采集、跨日整理与个人记忆问答已开启。可以直接问“我用什么写 Python”。${ctx.get?.('orbTaskMemory')?'桌面任务也会检索有效记忆。':'桌面操作上下文暂不自动注入记忆。'}`
          :'自动记忆采集、整理与个人记忆问答已关闭，待处理队列已取消；已有记忆保留，可显式查询。';
      }
      if(text==='自动记忆状态'){
        const status=await memory.v2(mapped,'daily_status',{},lifetime.signal);
        if(!status)return '记忆服务不可用，请检查工作区与配置。';
        const task=ctx.get?.('orbTaskMemory');
        if(task)await task.ready;
        const taskStatus=!task?'未启用':task.inspect().fault?'服务异常，操作受阻':status.enabled?'开启':'关闭（旧会话失效检查仍启用）';
        return `Orb 记忆接入已加载\n采集与跨日整理：${status.enabled?'开启':'关闭'}\n最近采集：${lastCapture}\n整理状态：${daily.status}\n最近整理结果：${daily.last?JSON.stringify(daily.last):'暂无'}\n个人记忆自动问答：${status.enabled?'开启':'关闭'}\n操作任务上下文注入：${taskStatus}\n可用：记住：内容；查记忆：关键词；关闭自动记忆；开启自动记忆；整理昨日记忆。`;
      }
      if(text==='整理昨日记忆'){
        if(isBusy())return 'Orb 正在处理任务，请在空闲时再整理。';
        daily.next=0;await daily.tick();
        return `整理状态：${daily.status}。${daily.last?JSON.stringify(daily.last):'没有领取到待整理批次（仅处理已经结束的日期）。'}`;
      }
      // Preserve the legacy explicit-only notes contract; daily sources use orb_daily.
      return memory.panelMemory(mapped,{text,eventId,signal:lifetime.signal});
    }).catch(error=>`记忆操作未完成：${error.code||error.name||'MEMORY_ERROR'}。`);
  }
  async function answerRecall(text,sessionId,onPending){
    if(closed||!isMemoryQuestion(text)||isBusy())return null;
    const session=sessionForId(sessionId);
    if(!bridge.accepts(session))return null;
    recallController?.abort();
    const controller=new AbortController();recallController=controller;
    const signal=AbortSignal.any([lifetime.signal,controller.signal,AbortSignal.timeout(120000)]);
    try {return await answerMemoryQuestion({memory,ctx,route,text,signal,onPending,session:{id:session.id,header:{...session.header,cwd:root}}});}
    catch(error){
      if(controller.signal.aborted||closed)return '';
      return error.message==='MEMORY_CHANGED'?'记忆状态刚刚发生变化，本次旧结果未显示，请重新提问。':'记忆查询暂时未完成，请稍后重试或使用“查记忆：关键词”。';
    }finally{if(recallController===controller)recallController=null;}
  }
  async function taskContext(text,sessionId,signal){
    const session=sessionForId(sessionId);
    if(closed||!bridge.accepts(session))throw new Error('MEMORY_WORKSPACE_UNAVAILABLE');
    return readTaskContext(memory,{id:session.id,header:{...session.header,cwd:root}},text,signal);
  }
  return {handles,control,onEvent,tick,answerRecall,isMemoryQuestion,taskContext,abortRecall:()=>recallController?.abort(),
    async dispose(){closed=true;lifetime.abort();recallController?.abort();daily.stop();bridge.dispose();await queue;},
  };
}
