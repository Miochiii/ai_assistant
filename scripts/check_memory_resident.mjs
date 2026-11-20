// Offline smoke: real resident Python/BGE worker, synthetic notes, no user DB/API.
import assert from 'node:assert/strict';
import {readFile,rm,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,dirname,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {once} from 'node:events';
import {MemoryRagClient} from '../plugins/dsh-desktop-observe/memory-rag-client.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const config=JSON.parse(await readFile(join(root,'configs/memory-v2.json'),'utf8'));
const scope='resident-smoke-'+randomUUID();
const parent=resolve(root,'runtime/memory/indexes');
const partition=join(parent,createHash('sha256').update(scope).digest('hex'));
const worker=new MemoryRagClient({root,timeoutMs:120000});
const notes=['我平时用 PyCharm 编写 Python 程序','我喜欢喝无糖乌龙茶','讲步骤时短一点','我喜欢蓝色',
  '午饭吃米饭','我喜欢钢琴曲','晚上十一点睡觉','周末喜欢散步','我喜欢阅读科幻小说','我用日历记录安排',
  '我喜欢清淡的早餐','我的画画工具是铅笔','我喜欢猫','我喜欢坐火车旅行','我喜欢晴天'];
const request={scope,query:'我平时用什么软件编写 Python？',items:notes.map((text,i)=>({memory_id:i?'fixture-'+i:'editor',text}))};
try {
  const cold=await worker.request(config,request);
  const firstPid=worker.proc.child.pid;
  const warm=await worker.request(config,request);
  assert.equal(cold.ok,true);assert.equal(warm.ok,true);
  assert.equal(cold.ids[0],'editor');assert.equal(warm.ids[0],'editor');
  assert.equal(worker.proc.child.pid,firstPid);
  assert.equal(warm.timing.cold_embedding,false);assert.equal(warm.timing.cold_reranker,false);
  assert.equal(warm.timing.embedding_load_ms,0);assert.equal(warm.timing.reranker_load_ms,0);
  const report={at:new Date().toISOString(),ok:true,synthetic_count:notes.length,api_calls:0,
    same_process:true,cold:cold.timing,warm:warm.timing};
  const output=join(root,'results/memory/resident-worker-smoke.json');
  await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally {
  const child=worker.proc?.child;
  const closed=child && child.exitCode===null ? once(child,'close') : Promise.resolve();
  worker.dispose();await closed;
  assert.equal(dirname(resolve(partition)),parent);
  await rm(partition,{recursive:true,force:true});
}
