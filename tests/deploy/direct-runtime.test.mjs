import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,sample} from '../upgrade/helpers.mjs';
import {upgradeReady,handleUpgradeGate} from '../../src/data/upgrade-gate.js';
import {inspectDirectBundle,makeDirectConfig,DIRECT_MODE} from '../../scripts/upgrade/direct-release.mjs';
import {VERSION} from '../../src/version.js';
const run={version:VERSION,id:VERSION+'-direct-test',mode:DIRECT_MODE,tokenHash:'',schema:'v3'};
for(const d1 of [false,true])test('direct runtime opens existing '+(d1?'KV+D1':'KV-only')+' without completion keys or storage writes',async t=>{
  const f=await fixture({d1});t.after(()=>f.close());const before=JSON.stringify([...f.values]);
  assert.equal(await upgradeReady(f.env,run),true);
  for(const url of ['/','/admin','/api/subscriptions'])assert.equal(await handleUpgradeGate(new Request('https://example.invalid'+url),f.env,run),null);
  const status=await handleUpgradeGate(new Request('https://example.invalid/api/upgrade/status'),f.env,run);
  assert.equal(status.status,200);assert.deepEqual(await status.json(),{success:true,version:VERSION,runId:run.id,mode:DIRECT_MODE,maintenance:false,phase:'ready',schema:'v3'});
  assert.equal(JSON.stringify([...f.values]),before);assert.deepEqual(f.writes,[]);
});
test('direct runtime never treats missing original credentials as a new install',async t=>{
  const f=await fixture({d1:false});t.after(()=>f.close());f.values.set('config','{}');
  assert.equal(await upgradeReady(f.env,run),false);
  assert.equal((await handleUpgradeGate(new Request('https://example.invalid/api/subscriptions'),f.env,run)).status,503);
  assert.deepEqual(f.writes,[]);
});
test('direct readiness is not permanently cached when storage changes',async t=>{
  const f=await fixture({d1:false});t.after(()=>f.close());assert.equal(await upgradeReady(f.env,run),true);
  f.values.set('schema_version','v2');assert.equal(await upgradeReady(f.env,run),false);assert.deepEqual(f.writes,[]);
});
test('missing / malformed / unavailable original KV fails closed with no initialization',async()=>{
  for(const env of [{},{SUBSCRIPTIONS_KV:{get:async()=>{throw new Error('unavailable');}}},{SUBSCRIPTIONS_KV:{get:async k=>k==='schema_version'?'v3':'invalid'}}])assert.equal(await upgradeReady(env,run),false);
});
test('direct deployment does not expose staged migration or commit endpoints',async t=>{
  const f=await fixture({d1:false});t.after(()=>f.close());
  for(const op of ['apply','commit','report','progress']){
    const r=await handleUpgradeGate(new Request('https://example.invalid/api/upgrade/'+op,{method:'POST',body:'{}'}),f.env,run);
    assert.equal(r.status,409);
  }
  assert.deepEqual(f.writes,[]);
});
test('unprepared distributed release still remains closed; direct mode is not the default bundle',async t=>{
  const f=await fixture({d1:false});t.after(()=>f.close());
  assert.equal(await upgradeReady(f.env),false);
  assert.equal((await handleUpgradeGate(new Request('https://example.invalid/api/subscriptions'),f.env)).status,503);
});
for(const d1 of [false,true])test('direct preflight accepts existing '+(d1?'D1+KV':'KV')+' without requiring a legacy-ledger migration marker',async t=>{
  const f=await fixture({d1,rows:[sample()]});t.after(()=>f.close());
  const summary=inspectDirectBundle(f.bundle());assert.equal(summary.schema,'v3');assert.equal(summary.historicalBackfill,'not-run');assert.deepEqual(f.writes,[]);
});
test('direct preflight rejects old KV schema and missing original encryption keys',async t=>{
  const f=await fixture({d1:false});t.after(()=>f.close());
  f.values.set('schema_version','v2');assert.throws(()=>inspectDirectBundle(f.bundle()),/ST_DIRECT_SCHEMA/);
  f.values.set('schema_version','v3');f.values.set('config','{}');assert.throws(()=>inspectDirectBundle(f.bundle()),/ST_DIRECT_CONFIG/);
});
test('direct preflight rejects destructive legacy D1 primary-key migration',async t=>{
  const f=await fixture({d1:false});t.after(()=>f.close());
  assert.throws(()=>inspectDirectBundle({...f.bundle(),d1Sql:'CREATE TABLE accounts(account_serial TEXT PRIMARY KEY,account TEXT);'}),/ST_DIRECT_OLD_D1/);
});
test('empty optional D1 is accepted without creating anything remotely',async t=>{
  const f=await fixture({d1:false});t.after(()=>f.close());assert.equal(inspectDirectBundle({...f.bundle(),d1Sql:''}).d1,true);
});
for(const dbId of [null,'12345678-1234-1234-1234-123456789abc'])test('generated config retains original IDs, runtime vars, secrets via keep-vars and cron: '+!!dbId,()=>{
  const original={name:'original',vars:{ENVIRONMENT:'wrong-template-value'},routes:['wrong.example/*'],triggers:{crons:['* * * * *']}};
  const copy=JSON.stringify(original);
  const bindings={kvId:'b'.repeat(32),dbId,variables:[{name:'ENVIRONMENT',type:'plain_text',text:'custom-original'},{name:'SETTINGS',type:'json',json:{n:3}}]};
  const out=makeDirectConfig(original,{bindings,database:{name:'keep'},accountId:'a'.repeat(32),schedules:[{cron:'0 * * * *'}],domain:{enabled:true,previews_enabled:false}});
  assert.equal(JSON.stringify(original),copy);assert.equal(out.kv_namespaces[0].id,bindings.kvId);assert.equal(out.d1_databases[0]?.database_id||null,dbId);
  assert.deepEqual(out.vars,{ENVIRONMENT:'custom-original',SETTINGS:{n:3}});assert.equal(out.keep_vars,true);assert.equal(out.preview_urls,false);assert.equal(out.routes,undefined);
  assert.deepEqual(out.triggers,{crons:['0 * * * *']});assert.equal(out.build.command,'node scripts/require-safe-upgrade.mjs');
});
