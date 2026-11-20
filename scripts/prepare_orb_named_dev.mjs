import {cp,readFile,writeFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url));
const source=join(root,'runtime/dev-orb-memory/orb'),target=join(root,'dsh_orb_full_orig');
if((await readdir(target)).length)throw new Error('Target is not empty; refusing overwrite');
const manifest=JSON.parse(await readFile(join(root,'runtime/dev-orb-memory/manifest.json'),'utf8'));
const hash=v=>createHash('sha256').update(v).digest('hex');
if(hash(await readFile(join(source,'dist/host/index.js')))!==manifest.patched_host_sha256)throw new Error('Unexpected development host');
for(const [name,value] of Object.entries(manifest.extension_sha256)){
  if(hash(await readFile(join(source,'dist/host/memory-extension',name)))!==value)throw new Error('Unexpected development extension');
}
for(const name of await readdir(source))await cp(join(source,name),join(target,name),{recursive:true,dereference:true,force:false,errorOnExist:true});
const pkg=JSON.parse(await readFile(join(target,'package.json'),'utf8'));
pkg.name='dsh-orb-mio-dev';pkg.version='0.2.1-mio-dev.1';pkg.private=true;
pkg.description='Orb 开发版 · Mio — 本地记忆接入开发包（自动记忆闭环尚未启用）';
await writeFile(join(target,'package.json'),JSON.stringify(pkg,null,2)+'\n');
let patch=await readFile(join(target,'cordis.patch.yml'),'utf8');
patch=patch.replaceAll('dsh-orb','dsh-orb-mio-dev').replace('name: Computer Use 模式','name: Orb 开发版（Computer Use）');
await writeFile(join(target,'cordis.patch.yml'),patch);
let client=await readFile(join(target,'client.js'),'utf8');
client=client.replace("id: 'dsh-orb'","id: 'dsh-orb-mio-dev'").replace("nav: '悬浮球'","nav: 'Orb 开发版 · Mio'").replace("nav: 'Floating ball'","nav: 'Orb Dev · Mio'");
await writeFile(join(target,'client.js'),client);
let host=await readFile(join(target,'dist/host/index.js'),'utf8');
function replaceOnce(from,to){if(host.split(from).length!==2)throw new Error('Ambiguous anchor: '+from);host=host.replace(from,to);}
// This local fork is managed in the workspace, not by the upstream updater.
replaceOnce('\tasync check(manual = false) {','\tasync check(manual = false) {\n\t\tif (this.own?.name === "dsh-orb-mio-dev") return;');
replaceOnce('\t\tcanUpdate: this.own !== void 0 && isPluginManager(this.deps.manager()),','\t\tcanUpdate: this.own?.name !== "dsh-orb-mio-dev" && this.own !== void 0 && isPluginManager(this.deps.manager()),');
replaceOnce('\t\tconst detachUpdates = updater.start();','\t\tconst detachUpdates = () => {}; // local development package: no upstream updater');
replaceOnce('\tconsole.error(`dsh-orb: profile ${store.dir}`);','\tconsole.error(`dsh-orb-mio-dev: loaded from ${ownPackageRoot()} (0.2.1-mio-dev.1)`);\n\tconsole.error(`dsh-orb: profile ${store.dir}`);');
await writeFile(join(target,'dist/host/index.js'),host);
await writeFile(join(target,'MIO-DEVELOPMENT.json'),JSON.stringify({name:pkg.name,version:pkg.version,
  label:'Orb 开发版 · Mio',base:'dsh-orb@0.2.1',source_manifest:manifest,host_sha256:hash(host),
  memory_auto_injection:false,cutover_enabled:false,upstream_updates:false,created_at:new Date().toISOString()},null,2)+'\n');
console.log(JSON.stringify({target,name:pkg.name,version:pkg.version}));
