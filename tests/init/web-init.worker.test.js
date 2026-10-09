/** Executed by the existing real Workers test pool in npm test.
 * These cover no-storage/native Request/KV/crypto handling. D1 SQL migration
 * scenarios are separately covered by the disk-backed Node SQLite suite.
 */
import {it,expect} from 'vitest';
import {env} from 'cloudflare:test';
import {handleWebInitGate,webInitReady} from '../../src/data/web-init.js';
import {WEB_INIT_MODE} from '../../src/data/web-init-protocol.js';
import {VERSION} from '../../src/version.js';
const run={version:VERSION,id:VERSION+'-web-init-workers-test',mode:WEB_INIT_MODE,tokenHash:''};
it('real Workers Request without any KV/D1 renders init instead of crashing',async()=>{
  const response=await handleWebInitGate(new Request('https://test.invalid/init'),{},run);
  expect(response.status).toBe(200);expect(await response.text()).toContain('SuperAdmin');expect(await webInitReady({},run)).toBe(false);
});
it('real Workers public status distinguishes code deployed from database initialized',async()=>{
  const r=await handleWebInitGate(new Request('https://test.invalid/api/upgrade/status'),{},run);
  const status=await r.json();expect(status.codeDeployed).toBe(true);expect(status.applicationReady).toBe(false);expect(status.phase).toBe('bindings_required');
});
it('native KV is not initialized by visiting init with D1 still absent',async()=>{
  const key='config';await env.SUBSCRIPTIONS_KV.put(key,'{"KEEP":"existing-raw-config"}');
  await handleWebInitGate(new Request('https://test.invalid/init'),{SUBSCRIPTIONS_KV:env.SUBSCRIPTIONS_KV},run);
  expect(await env.SUBSCRIPTIONS_KV.get(key)).toBe('{"KEEP":"existing-raw-config"}');
});
it('native Request JSON and crypto authenticate but cannot init a partially bound environment',async()=>{
  const e={SUBSCRIPTIONS_KV:env.SUBSCRIPTIONS_KV,SUBSTRACKER_SUPERADMIN_PASSWORD:'synthetic-runtime-secret'};
  const request=new Request('https://test.invalid/api/init/preview',{method:'POST',headers:{Origin:'https://test.invalid','Content-Type':'application/json','X-SubsTracker-Init':'1'},body:JSON.stringify({password:'synthetic-runtime-secret'})});
  const r=await handleWebInitGate(request,e,run);expect(r.status).toBe(503);expect((await r.json()).code).toBe('INIT_BINDINGS_REQUIRED');
});
