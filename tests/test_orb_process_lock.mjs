import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {acquireOrbCutoverLocks} from '../plugins/dsh-orb-memory/process-lock.js';
test('both shared state and shared binding exclude owners; failed partial acquisition releases its lock',async()=>{
  const dir=await mkdtemp(fileURLToPath(new URL('../tmp/orb-pair-lock-',import.meta.url)));
  const path=name=>join(dir,name);
  let owner,retry;
  try {
    owner=await acquireOrbCutoverLocks(path('state'),path('binding'));
    await assert.rejects(acquireOrbCutoverLocks(path('state'),path('a-other-binding')),/ORB_BINDING_IN_USE/);
    await assert.rejects(acquireOrbCutoverLocks(path('other-state'),path('binding')),/ORB_BINDING_IN_USE/);
    retry=await acquireOrbCutoverLocks(path('other-state'),path('a-other-binding'));await retry.release();retry=null;
    await owner.release();owner=null;
    retry=await acquireOrbCutoverLocks(path('state'),path('binding'));
  } finally {await retry?.release();await owner?.release();await rm(dir,{recursive:true,force:true});}
});
