// Offline end-to-end Host -> SQLite -> persistent worker -> SQLite revalidation.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createMemoryHost} from '../plugins/dsh-desktop-observe/memory.js';
import {callMemory} from '../plugins/dsh-desktop-observe/memory-client.js';

const root=resolve(fileURLToPath(new URL('../',import.meta.url)));
const parent=join(root,'runtime/memory-tests');await mkdir(parent,{recursive:true});
const temp=await mkdtemp(join(parent,'resident-host-'));
const oldDb=process.env.DSH_MEMORY_DB;process.env.DSH_MEMORY_DB=join(temp,'test.sqlite3');
const host=createMemoryHost({root});
const session={id:'offline-resident-smoke',header:{cwd:root}};
const core=(op,args={})=>callMemory({root,...host.scope(session),op,args});
let partition;
try {
  const text='我平时用 PyCharm 编写 Python 程序';
  await core('event',{event_id:'source',session_id:session.id,channel:'offline-test',origin:'user',content:text});
  const mid=await core('remember',{kind:'preference',key:'fixture.editor',content:text,source_event_ids:['source']});
  const snapshot=await core('rag_snapshot',{query:'PyCharm'});
  partition=join(root,'runtime/memory/indexes',createHash('sha256').update(snapshot.scope).digest('hex'));
  const cold=await host.v2(session,'rag_recall',{query:'我平时用什么软件编写 Python？'});
  const warm=await host.v2(session,'rag_recall',{query:'我常用的 Python 编辑器是什么？'});
  assert.equal(cold.engine,'hybrid_resident');assert.equal(warm.engine,'hybrid_resident');
  assert.equal(cold.items[0].memory_id,mid);assert.equal(warm.items[0].memory_id,mid);
  assert.equal(warm.timing.cold_embedding,false);
  await core('revoke',{memory_id:mid});
  const revoked=await host.v2(session,'rag_recall',{query:'PyCharm'});
  assert.deepEqual(revoked.items,[]);assert.notEqual(revoked.version,warm.version);
  const report={ok:true,api_calls:0,temporary_database:true,revoked_not_returned:true,
    cold:cold.timing,warm:warm.timing};
  await mkdir(join(root,'results/memory'),{recursive:true});
  await writeFile(join(root,'results/memory/resident-host-smoke.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally {
  host.dispose();
  if(oldDb===undefined)delete process.env.DSH_MEMORY_DB;else process.env.DSH_MEMORY_DB=oldDb;
  if(partition){assert.equal(dirname(resolve(partition)),join(root,'runtime/memory/indexes'));
    await rm(partition,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
  assert.equal(dirname(resolve(temp)),parent);
  await rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
