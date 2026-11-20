import {open,readFile,rename,mkdir,unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

export async function atomicJson(path,value) {
  await mkdir(dirname(path),{recursive:true});
  const temp=`${path}.${randomUUID()}.tmp`;
  try {
    const file=await open(temp,'wx');
    try {await file.writeFile(JSON.stringify(value)+'\n');await file.sync();} finally {await file.close();}
    await rename(temp,path);
    const loaded=JSON.parse(await readFile(path,'utf8'));
    if(JSON.stringify(loaded)!==JSON.stringify(value)) throw new Error('CUTOVER_READBACK_FAILED');
  } finally {await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
export function validateState(s) {
  const id=x=>typeof x==='string'&&x.length>0&&x.length<=200;
  if(s?.schema!==1 || !Number.isSafeInteger(s.revision)||s.revision<0
    || !id(s.current)||!id(s.generation)||!Array.isArray(s.retired)
    || !s.retired.every(id)||new Set(s.retired).size!==s.retired.length) throw new Error('INVALID_CUTOVER_STATE');
  if(s.pending!==null && (!id(s.pending?.from)||!id(s.pending?.to)||!id(s.pending?.generation)
    ||s.pending.from!==s.current||s.pending.from===s.pending.to||s.retired.includes(s.pending.to)
    ||!s.retired.includes(s.pending.from))) throw new Error('INVALID_CUTOVER_PENDING');
  if(s.pending===null&&s.retired.includes(s.current)) throw new Error('CURRENT_SESSION_RETIRED');
  return s;
}
export function cutoverStore(path) {
  return {
    async read(){return validateState(JSON.parse(await readFile(path,'utf8')));},
    async write(value){validateState(value);await atomicJson(path,value);},
  };
}
