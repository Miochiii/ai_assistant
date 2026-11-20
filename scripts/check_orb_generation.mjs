// Real CLI + SQLite + Host generation provider, isolated database only.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createMemoryHost} from '../plugins/dsh-desktop-observe/memory.js';
import {callMemory} from '../plugins/dsh-desktop-observe/memory-client.js';
import {createMemoryGenerationProvider} from '../plugins/dsh-orb-memory/generation.js';
import {MemoryRagClient} from '../plugins/dsh-desktop-observe/memory-rag-client.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const dir=await mkdtemp(join(root,'tmp/orb-generation-'));
const beforeDb=process.env.DSH_MEMORY_DB,beforePython=process.env.DSH_MEMORY_PYTHON;
process.env.DSH_MEMORY_DB=join(dir,'isolated.sqlite3');
process.env.DSH_MEMORY_PYTHON='E:/file/agent/python.v/.venv/Scripts/python.exe';
let host,protocolWorker;
try {
  await mkdir(join(dir,'configs'));
  const config={enabled:true,allowed_workspace:dir};
  const configFile=join(dir,'configs/memory-v2.json');
  await writeFile(configFile,JSON.stringify(config));
  host=createMemoryHost({root:dir,residentGeneration:true,generationRoot:root,call:args=>callMemory({...args,root,runRoot:dir}),userId:'synthetic-orb-user'});
  const session={id:'synthetic-orb-generation',header:{cwd:dir}};
  const provider=createMemoryGenerationProvider({memory:host,session});
  const first=await provider.current();assert.equal(await provider.current(),first);
  await host.v2(session,'daily_configure',{enabled:false});
  const disabled=await provider.current();assert.notEqual(first,disabled);
  assert.equal((await host.v2(session,'rag_version')).version,null);
  await host.v2(session,'daily_configure',{enabled:true});
  const enabled=await provider.current();assert.notEqual(enabled,first);assert.notEqual(enabled,disabled);
  await writeFile(configFile,JSON.stringify({...config,enabled:false}));
  const globalDisabled=await provider.current();assert.notEqual(globalDisabled,enabled);
  protocolWorker=new MemoryRagClient({root,timeoutMs:3000,workerScript:'memory_generation_worker.py',
    argumentsFor:()=>['--root',dir,'--db',process.env.DSH_MEMORY_DB,'--user','synthetic-orb-user',
      '--project',host.scope(session).project,'--workspace',dir]});
  const workerConfig={python:process.env.DSH_MEMORY_PYTHON};
  const direct=await protocolWorker.request(workerConfig,{});
  assert.equal(direct.value.generation,globalDisabled);
  const pid=protocolWorker.proc.child.pid;
  assert.equal((await protocolWorker.request(workerConfig,{op:'remember',content:'must not write'})).ok,false);
  assert.equal((await protocolWorker.request(workerConfig,{})).value.generation,globalDisabled);
  assert.equal(protocolWorker.proc.child.pid,pid);
  await writeFile(configFile,'broken');
  assert.equal((await protocolWorker.request(workerConfig,{})).ok,false);
  await writeFile(configFile,JSON.stringify({...config,enabled:false}));
  assert.equal((await protocolWorker.request(workerConfig,{})).value.generation,globalDisabled);
  await assert.rejects(protocolWorker.request(workerConfig,{padding:'x'.repeat(9000)}));
  assert.equal((await protocolWorker.request(workerConfig,{})).value.generation,globalDisabled);
  assert.notEqual(protocolWorker.proc.child.pid,pid);
  const wrong=createMemoryGenerationProvider({memory:host,session:{id:'other',header:{cwd:root}}});
  await assert.rejects(wrong.current(),/MEMORY_GENERATION_UNAVAILABLE/);
  await writeFile(configFile,'broken');await assert.rejects(provider.current());
  const report={passed:true,real_cli_sqlite:true,resident_generation:true,stable_token:true,consent_off_on:true,global_disable:true,
    real_process_reuse:true,write_payload_rejected:true,worker_config_reload:true,oversized_input_exit_and_restart:true,
    foreign_workspace_rejected:true,unavailable_config_rejected:true,production_database_accessed:false,paid_requests:0};
  await writeFile(join(root,'results/memory/orb-generation-smoke.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
} finally {
  host?.dispose();
  protocolWorker?.dispose();
  if(beforeDb===undefined)delete process.env.DSH_MEMORY_DB;else process.env.DSH_MEMORY_DB=beforeDb;
  if(beforePython===undefined)delete process.env.DSH_MEMORY_PYTHON;else process.env.DSH_MEMORY_PYTHON=beforePython;
  await rm(dir,{recursive:true,force:true});
}
