// Produce an isolated, opt-in development bundle; never edit the installed Orb.
import {readFile,writeFile,mkdir,cp,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const source='C:/Users/Mio/.dsh/profiles/desktop/node_modules/dsh-orb';
const output=join(root,'runtime/dev-orb-memory/orb');
const pkg=JSON.parse(await readFile(join(source,'package.json'),'utf8'));
if(pkg.version!=='0.2.1')throw new Error('Unexpected Orb version; re-audit required');
const original=await readFile(join(source,'dist/host/index.js'),'utf8');
const hash=s=>createHash('sha256').update(s).digest('hex');
function replaceOnce(text,from,to){
  if(text.split(from).length!==2)throw new Error('Orb patch anchor missing or ambiguous');
  return text.replace(from,to);
}
let patched='import { installOrbMemoryCutover } from "./memory-extension/orb-host-adapter.js";\n'+original;
patched=replaceOnce(patched,'\tasync newSession() {',`\tasync applyMemoryBinding(sessionId) {
    // The transaction already saved and verified sessionFile. Do not call remember.
    this.sessionId = sessionId;
    this.sessionError = void 0;
    publishScreenOwner(sessionId);
    await this.refreshModelDefaults();
    await this.applyOverlayQuiet(sessionId);
    pinSessionId(this.ctx, sessionId, this.store.permission(), this.store.workspaceDirectory());
    this.resetTranscript();
    this.broadcast({ type: "session", sessionId });
    await this.publishChrome();
  }
\tasync newSession() {`);
patched=replaceOnce(patched,'\tconst runtime = new OrbRuntime(ctx, store, { tcc });',
  '\tconst runtime = new OrbRuntime(ctx, store, { tcc });\n\tif (config.memoryCutover) installOrbMemoryCutover(ctx, runtime, config.memoryCutover);');
// Refuse to overwrite any earlier developer/user copy. Choose a fresh directory
// for another build rather than recursively replacing an unknown tree.
try {await access(output);throw new Error('Development output already exists');}catch(e){if(e.code!=='ENOENT')throw e;}
await mkdir(join(root,'runtime/dev-orb-memory'),{recursive:true});
await cp(source,output,{recursive:true,dereference:true,errorOnExist:true,force:false});
await mkdir(join(output,'dist/host/memory-extension'),{recursive:true});
const extensionHashes={};
for(const name of ['orb-host-adapter.js','cutover-service.js','cutover-store.js','process-lock.js']){
  await cp(join(root,'plugins/dsh-orb-memory',name),join(output,'dist/host/memory-extension',name));
  extensionHashes[name]=hash(await readFile(join(output,'dist/host/memory-extension',name)));
}
await writeFile(join(output,'dist/host/index.js'),patched);
await writeFile(join(root,'runtime/dev-orb-memory/manifest.json'),JSON.stringify({
  created_at:new Date().toISOString(),orb_version:pkg.version,source_host_sha256:hash(original),
  patched_host_sha256:hash(patched),extension_sha256:extensionHashes,opt_in_config:'memoryCutover.stateFile',installed:false,
  limitation:'Development bundle only; no profile switch or auto-injection',
},null,2)+'\n');
console.log(JSON.stringify({prepared:output,installed:false}));
