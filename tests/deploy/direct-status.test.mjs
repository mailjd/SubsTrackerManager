import test from 'node:test';
import assert from 'node:assert/strict';
import {probeRuntime,readActiveRelease} from '../../scripts/deploy-direct.mjs';
import {VERSION} from '../../src/version.js';
for(const status of [401,403,404])test('legacy HTTP '+status+' is permitted only during preflight, never final success',async()=>{
  const fetchImpl=async()=>new Response('legacy',{status});assert.equal(await probeRuntime('https://test.invalid',{fetchImpl,allowLegacy:true}),null);
  await assert.rejects(()=>probeRuntime('https://test.invalid',{fetchImpl}),/ST_DIRECT_STATUS/);
});
test('legacy login HTML is not treated as a successful final deployment',async()=>{
  const fetchImpl=async()=>new Response('<!doctype html><html>Login</html>');assert.equal(await probeRuntime('https://test.invalid',{fetchImpl,allowLegacy:true}),null);await assert.rejects(()=>probeRuntime('https://test.invalid',{fetchImpl}),/ST_DIRECT_STATUS/);
});
test('upstream errors and Access redirects are not interpreted as a usable old site',async()=>{
  for(const status of [302,500,503])await assert.rejects(()=>probeRuntime('https://test.invalid',{fetchImpl:async()=>new Response('blocked',{status}),allowLegacy:true}),/ST_DIRECT_STATUS/);
});
test('an active maintenance run is reported, not silently declared ready',async()=>{
  const result=await probeRuntime('https://test.invalid',{fetchImpl:async()=>Response.json({success:true,version:VERSION,runId:'existing-run',maintenance:true}),allowLegacy:true});assert.equal(result.maintenance,true);
});
test('binding preflight does not select a latest un-deployed or split-traffic version',async()=>{
  const cf={request:async()=>({result:{deployments:[{id:'12345678-1111-2222-3333-123456789abc',versions:[{version_id:'12345678-1111-2222-3333-123456789abc',percentage:50},{version_id:'12345678-aaaa-bbbb-cccc-123456789abc',percentage:50}]}]}})};
  await assert.rejects(()=>readActiveRelease(cf,'original'),/ST_DIRECT_ACTIVE/);
});
