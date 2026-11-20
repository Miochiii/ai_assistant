import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const dir=await mkdtemp(join(root,'tmp/orb-process-lock-'));
const moduleUrl=new URL('../plugins/dsh-orb-memory/process-lock.js',import.meta.url).href;
const source=`import {acquireOrbBindingLock} from ${JSON.stringify(moduleUrl)};
try { const lock=await acquireOrbBindingLock(process.argv[1]);
process.stdout.write('acquired\\n');
if(process.argv[2]==='hold')process.stdin.resume();else await lock.release();
}catch(e){process.stdout.write(e.message+'\\n');process.exitCode=2;}`;
const children=[];
function run(path,hold=false){
  const child=spawn(process.execPath,['--input-type=module','-e',source,path,hold?'hold':'once'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  children.push(child);
  let output='',stderr='';
  child.stderr.on('data',b=>stderr+=b);
  const closed=new Promise(resolve=>child.once('close',resolve));
  const line=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(new Error('lock child timeout: '+stderr));},10000);
    child.once('error',e=>{clearTimeout(timer);reject(e);});
    child.stdout.on('data',b=>{output+=b;if(output.includes('\n')){clearTimeout(timer);resolve(output.trim());}});
    child.once('close',()=>{clearTimeout(timer);if(!output.includes('\n'))reject(new Error(stderr||'No lock receipt'));});
  });
  return {child,line,closed};
}
try {
  const path=join(dir,'binding.json');
  const owner=run(path,true);assert.equal(await owner.line,'acquired');
  const contender=run(path.toUpperCase());assert.equal(await contender.line,'ORB_BINDING_IN_USE');assert.equal(await contender.closed,2);
  owner.child.kill();await owner.closed;
  const recovered=run(path);assert.equal(await recovered.line,'acquired');assert.equal(await recovered.closed,0);
  const report={passed:true,two_process_exclusion:true,case_alias_same_lock:true,process_death_releases_lock:true,pid_reclamation_used:false};
  await writeFile(join(root,'results/memory/orb-process-lock-smoke.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
} finally {
  for(const child of children)if(child.exitCode===null)child.kill();
  await rm(dir,{recursive:true,force:true});
}
