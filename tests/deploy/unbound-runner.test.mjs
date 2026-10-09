/** Actual no-storage runner + actual guard + runtime waiting gate.
 * Transport and publisher are synthetic: these are NOT live Cloudflare tests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {runUnboundDeployment,runAutoDeployment,makeUnboundConfig,assertUnboundSettings,assertUnboundGuard,UNBOUND_CONFIG,UNBOUND_PLAN} from '../../scripts/deploy-unbound.mjs';
import {handleWebInitGate} from '../../src/data/web-init.js';
import {WEB_INIT_MODE} from '../../src/data/web-init-protocol.js';
import {VERSION} from '../../src/version.js';
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const A='00000000-1111-2222-3333-000000000001',B='00000000-1111-2222-3333-000000000002';
function setup(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'subs-unbound-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const dir of ['src','scripts','public','migrations'])fs.cpSync(path.join(source,dir),path.join(root,dir),{recursive:true});
  for(const file of ['package.json','package-lock.json'])fs.copyFileSync(path.join(source,file),path.join(root,file));
  fs.writeFileSync(path.join(root,'wrangler.toml'),'name="original-worker"\nmain="src/index.js"\ncompatibility_date="2024-09-23"\n[vars]\nENVIRONMENT="wrong-local-default"\n');
  const env={CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'synthetic-token-not-real',SUBSTRACKER_WORKER_URL:'https://test.invalid',PATH:process.env.PATH,WORKERS_CI:'1'};
  const f={root,env,calls:[],version:A,versionOverride:null,stores:[],published:0,checks:0,run:null,options:null};
  const bindings=()=>[{name:'ENVIRONMENT',type:'plain_text',text:'keep-original'},{name:'SUBSTRACKER_SUPERADMIN_PASSWORD',type:'secret_text'},...f.stores];
  f.cf={accountId:env.CLOUDFLARE_ACCOUNT_ID,
    async request(route,options={}){f.calls.push({route,method:options.method||'GET'});assert.ok(route.startsWith('/workers/'),'NO DATA API: '+route);assert.equal(options.method||'GET','GET');
      if(route.endsWith('/settings'))return {result:{bindings:bindings()}};
      if(route.endsWith('/deployments'))return {result:{deployments:[{id:f.version,versions:[{version_id:f.version,percentage:100}]}]}};
      if(route.includes('/versions/'))return {result:{id:f.version,resources:{bindings:f.versionOverride||bindings()}}};
      assert.fail('Unexpected API: '+route);
    },
    async schedules(){return [{cron:'0 * * * *'}];},async scriptSubdomain(){return {enabled:true,previews_enabled:false};},async accountSubdomain(){return {subdomain:'existing-account'};}
  };
  f.options={root,env,cf:f.cf,deadline:Date.now()+120000,checkRelease(){f.checks++;},pause:async()=>{},
    async publisher(root,plan,env){
      f.published++;f.run={version:VERSION,id:plan.runId,mode:WEB_INIT_MODE,tokenHash:''};f.plan=plan;
      const check=spawnSync(process.execPath,[path.join(root,'scripts/require-safe-upgrade.mjs')],{cwd:root,env:{...env,SUBSTRACKER_UNBOUND_DEPLOY_RUN:plan.runId},encoding:'utf8'});
      assert.equal(check.status,0,check.stdout+'\n'+check.stderr);assert.match(check.stdout,/ST_UNBOUND_GUARD_OK/);
      f.version=B;
    },async fetchImpl(url){assert.ok(f.published>0,'unbound old runtime must NOT be queried before publication');return handleWebInitGate(new Request(url),{},f.run);}
  };
  return f;
}
test('default auto deployment without KV/D1 or backup password publishes once and awaits web init',async t=>{
  const f=setup(t),toml=fs.readFileSync(path.join(f.root,'wrangler.toml')),release=fs.readFileSync(path.join(f.root,'src/upgrade-release.js'));
  const r=await runAutoDeployment(f.options);assert.equal(f.published,1);assert.equal(f.checks,1);assert.equal(r.codeDeployed,true);assert.equal(r.applicationReady,false);assert.equal(r.phase,'bindings_required');assert.equal(r.dataAPICalls,0);
  assert.deepEqual(f.plan.config.kv_namespaces,[]);assert.deepEqual(f.plan.config.d1_databases,[]);assert.deepEqual(f.plan.config.vars,{ENVIRONMENT:'keep-original'});assert.equal(f.plan.config.keep_vars,true);
  assert.deepEqual(fs.readFileSync(path.join(f.root,'wrangler.toml')),toml);assert.deepEqual(fs.readFileSync(path.join(f.root,'src/upgrade-release.js')),release);assert.ok(!fs.existsSync(path.join(f.root,UNBOUND_CONFIG)));assert.ok(!fs.existsSync(path.join(f.root,'upgrade-backups')));
  assert.ok(f.calls.every(c=>c.route.startsWith('/workers/')&&c.method==='GET'));
});
test('stale LOCAL storage IDs are not rebound after explicit remote unbinding',async t=>{
  const f=setup(t);fs.appendFileSync(path.join(f.root,'wrangler.toml'),'\n[[kv_namespaces]]\nbinding="SUBSCRIPTIONS_KV"\nid="'+'b'.repeat(32)+'"\n[[d1_databases]]\nbinding="SUBSCRIPTIONS_DB"\ndatabase_id="'+A+'"\ndatabase_name="original"\n');
  await runUnboundDeployment(f.options);assert.deepEqual(f.plan.config.kv_namespaces,[]);assert.deepEqual(f.plan.config.d1_databases,[]);
});
test('a failed settings request is not inferred as an empty binding list',async t=>{
  const f=setup(t);f.cf.request=async()=>{throw new Error('HTTP 403');};await assert.rejects(()=>runAutoDeployment(f.options),/HTTP 403/);assert.equal(f.published,0);assert.equal(f.checks,0);
});
test('missing binding array is not inferred as unbound',async t=>{
  const f=setup(t);f.cf.request=async()=>({result:{}});await assert.rejects(()=>runAutoDeployment(f.options),/ST_BINDING_RESPONSE/);assert.equal(f.published,0);
});
test('partial KV removal does not detach the remaining D1 automatically',async t=>{
  const f=setup(t);f.stores=[{name:'SUBSCRIPTIONS_DB',type:'d1',id:A}];await assert.rejects(()=>runAutoDeployment(f.options),/ST_UNBOUND_PARTIAL/);assert.equal(f.published,0);
});
test('unbound route refuses a still-bound KV instead of clearing it',async t=>{
  const f=setup(t);f.stores=[{name:'SUBSCRIPTIONS_KV',type:'kv_namespace',namespace_id:'b'.repeat(32)}];await assert.rejects(()=>runUnboundDeployment(f.options),/ST_UNBOUND_STILL_BOUND/);assert.equal(f.published,0);
});
test('Dashboard-only unbinding not yet active cannot clear the active version',async t=>{
  const f=setup(t);f.versionOverride=[{name:'SUBSCRIPTIONS_KV',type:'kv_namespace',namespace_id:'b'.repeat(32)}];await assert.rejects(()=>runUnboundDeployment(f.options),/ST_UNBOUND_STILL_BOUND/);assert.equal(f.published,0);
});
test('unsupported live bindings are preserved by refusing publication',async t=>{
  const f=setup(t);f.stores=[{name:'QUEUE',type:'queue'}];await assert.rejects(()=>runUnboundDeployment(f.options),/ST_UNBOUND_OTHER_BINDING/);assert.equal(f.published,0);
});
test('release-test failure prevents code publication without requiring storage access',async t=>{
  const f=setup(t);f.options.checkRelease=()=>{throw new Error('native workers test failed');};await assert.rejects(()=>runUnboundDeployment(f.options),/native workers test failed/);assert.equal(f.published,0);assert.ok(f.calls.every(x=>x.method==='GET'));
});
test('binding drift during release checks stops before publication',async t=>{
  const f=setup(t);f.options.checkRelease=()=>{f.stores=[{name:'SUBSCRIPTIONS_DB',type:'d1',id:A}];};await assert.rejects(()=>runUnboundDeployment(f.options),/ST_UNBOUND_STILL_BOUND/);assert.equal(f.published,0);
});
test('concurrent code deployment is detected before publication',async t=>{
  const f=setup(t);f.options.checkRelease=()=>{f.version=B;};await assert.rejects(()=>runUnboundDeployment(f.options),/ST_UNBOUND_CHANGED/);assert.equal(f.published,0);
});
test('publisher failure restores source and original wrangler config; no false completion',async t=>{
  const f=setup(t),release=fs.readFileSync(path.join(f.root,'src/upgrade-release.js'));f.options.publisher=()=>{throw new Error('publisher failed');};await assert.rejects(()=>runUnboundDeployment(f.options),/publisher failed/);assert.deepEqual(fs.readFileSync(path.join(f.root,'src/upgrade-release.js')),release);assert.ok(!fs.existsSync(path.join(f.root,UNBOUND_CONFIG)));
});
test('wrong run ID at the URL never counts as a successful deployed waiting app',async t=>{
  const f=setup(t);f.options.fetchImpl=async()=>Response.json({version:VERSION,runId:'old-run',mode:WEB_INIT_MODE,codeDeployed:true,applicationReady:false,phase:'bindings_required'});await assert.rejects(()=>runUnboundDeployment(f.options),/ST_UNBOUND_VERIFY/);assert.ok(!fs.existsSync(path.join(f.root,'.upgrade/unbound-result.json')));
});
test('unbound guard rejects a bare environment flag',async t=>{
  const f=setup(t);const r=spawnSync(process.execPath,[path.join(f.root,'scripts/require-safe-upgrade.mjs')],{cwd:f.root,env:{...f.env,SUBSTRACKER_UNBOUND_DEPLOY_RUN:'fake'},encoding:'utf8'});assert.equal(r.status,1);assert.equal(f.published,0);
});
test('unbound guard verifies exact config, source fingerprint, account and release descriptor',async t=>{
  const f=setup(t);f.options.publisher=(root,plan,env)=>{
    const e={...env,SUBSTRACKER_UNBOUND_DEPLOY_RUN:plan.runId};assert.doesNotThrow(()=>assertUnboundGuard(root,e));
    const file=path.join(root,UNBOUND_CONFIG),old=fs.readFileSync(file);fs.writeFileSync(file,JSON.stringify({...plan.config,kv_namespaces:[{binding:'SUBSCRIPTIONS_KV',id:'b'.repeat(32)}]}));assert.throws(()=>assertUnboundGuard(root,e),/ST_UNBOUND_GUARD/);fs.writeFileSync(file,old);
    const index=path.join(root,'src/index.js'),original=fs.readFileSync(index);fs.appendFileSync(index,'\n// changed');assert.throws(()=>assertUnboundGuard(root,e),/ST_UNBOUND_SOURCE/);fs.writeFileSync(index,original);
    assert.throws(()=>assertUnboundGuard(root,{...e,CLOUDFLARE_ACCOUNT_ID:'c'.repeat(32)}),/ST_UNBOUND_GUARD/);
    throw new Error('stop after guard test');
  };await assert.rejects(()=>runUnboundDeployment(f.options),/stop after guard test/);
});
test('static assets route migration and local default variables cannot accidentally change original runtime config',()=>{
  const input={name:'existing',routes:['wrong.example/*'],route:'wrong.example/*',migrations:[{new_classes:['Wrong']}],vars:{WRONG:'default'},env:{production:{}},triggers:{crons:['* * * * *']}};
  const cfg=makeUnboundConfig(input,{settings:{bindings:[{name:'ENVIRONMENT',type:'plain_text',text:'original'},{name:'OPTIONS',type:'json',json:'{"x":2}'},{name:'SECRET',type:'secret_text'}]},schedules:[],domain:{enabled:false},accountId:'a'.repeat(32)});
  assert.equal(cfg.routes,undefined);assert.equal(cfg.route,undefined);assert.equal(cfg.migrations,undefined);assert.equal(cfg.env,undefined);assert.deepEqual(cfg.vars,{ENVIRONMENT:'original',OPTIONS:{x:2}});assert.deepEqual(cfg.triggers,{crons:[]});assert.equal(input.vars.WRONG,'default');
});
