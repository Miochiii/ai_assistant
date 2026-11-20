// One app-level owner. The driver owns Orb UI, admission and persistence.
// No model-facing tools, memory text or automatic task cancellation.
export class MemoryCutoverService {
  constructor({store,driver}) {this.store=store;this.driver=driver;this.state=null;this.fault='NOT_LOADED';this.locked=false;}
  inspectBinding(){return {apiVersion:1,state:this.state?structuredClone(this.state):null,
    locked:this.locked,fault:this.fault,...this.driver.inspect()};}
  permits(sessionId){return !this.fault&&!this.locked&&!this.state?.pending&&!this.state.retired.includes(sessionId);}
  async load(){
    try {this.state=await this.store.read();this.fault=null;}
    catch(error){this.fault='STATE_UNAVAILABLE';throw error;}
  }
  // Explicit first enrollment only, never an automatic missing-file recovery.
  async initialize({sessionId,generation}){
    if(this.locked)throw new Error('CUTOVER_BUSY');
    this.locked=true;
    try {
      try {await this.store.read();throw new Error('STATE_ALREADY_EXISTS');}
      catch(error){if(error.code!=='ENOENT')throw error;}
      await this.driver.checkInitial(sessionId);
      const next={schema:1,revision:0,current:sessionId,generation,retired:[],pending:null};
      await this.store.write(next);this.state=next;this.fault=null;
    } finally {this.locked=false;}
  }
  async commitMemoryCutover(prepared,expectedRevision){
    if(this.locked||this.fault||!this.state||this.state.pending)throw new Error('CUTOVER_UNAVAILABLE');
    this.locked=true;
    try {
      const s=this.state;
      if(expectedRevision!==s.revision||prepared.status!=='prepared'||prepared.bindingChanged!==false
        ||prepared.previousSessionId!==s.current||prepared.sessionId===s.current
        ||s.retired.includes(prepared.sessionId))throw new Error('CUTOVER_CONFLICT');
      await this.driver.checkPrepared(prepared,s);
      // Persist retirement before either binding or UI can move. All admission
      // remains blocked if any subsequent operation fails.
      const pending={...s,retired:[...s.retired,s.current],pending:{from:s.current,to:prepared.sessionId,generation:prepared.memoryVersion}};
      this.state=pending;
      await this.store.write(pending);
      return await this.finish();
    } catch(error){if(this.state?.pending)this.fault='RECOVERY_REQUIRED';throw error;}
    finally {this.locked=false;}
  }
  async finish(){
    const s=this.state,p=s.pending;
    await this.driver.validateRecovery(p);
    const saved=await this.driver.readBinding();
    if(saved!==p.from&&saved!==p.to)throw new Error('BINDING_CONFLICT');
    if(saved!==p.to)await this.driver.writeBinding(p.to);
    if(await this.driver.readBinding()!==p.to)throw new Error('BINDING_READBACK_FAILED');
    await this.driver.applyBinding(p.to);
    const next={...s,revision:s.revision+1,current:p.to,generation:p.generation,pending:null};
    await this.store.write(next);this.state=next;this.fault=null;
    return {status:'committed',sessionId:next.current,revision:next.revision,memoryVersion:next.generation};
  }
  async recover(){
    if(this.locked)throw new Error('CUTOVER_BUSY');
    this.locked=true;
    try {
      await this.load();
      if(this.state.pending)return await this.finish();
      const binding=await this.driver.readBinding();
      if(this.state.retired.includes(binding))throw new Error('RETIRED_BINDING');
      // A user may have explicitly switched to another non-retired chat.
      // Do not silently override that choice during startup recovery.
      return {status:'ready',sessionId:binding};
    } catch(error){this.fault='RECOVERY_REQUIRED';throw error;}
    finally {this.locked=false;}
  }
}
