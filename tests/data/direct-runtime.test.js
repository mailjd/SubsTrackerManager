/** Real pinned Workers KV binding; imports direct-runtime, NOT the mocked legacy gate. */
import {it,expect,beforeEach} from 'vitest';
import {env} from 'cloudflare:test';
import {directRuntimeReady,handleDirectGate,DIRECT_MODE} from '../../src/data/direct-runtime.js';
import {VERSION} from '../../src/version.js';
const run={version:VERSION,id:'native-direct-runtime-test',mode:DIRECT_MODE,tokenHash:'',schema:'v3'};
beforeEach(async()=>{const rows=await env.SUBSCRIPTIONS_KV.list();await Promise.all(rows.keys.map(k=>env.SUBSCRIPTIONS_KV.delete(k.name)));});
async function seed(){await env.SUBSCRIPTIONS_KV.put('schema_version','v3');await env.SUBSCRIPTIONS_KV.put('config',JSON.stringify({JWT_SECRET:'native-test-auth',CREDENTIALS_ENCRYPTION_KEY:'native-test-encryption'}));}
it('a compatible original KV can serve immediately without legacy completion markers',async()=>{
  await seed();expect(await directRuntimeReady(env)).toBe(true);
  const r=await handleDirectGate(new Request('https://test.invalid/api/upgrade/status'),env,run);
  expect(r.status).toBe(200);expect(await r.json()).toMatchObject({success:true,mode:DIRECT_MODE,maintenance:false,version:VERSION,runId:run.id});
  expect((await env.SUBSCRIPTIONS_KV.list()).keys.map(k=>k.name).sort()).toEqual(['config','schema_version']);
});
it('missing original encryption key is not automatically regenerated',async()=>{
  await env.SUBSCRIPTIONS_KV.put('schema_version','v3');await env.SUBSCRIPTIONS_KV.put('config','{}');
  expect(await directRuntimeReady(env)).toBe(false);
  expect((await handleDirectGate(new Request('https://test.invalid/api/subscriptions'),env,run)).status).toBe(503);
  expect(await env.SUBSCRIPTIONS_KV.get('config')).toBe('{}');
});
it('normal authenticated routing remains outside the direct deployment gate',async()=>{
  await seed();expect(await handleDirectGate(new Request('https://test.invalid/admin'),env,run)).toBe(null);
});
it('direct release never accepts a staged migration commit',async()=>{
  await seed();expect((await handleDirectGate(new Request('https://test.invalid/api/upgrade/commit',{method:'POST',body:'{}'}),env,run)).status).toBe(409);
});
