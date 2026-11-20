// Read current memory through the same Host used by Orb; no model or desktop action.
// Only report types and errors, never memory text.
import {fileURLToPath} from 'node:url';
import {writeFile} from 'node:fs/promises';
import {createMemoryHost} from '../plugins/dsh-desktop-observe/memory.js';
import {readTaskContext} from '../plugins/dsh-orb-memory/task-context.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const memory=createMemoryHost({root,residentGeneration:true});
const session={id:'orb-task-diagnostic',header:{cwd:root}};
const signal=AbortSignal.timeout(120000);
const observed=[];
async function report(value){
  const safe={checked_at:new Date().toISOString(),production_memory_read:true,model_requests:0,desktop_actions:0,...value};
  await writeFile(new URL('../results/memory/orb-task-diagnostic.json',import.meta.url),JSON.stringify(safe,null,2)+'\n');
  console.log(JSON.stringify(safe));
}
try{
  const wrapper={v2:async(...args)=>{
    const result=await memory.v2(...args);
    observed.push({op:args[1],available:!!result,enabled:result?.enabled,
      itemTypes:result?.items?.map(item=>({idType:typeof item.memory_id,contentType:typeof item.content,array:Array.isArray(item.content)}))});
    return result;
  }};
  const result=await readTaskContext(wrapper,session,'帮我打开 Python 开发工具，在名字是program的磁铁盒子里面。',signal);
  await report({ok:true,items:result.items.length,observed});
}catch(error){await report({ok:false,error:error.message,observed});process.exitCode=1;}
finally{memory.dispose();}
