// Session-scoped logical request limiter. Not installed by the plugin yet.
// This is NOT a monetary budget: adapter-internal HTTP and token billing need
// separate verification before a paid full-session trial is enabled.
export function installRequestLimit(ctx, policy) {
  const {sessionId, provider, model, maxRequests, maxOutputTokens, maxRequestBytes}=policy;
  if (![sessionId,provider,model].every(x=>typeof x==='string'&&x.length>0)
      || ![maxRequests,maxOutputTokens,maxRequestBytes].every(x=>Number.isSafeInteger(x)&&x>0)) {
    throw new Error('Invalid session request limit');
  }
  let requests=0, rejected=0;
  const dispose=ctx.on('llm/stream',(options,next)=>{
    if(options.sessionId!==sessionId)return next();
    return (async function*(){
      options.signal?.throwIfAborted();
      const bytes=Buffer.byteLength(JSON.stringify({messages:options.messages,tools:options.tools,
        system:options.system,toolHistory:options.toolHistory}));
      if(options.provider!==provider||options.model!==model
          ||!Number.isSafeInteger(options.maxTokens)||options.maxTokens<1||options.maxTokens>maxOutputTokens
          ||bytes>maxRequestBytes||requests>=maxRequests) {
        rejected++;
        const error=new Error('SESSION_REQUEST_LIMIT: route, size, output or request count rejected');
        error.code='SESSION_REQUEST_LIMIT';throw error;
      }
      // Reserve synchronously before dispatch. Errors and retries consume slots.
      requests++;
      yield* next();
    })();
  });
  return {dispose,snapshot:()=>({requests,rejected,max_requests:maxRequests,
    session_id:sessionId,limit_scope:'logical_llm_streams',monetary_budget_enforced:false})};
}
