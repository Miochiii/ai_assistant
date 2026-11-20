// Native registry contract check with a fixture tool body and session log.
// No desktop capture, credentials, network, or live-host claim.
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { root } from '../plugins/dsh-desktop-observe/bridge.js';
import { hostCheckCommand } from '../plugins/dsh-desktop-observe/host-check.js';
const base='E:/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/';
const {Context}=await import(pathToFileURL(base+'cordis/lib/index.js'));
const {CommandRuntime}=await import(pathToFileURL(base+'dsh-commands/lib/index.js'));
const {ToolRuntime}=await import(pathToFileURL(base+'dsh-tools/lib/index.js'));
const ctx=new Context();
ctx.provide('systemPrompt',{tools:()=>()=>{}});
const registry=new ToolRuntime(ctx);
const commands=new CommandRuntime(ctx);
let captured, executions=0;
const events=[];
const agent={session:{header:{cwd:root,id:'native-command-offline'},append:(type,data)=>{events.push({type,data});}}};
const disposeTool=registry.register({name:'desktop_monitors',description:'Offline monitor fixture',
  parameters:{type:'object',additionalProperties:false,properties:{}},
  output:{schema:{type:'object',additionalProperties:true},render:(_,v)=>[{type:'text',text:JSON.stringify(v)}]},
  execute:async()=>{executions++;return {read_only:true,coordinate_space:'physical_pixels',monitors:[{index:1,width:100,height:100}]};}});
const disposeCommand=commands.register(hostCheckCommand(ctx,{save:async report=>{captured=report;return 'offline-fixture';}}));
try {
  const result=await commands.execute(agent,'/desktop-check',[],new AbortController().signal);
  assert.equal(result.result.kind,'success',result.result.text);
  assert.equal(executions,1);assert.equal(captured.passed,true);
  assert.deepEqual(events.map(e=>e.type),['command/run','command/done']);
  assert.equal(await commands.execute(agent,'/unregistered-check',[],new AbortController().signal),undefined);
  const report={checked_at:new Date().toISOString(),sdk:'DSH 0.2.1-rc.2',command:'desktop-check',
    native_command_registry:true,native_tool_dispatch:true,session_lifecycle:true,
    tool_body_fixture:true,session_fixture:true,running_desktop_host_tested:false,
    model_calls:0,gui_actions:0,screenshot_taken:false};
  await writeFile(join(root,'results/a04/dsh-host-command-contract.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
} finally {disposeCommand();disposeTool();}
