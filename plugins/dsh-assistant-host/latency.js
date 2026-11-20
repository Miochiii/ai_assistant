import {mkdir,writeFile,rename,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

// One bounded, content-free last-turn record. Do not persist user/session text.
const directory=fileURLToPath(new URL('../../runtime/memory/latency/',import.meta.url));
export async function recordLatency(timing) {
  const temp=join(directory,randomUUID()+'.tmp');
  try {
    await mkdir(directory,{recursive:true});
    await writeFile(temp,JSON.stringify({at:new Date().toISOString(),...timing}));
    await rename(temp,join(directory,'latest-panel.json'));
  } catch { /* diagnostics never block a reply */ }
  finally {await rm(temp,{force:true}).catch(()=>{});}
}
