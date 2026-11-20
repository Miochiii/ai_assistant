import {realpathSync} from 'node:fs';
import {createMemoryHost} from '../dsh-desktop-observe/memory.js';
import {createOrbMemoryService} from './service.js';
import {createMemoryGenerationProvider} from './generation.js';
export const name='orb-memory';
export const inject=['sessions','agents','llm'];
export function apply(ctx,config={}) {
  const root=realpathSync.native(config.root),workspace=realpathSync.native(config.workspace);
  const memory=createMemoryHost({root,userId:config.userId,residentGeneration:true});
  const belongs=agent=>agent?.session?.header?.agentPreset==='computer-use'
    && agent.session.header.cwd?.toLowerCase()===workspace.toLowerCase();
  // AgentRegistry does not expose a stable global iterator here; the live source
  // sessions we observe are sufficient for delaying consolidation while active.
  const observed=new Set();
  const service=createOrbMemoryService({root,workspace,memory,ctx,
    sessionForId:id=>ctx.sessions.get(id),
    isBusy:()=>[...observed].some(id=>{
      const agent=ctx.agents.get(id);
      return belongs(agent)&&(agent.status!=='idle'||agent.inbox.nextTurn.length||agent.inbox.nextStep.length);
    }),route:{provider:config.provider??'deepseek-official',model:config.model??'deepseek-flash'}});
  ctx.provide('orbMemory',service);
  ctx.provide('orbMemoryGeneration',createMemoryGenerationProvider({memory,session:{id:'orb-memory-control',header:{cwd:root}}}));
  const off=ctx.on('session/event',(session,event)=>{
    if(session.header.agentPreset==='computer-use'&&session.header.cwd?.toLowerCase()===workspace.toLowerCase())observed.add(session.id);
    void service.onEvent(session,event);
  });
  const timer=setInterval(()=>{void service.tick().catch(()=>{});},60000);
  timer.unref?.();
  ctx.effect(()=>async()=>{clearInterval(timer);off();await service.dispose();memory.dispose();});
}
