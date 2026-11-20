import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {MemoryStore,ArchiveStore,SuggestionQueue} from '../third_party/dsh-memory-evolve/lib/store.js';
import {enqueueSuggestion} from '../third_party/dsh-memory-evolve/lib/review.js';
const config=JSON.parse(await readFile(new URL('../configs/evolve-integration.json',import.meta.url)));
const backup=new URL('../runtime/evolve-install/20261111/',import.meta.url);
const data=JSON.parse(await readFile(new URL('legacy-export.json',backup)));
const reportFile=new URL('migration.json',backup);
if(existsSync(reportFile))throw new Error('Migration already completed');
const cwd='E:\\file\\agent\\ai assistant\\dsh_orb_work';
const agent={id:'legacy-migration',session:{header:{cwd}}};
const store=new MemoryStore(config.memoryDir,config),archive=new ArchiveStore(config.memoryDir);
const queue=new SuggestionQueue(config.memoryDir+'/SUGGESTIONS.jsonl');
const report={active:0,archived:0,candidates:0,excluded:0,mapping:[]};
for(const item of data.items){
  const body=typeof item.content==='string'?item.content:JSON.stringify(item.content);
  const content=`${body}\n（旧记忆来源：${item.memory_id}；记录时间：${item.recorded_at}）`;
  let destination;
  if(item.reason==='candidate'){
    enqueueSuggestion(queue,'key',content,'从旧库迁移的待确认条目，尚未生效。',agent);
    destination='candidate';report.candidates++;
  }else if(item.reason==='selected'){
    if(item.automatic_eligible&&['fact','preference','profile'].includes(item.kind)){
      const result=store.add('key',content,agent);if(!result.ok)throw new Error('Active import rejected');
      destination='key';report.active++;
    }else{
      archive.append('key',content,cwd);destination='archive';report.archived++;
    }
  }else{destination='legacy-export-only';report.excluded++;}
  report.mapping.push({memory_id:item.memory_id,destination});
}
await mkdir(config.memoryDir,{recursive:true});
await writeFile(config.memoryDir+'/legacy-migration.json',JSON.stringify(report,null,2)+'\n');
await writeFile(reportFile,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({active:report.active,archived:report.archived,candidates:report.candidates,excluded:report.excluded}));
