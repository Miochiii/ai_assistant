// Update only our previously generated extension after verifying its manifest.
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url)),dir=join(root,'runtime/dev-orb-memory');
const hash=b=>createHash('sha256').update(b).digest('hex');
const manifest=JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'));
if(hash(await readFile(join(dir,'orb/dist/host/index.js')))!==manifest.patched_host_sha256)throw new Error('Developer host modified; refusing overwrite');
for(const [name,expected] of Object.entries(manifest.extension_sha256)){
  if(!/^[a-z-]+\.js$/.test(name)||hash(await readFile(join(dir,'orb/dist/host/memory-extension',name)))!==expected)throw new Error('Developer extension modified; refusing overwrite');
}
const additions={};
for(const name of ['orb-host-adapter.js','cutover-service.js','cutover-store.js','process-lock.js']){
  const target=join(dir,'orb/dist/host/memory-extension',name);
  if(!(name in manifest.extension_sha256)){
    try{await readFile(target);throw new Error('Untracked extension exists');}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  additions[name]={target,data:await readFile(join(root,'plugins/dsh-orb-memory',name))};
}
for(const [name,{target,data}] of Object.entries(additions)){
  await writeFile(target,data);manifest.extension_sha256[name]=hash(data);
}
manifest.updated_at=new Date().toISOString();
await writeFile(join(dir,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log('Verified development extension synchronized; installed Orb unchanged.');
