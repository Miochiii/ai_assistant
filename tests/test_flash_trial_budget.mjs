import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { ENDPOINT, validateRequest, reserveRequest } from '../scripts/flash_trial_budget.mjs';
import { root } from '../plugins/dsh-desktop-observe/bridge.js';
const data = Buffer.from('offline-image-fixture');
const hash = createHash('sha256').update(data).digest('hex');
const body = () => ({model:'deepseek-flash',max_tokens:1024,thinking:{type:'disabled'},stream:true,
  messages:[{role:'user',content:[{type:'text',text:'Identify this image'},
    {type:'image',source:{type:'base64',media_type:'image/png',data:data.toString('base64')}}]}]});
const request = value => ({method:'POST',redirect:'error',body:JSON.stringify(value)});
test('request boundary rejects wrong destination, extra tools, output excess, and unapproved image', () => {
  assert.equal(validateRequest(ENDPOINT,request(body()),hash).images,1);
  assert.throws(()=>validateRequest('https://example.com',request(body()),hash));
  for (const change of [{max_tokens:4097},{tools:[]},{thinking:{type:'enabled'}},{model:'other'}])
    assert.throws(()=>validateRequest(ENDPOINT,request({...body(),...change}),hash));
  assert.throws(()=>validateRequest(ENDPOINT,request(body()),'wrong'));
  const long = body(); long.messages[0].content[0].text='x'.repeat(8193);
  assert.throws(()=>validateRequest(ENDPOINT,request(long),hash));
});
test('persistent reservations admit only three attempts even concurrently and after failure', async () => {
  const allowed = await realpath(join(root,'results','a04'));
  const directory=await mkdtemp(join(allowed,'tmp-budget-'));
  const approval={approved:true,trial_id:'flash-readonly-20261023',max_requests:3,max_budget_cny:0.5,max_output_tokens:4096,max_input_tokens_reserved:20000};
  try {
    await assert.rejects(reserveRequest(directory,{...approval,status:'completed'},{}),/approval/);
    const outcomes=await Promise.allSettled(Array.from({length:6},()=>reserveRequest(directory,approval,{})));
    assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,3);
    await assert.rejects(reserveRequest(directory,approval,{}),/exhausted/);
  } finally {
    const resolved=await realpath(directory), sub=relative(allowed,resolved);
    if(!sub||sub.startsWith('..')||isAbsolute(sub))throw new Error('Unsafe cleanup');
    await rm(resolved,{recursive:true,force:true});
  }
});
