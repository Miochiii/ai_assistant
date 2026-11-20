// Trusted Host provider. Never accepts a model-selected user/project/database.
export function createMemoryGenerationProvider({memory,session}) {
  return {
    async current(signal) {
      const value=await memory.v2(session,'memory_generation',{},signal);
      if(!value||typeof value.generation!=='string'||!/^[a-f0-9]{64}$/.test(value.generation)
        ||typeof value.enabled!=='boolean'||!Number.isSafeInteger(value.consent_revision)
        ||value.consent_revision<1)throw new Error('MEMORY_GENERATION_UNAVAILABLE');
      return value.generation;
    },
  };
}
