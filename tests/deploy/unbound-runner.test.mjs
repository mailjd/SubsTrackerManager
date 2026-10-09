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
import {RELEASE_MARKER,MARKER_FORMAT,deploymentMarker} from '../../scripts/upgrade/deployment-evidence.mjs';
import {deploymentFailureMessage} from '../../scripts/deploy-cloudflare.mjs';
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const A='00000000-1111-2222-3333-000000000001',B='00000000-1111-2222-3333-000000000002';
function setup(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'subs-unbound-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const dir of ['src','scripts','public','migrations'])fs.cpSync(path.join(source,dir),path.join(root,dir),{recursive:true});
  for(const file of ['package.json','package-lock.json'])fs.copyFileSync(path.join(source,file),path.join(root,file));
  fs.writeFileSync(path.join(root,'wrangler.toml'),'name="original-worker"\nmain="src/index.js"\ncompatibility_date="2024-09-23"\n[vars]\nENVIRONMENT="wrong-local-default"\n');
  const env={CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'synthetic-token-not-real',SUBSTRACKER_WORKER_URL:'https://test.invalid',PATH:process.env.PATH,WORKERS_CI:'1'};
  const f={root,env,calls:[],version:A,versionOverride:null,stores:[],published:0,checks:0,run:null,options:null,marker:null,domain:{enabled:true,previews_enabled:false},customDomains:[],scripts:[],httpCalls:[],traffic:100};
  const bindings=()=>[{name:'ENVIRONMENT',type:'plain_text',text:'keep-original'},{name:'SUBSTRACKER_SUPERADMIN_PASSWORD',type:'secret_text'},...f.stores,...(f.marker?[{name:RELEASE_MARKER,type:'plain_text',text:f.marker}]:[])];
  f.cf={accountId:env.CLOUDFLARE_ACCOUNT_ID,
    async request(route,options={}){f.calls.push({route,method:options.method||'GET'});assert.ok(route.startsWith('/workers/'),'NO DATA API: '+route);assert.equal(options.method||'GET','GET');
      if(route.startsWith('/workers/domains?'))return {result:f.customDomains};
      if(route==='/workers/scripts')return {result:f.scripts};
      if(route==='/workers/subdomain')return {result:{subdomain:'existing-account'}};
      if(route.endsWith('/settings'))return {result:{bindings:bindings()}};
      if(route.endsWith('/deployments'))return {result:{deployments:[{id:f.version,versions:[{version_id:f.version,percentage:f.traffic}]}]}};
      if(route.includes('/versions/'))return {result:{id:f.version,resources:{bindings:f.versionOverride||bindings()}}};
      assert.fail('Unexpected API: '+route);
    },
    async schedules(){return [{cron:'0 * * * *'}];},async scriptSubdomain(){return f.domain;},async accountSubdomain(){return {subdomain:'existing-account'};}
  };
  f.options={root,env,cf:f.cf,deadline:Date.now()+120000,checkRelease(){f.checks++;},pause:async()=>{},
    async publisher(root,plan,env){
      f.published++;f.run={version:VERSION,id:plan.runId,mode:WEB_INIT_MODE,tokenHash:''};f.plan=plan;
      const check=spawnSync(process.execPath,[path.join(root,'scripts/require-safe-upgrade.mjs')],{cwd:root,env:{...env,SUBSTRACKER_UNBOUND_DEPLOY_RUN:plan.runId},encoding:'utf8'});
      assert.equal(check.status,0,check.stdout+'\n'+check.stderr);assert.match(check.stdout,/ST_UNBOUND_GUARD_OK/);
      f.version=B;f.marker=deploymentMarker(plan);
    },async fetchImpl(url){f.httpCalls.push(url);assert.ok(f.published>0,'unbound old runtime must NOT be queried before publication');return handleWebInitGate(new Request(url),{},f.run);}
  };
  return f;
}
test('default auto deployment without KV/D1 or backup password publishes once and awaits web init',async t=>{
  const f=setup(t),toml=fs.readFileSync(path.join(f.root,'wrangler.toml')),release=fs.readFileSync(path.join(f.root,'src/upgrade-release.js'));
  const r=await runAutoDeployment(f.options);assert.equal(f.published,1);assert.equal(f.checks,1);assert.equal(r.codeDeployed,true);assert.equal(r.applicationReady,false);assert.equal(r.phase,'bindings_required');assert.equal(r.dataAPICalls,0);
  assert.deepEqual(f.plan.config.kv_namespaces,[]);assert.deepEqual(f.plan.config.d1_databases,[]);assert.equal(f.plan.config.vars.ENVIRONMENT,'keep-original');assert.equal(f.plan.config.vars[RELEASE_MARKER],deploymentMarker(f.plan));assert.equal(f.plan.config.keep_vars,true);
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
  const f=setup(t);f.stores=[{name:'SUBSCRIPTIONS_DB',type:'d1',id:A}];await assert.rejects(()=>runAutoDeployment(f.options),/ST_UNBOUND_STILL_BOUND/);assert.equal(f.published,0);
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
test('wrong run ID at URL stays unverified but does not erase control-plane code evidence',async t=>{
  const f=setup(t);f.options.fetchImpl=async()=>Response.json({version:VERSION,runId:'old-run',mode:WEB_INIT_MODE,codeDeployed:true,applicationReady:false,phase:'bindings_required'});const result=await runUnboundDeployment(f.options);assert.equal(result.codeDeployed,true);assert.equal(result.urlVerification.verified,false);assert.equal(result.urlVerification.status,'not_verified');assert.equal(result.applicationReady,false);assert.equal(result.initURL,null);
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

// Regression matrix derived from the user's 2026-10-09 failing Build.
test('fully unbound + workers.dev DISABLED + no Build URL publishes and verifies via control plane',async t=>{
  const f=setup(t);delete f.env.SUBSTRACKER_WORKER_URL;f.domain={enabled:false,previews_enabled:false};
  const r=await runAutoDeployment(f.options);
  assert.equal(f.published,1);assert.equal(r.codeDeployed,true);assert.equal(r.controlPlaneVerified,true);assert.equal(r.urlVerification.status,'not_configured');assert.equal(r.dataInitComplete,false);assert.equal(r.applicationReady,false);assert.equal(f.httpCalls.length,0);assert.equal(f.plan.config.workers_dev,false);assert.equal(f.plan.config.preview_urls,false);assert.equal(r.phase,'bindings_required');
});
test('same failing Build with residual KV never falls back to direct-compatible',async t=>{
  const f=setup(t);delete f.env.SUBSTRACKER_WORKER_URL;f.domain={enabled:false};f.stores=[{type:'kv_namespace',name:'SUBSCRIPTIONS_KV',namespace_id:'b'.repeat(32)}];
  await assert.rejects(()=>runAutoDeployment(f.options),e=>{
    assert.equal(e.code,'ST_UNBOUND_STILL_BOUND');assert.match(e.message,/original-worker/);assert.match(e.message,/SUBSCRIPTIONS_KV/);assert.match(e.message,/activeVersion/);assert.equal(e.deploymentState.publishAttempted,false);assert.equal(e.deploymentState.stage,'preflight');assert.match(deploymentFailureMessage(e),/尚未呼叫發布器/);return true;
  });assert.equal(f.published,0);assert.equal(f.checks,0);assert.ok(f.calls.every(c=>c.route.startsWith('/workers/')));
});
test('residual D1 and KV are listed together and neither is detached',async t=>{
  const f=setup(t);f.stores=[{type:'d1',name:'SUBSCRIPTIONS_DB',id:A},{type:'kv_namespace',name:'SUBSCRIPTIONS_KV',namespace_id:'b'.repeat(32)}];
  await assert.rejects(()=>runAutoDeployment(f.options),e=>/SUBSCRIPTIONS_DB/.test(e.message)&&/SUBSCRIPTIONS_KV/.test(e.message));assert.equal(f.published,0);assert.equal(f.stores.length,2);
});
test('live custom domain is discovered when workers.dev is disabled',async t=>{
  const f=setup(t);delete f.env.SUBSTRACKER_WORKER_URL;f.domain={enabled:false};f.customDomains=[{service:'another-worker',environment:'production',hostname:'wrong.invalid'},{service:'original-worker',environment:'production',hostname:'original.invalid'}];
  const r=await runAutoDeployment(f.options);assert.equal(r.urlVerification.verified,true);assert.equal(r.initURL,'https://original.invalid/init');assert.ok(f.httpCalls.every(url=>url.startsWith('https://original.invalid/')));assert.equal(f.plan.config.workers_dev,false);
});
test('matching live root Route is discovered without reconfiguring routes',async t=>{
  const f=setup(t);delete f.env.SUBSTRACKER_WORKER_URL;f.domain={enabled:false};f.scripts=[{id:'wrong',routes:[{pattern:'wrong.invalid/*'}]},{id:'original-worker',routes:[{pattern:'routes.invalid/*',script:'original-worker'}]}];
  const r=await runAutoDeployment(f.options);assert.equal(r.initURL,'https://routes.invalid/init');assert.equal(f.plan.config.routes,undefined);assert.equal(f.plan.config.route,undefined);
});
test('wildcard hostname and path-only routes are not guessed',async t=>{
  const f=setup(t);delete f.env.SUBSTRACKER_WORKER_URL;f.domain={enabled:false};f.scripts=[{id:'original-worker',routes:[{pattern:'*.invalid/*'},{pattern:'route.invalid/app/*'}]}];
  const r=await runAutoDeployment(f.options);assert.equal(r.codeDeployed,true);assert.equal(r.urlVerification.status,'not_configured');assert.equal(f.httpCalls.length,0);
});
test('domain discovery 403 is optional, but original workers.dev false is preserved',async t=>{
  const f=setup(t);delete f.env.SUBSTRACKER_WORKER_URL;f.domain={enabled:false};const request=f.cf.request;
  f.cf.request=async(route,o)=>{if(route.startsWith('/workers/domains')||route==='/workers/scripts'){const e=new Error('forbidden');e.httpStatus=403;throw e;}return request(route,o);};
  const r=await runAutoDeployment(f.options);assert.equal(r.codeDeployed,true);assert.equal(r.urlVerification.status,'not_configured');assert.equal(f.plan.config.workers_dev,false);
});
test('an invalid optional Build URL does not block an otherwise valid no-storage release',async t=>{
  const f=setup(t);f.env.SUBSTRACKER_WORKER_URL='https://someone:password@test.invalid/admin';f.domain={enabled:false};
  const r=await runAutoDeployment(f.options);assert.equal(r.codeDeployed,true);assert.equal(r.urlVerification.verified,false);assert.equal(f.httpCalls.length,0);
});
test('existing enabled workers.dev is resolved; it is never enabled as fallback',async t=>{
  const f=setup(t);delete f.env.SUBSTRACKER_WORKER_URL;const r=await runAutoDeployment(f.options);assert.equal(r.initURL,'https://original-worker.existing-account.workers.dev/init');assert.equal(f.plan.config.workers_dev,true);
});
test('unknown workers.dev state is not guessed as false and stops before release tests',async t=>{
  const f=setup(t);f.domain={};await assert.rejects(()=>runAutoDeployment(f.options),/ST_UNBOUND_CONFIG/);assert.equal(f.published,0);assert.equal(f.checks,0);
});
test('HTTP 403 Access protection is not a code deployment failure',async t=>{
  const f=setup(t);f.options.fetchImpl=async()=>new Response('Access login',{status:403});const r=await runAutoDeployment(f.options);assert.equal(r.codeDeployed,true);assert.equal(r.urlVerification.verified,false);assert.equal(r.urlVerification.attempts[0].reason,'redirect-or-access-protected');assert.equal(r.applicationReady,false);
});
test('redirect is never followed and never treated as URL verification',async t=>{
  const f=setup(t);f.options.fetchImpl=async(url,opts)=>{assert.equal(opts.redirect,'manual');assert.equal(opts.headers.Authorization,undefined);return new Response('',{status:302,headers:{Location:'https://elsewhere.invalid'}});};
  const r=await runAutoDeployment(f.options);assert.equal(r.codeDeployed,true);assert.equal(r.urlVerification.verified,false);
});
test('DNS failure is reported separately after code publication',async t=>{
  const f=setup(t);f.options.fetchImpl=async()=>{throw new Error('ENOTFOUND');};const r=await runAutoDeployment(f.options);assert.equal(r.codeDeployed,true);assert.equal(r.urlVerification.verified,false);assert.equal(r.initURL,null);
});
test('Wrangler success with no new active deployment never counts as published',async t=>{
  const f=setup(t);f.options.publisher=async(root,plan)=>{f.published++;f.plan=plan;f.marker=deploymentMarker(plan);};
  await assert.rejects(()=>runAutoDeployment(f.options),e=>{assert.equal(e.code,'ST_UNBOUND_CONTROL_VERIFY');assert.equal(e.deploymentState.publishAttempted,true);assert.equal(e.deploymentState.codeDeployed,null);assert.equal(e.deploymentState.stage,'control-verification');return true;});assert.equal(f.httpCalls.length,0);assert.ok(!fs.existsSync(path.join(f.root,'.upgrade/unbound-result.json')));
});
test('new active version without this nonce/source marker cannot claim success even if URL would pass',async t=>{
  const f=setup(t);const publisher=f.options.publisher;f.options.publisher=async(...args)=>{await publisher(...args);f.marker=JSON.stringify({...JSON.parse(f.marker),sourceHash:'c'.repeat(64)});};
  await assert.rejects(()=>runAutoDeployment(f.options),/ST_UNBOUND_CONTROL_VERIFY/);assert.equal(f.httpCalls.length,0);
});
test('new active version with no marker cannot claim success',async t=>{
  const f=setup(t);const publisher=f.options.publisher;f.options.publisher=async(...args)=>{await publisher(...args);f.marker=null;};await assert.rejects(()=>runAutoDeployment(f.options),/ST_UNBOUND_CONTROL_VERIFY/);
});
test('marker only in settings but not active version is insufficient',async t=>{
  const f=setup(t);const publisher=f.options.publisher;f.options.publisher=async(...args)=>{await publisher(...args);f.versionOverride=[{name:'ENVIRONMENT',type:'plain_text',text:'keep-original'},{name:'SUBSTRACKER_SUPERADMIN_PASSWORD',type:'secret_text'}];};await assert.rejects(()=>runAutoDeployment(f.options),/ST_UNBOUND_CONTROL_VERIFY/);
});
test('reserved marker colliding with existing business variable is not overwritten',async t=>{
  const f=setup(t);f.stores=[{type:'plain_text',name:RELEASE_MARKER,text:'original-unrelated-business-value'}];await assert.rejects(()=>runAutoDeployment(f.options),/ST_UNBOUND_MARKER_COLLISION/);assert.equal(f.published,0);assert.equal(f.checks,0);
});
test('prior legitimate release marker is safely replaced only by the new code marker',async t=>{
  const f=setup(t);f.marker=JSON.stringify({format:MARKER_FORMAT,version:'3.3.32',mode:WEB_INIT_MODE,runId:'3.3.32-web-init-'+A,sourceHash:'d'.repeat(64)});const r=await runAutoDeployment(f.options);assert.equal(r.codeDeployed,true);assert.equal(JSON.parse(f.plan.config.vars[RELEASE_MARKER]).runId,r.runId);
});
test('binding change after publisher is detected without issuing data API calls',async t=>{
  const f=setup(t);const publisher=f.options.publisher;f.options.publisher=async(...args)=>{await publisher(...args);f.stores=[{name:'SUBSCRIPTIONS_KV',type:'kv_namespace',namespace_id:'b'.repeat(32)}];};
  await assert.rejects(()=>runAutoDeployment(f.options),e=>e.code==='ST_UNBOUND_STILL_BOUND'&&e.deploymentState.publishAttempted===true);assert.ok(f.calls.every(x=>x.method==='GET'&&x.route.startsWith('/workers/')));
});
test('published version changes while URL is checked: no final success for stale version',async t=>{
  const f=setup(t);f.options.fetchImpl=async()=>{f.version='00000000-1111-2222-3333-000000000003';return Response.json({});};await assert.rejects(()=>runAutoDeployment(f.options),/ST_UNBOUND_CHANGED/);
});
test('a split-traffic deployment is not overwritten',async t=>{
  const f=setup(t);f.traffic=50;await assert.rejects(()=>runAutoDeployment(f.options),/ST_DIRECT_ACTIVE/);assert.equal(f.published,0);
});
test('release checks failing report not attempted, unlike uploader failure',async t=>{
  const f=setup(t);f.options.checkRelease=()=>{throw new Error('real-test-failure');};await assert.rejects(()=>runAutoDeployment(f.options),e=>{assert.equal(e.deploymentState.publishAttempted,false);assert.equal(e.deploymentState.codeDeployed,false);assert.equal(e.deploymentState.stage,'release-checks');assert.match(deploymentFailureMessage(e),/尚未呼叫發布器/);return true;});
});
test('a fresh failed attempt cannot leave a prior success report',async t=>{
  const f=setup(t);fs.mkdirSync(path.join(f.root,'.upgrade'),{recursive:true});fs.writeFileSync(path.join(f.root,'.upgrade/unbound-result.json'),'old-success');f.stores=[{name:'SUBSCRIPTIONS_KV',type:'kv_namespace',namespace_id:'b'.repeat(32)}];await assert.rejects(()=>runAutoDeployment(f.options));assert.ok(!fs.existsSync(path.join(f.root,'.upgrade/unbound-result.json')));
});
test('mixed account injection is rejected before control-plane reads',async t=>{
  const f=setup(t);f.cf.accountId='c'.repeat(32);await assert.rejects(()=>runAutoDeployment(f.options),/ST_UNBOUND_ACCOUNT/);assert.equal(f.calls.length,0);assert.equal(f.published,0);
});
