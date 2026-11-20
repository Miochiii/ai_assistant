import {realpathSync} from 'node:fs';
import {createMemoryHost} from '../dsh-desktop-observe/memory.js';
import {createMemoryGenerationProvider} from './generation.js';
export const name='orb-memory-generation';
// Mount at app scope alongside the Orb host. This does not collect messages,
// register model tools, inject text, or enable a daily scheduler.
export function apply(ctx,config={}) {
  const root=realpathSync.native(config.root);
  const memory=createMemoryHost({root,userId:config.userId,residentGeneration:true});
  const session={id:'orb-memory-control',header:{cwd:root}};
  ctx.provide('orbMemoryGeneration',createMemoryGenerationProvider({memory,session}));
  ctx.effect(()=>()=>memory.dispose());
}
