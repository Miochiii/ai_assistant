import {createServer} from 'node:net';
import {realpath,mkdir} from 'node:fs/promises';
import {dirname,basename} from 'node:path';
import {createHash} from 'node:crypto';

// Windows named pipe ownership is released by the OS even after process death.
// No PID guessing, stale lock deletion, sockets exposed over TCP, or lock TTL.
export async function acquireOrbBindingLock(bindingFile) {
  if(process.platform!=='win32')throw new Error('BINDING_LOCK_PLATFORM_UNSUPPORTED');
  await mkdir(dirname(bindingFile),{recursive:true});
  const key=((await realpath(dirname(bindingFile)))+'/'+basename(bindingFile)).toLowerCase();
  const name='\\\\.\\pipe\\dsh-orb-memory-'+createHash('sha256').update(key).digest('hex');
  const server=createServer(socket=>socket.destroy());
  await new Promise((resolve,reject)=>{
    server.once('error',reject);server.listen(name,()=>{server.removeListener('error',reject);resolve();});
  }).catch(error=>{server.close(()=>{});throw Object.assign(new Error('ORB_BINDING_IN_USE'),{cause:error});});
  let released=false;
  return {name,async release(){
    if(released)return;released=true;
    await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  }};
}

// Both identities matter: two profiles must not share one state ledger, and
// two different ledgers must not independently control the same Orb binding.
export async function acquireOrbCutoverLocks(stateFile,bindingFile) {
  const held=[];
  try {
    for(const path of [stateFile,bindingFile].sort())held.push(await acquireOrbBindingLock(path));
    return {async release(){for(const lock of held.reverse())await lock.release();}};
  } catch(error){for(const lock of held.reverse())await lock.release();throw error;}
}
