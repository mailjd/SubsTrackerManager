/** Actual default CLI process, real plan and guard, simulated API/upload/check commands.
 * These tests are NOT real Wrangler, real Workers tests or a Cloudflare deployment.
 */
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';
import {installFakeToolchain} from '../upgrade/fake-local-toolchain.mjs';
import {RELEASE_CHECKS} from '../../scripts/upgrade/release-checks.mjs';
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'st-unbound-cli-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const dir of ['src','scripts','public','migrations'])fs.cpSync(path.join(source,dir),path.join(root,dir),{recursive:true});
  fs.mkdirSync(path.join(root,'tests/deploy'),{recursive:true});fs.copyFileSync(path.join(source,'tests/deploy/unbound-cli-preload.mjs'),path.join(root,'tests/deploy/unbound-cli-preload.mjs'));
  installFakeToolchain(source,root);
  fs.writeFileSync(path.join(root,'wrangler.toml'),'name="original-worker"\nmain="src/index.js"\ncompatibility_date="2024-09-23"\n');
  const state=path.join(root,'synthetic'),bin=path.join(root,'bin');fs.mkdirSync(state);fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin,'npm'),'#!/bin/sh\nprintf "%s\\n" "$2" >> "$FAKE_UPGRADE_STATE/checks.log"\nexit 0\n',{mode:0o700});
  fs.writeFileSync(path.join(root,'node_modules/wrangler/bin/wrangler.js'),`// SIMULATED upload; executes the REAL production guard.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const root=process.env.FAKE_UPGRADE_ROOT,state=process.env.FAKE_UPGRADE_STATE,args=process.argv.slice(2);
assert.equal(args[0],'deploy');assert.ok(args.includes('--keep-vars'));
const cfg=JSON.parse(fs.readFileSync(args[args.indexOf('--config')+1]));assert.deepEqual(cfg.kv_namespaces,process.env.FAKE_UNBOUND_KV==='1'?[{binding:'SUBSCRIPTIONS_KV',id:'b'.repeat(32)}]:[]);assert.deepEqual(cfg.d1_databases,process.env.FAKE_WEB_INIT_D1==='1'?[{binding:'SUBSCRIPTIONS_DB',database_id:'00000000-1111-2222-3333-000000000001',database_name:'00000000-1111-2222-3333-000000000001'}]:[]);assert.equal(cfg.workers_dev,false);assert.equal(cfg.preview_urls,false);assert.equal(cfg.routes,undefined);
const guard=spawnSync(process.execPath,['scripts/require-safe-upgrade.mjs'],{cwd:root,env:process.env,stdio:'inherit'});if(guard.status!==0)process.exit(guard.status||1);
if(process.env.FAKE_UNBOUND_PUBLISH_FAIL==='1')process.exit(9);
fs.copyFileSync(args[args.indexOf('--config')+1],path.join(state,'published-config.json'));fs.copyFileSync(path.join(root,'src/upgrade-release.js'),path.join(state,'published-release.js'));
`);
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,FAKE_UPGRADE_ROOT:root,FAKE_UPGRADE_STATE:state,NODE_OPTIONS:'--import='+path.join(root,'tests/deploy/unbound-cli-preload.mjs'),CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'synthetic',WORKERS_CI:'1',CF_PAGES:'',SUBSTRACKER_WORKER_URL:'',SUBSTRACKER_WORKER_NAME:'',SUBSTRACKER_ENVIRONMENT:'',SUBSTRACKER_BACKUP_PASSWORD:'',SUBSTRACKER_UNBOUND_DEPLOY_RUN:'',SUBSTRACKER_DIRECT_DEPLOY_RUN:'',SUBSTRACKER_SAFE_DEPLOY_RUN:''};
  const run=extra=>spawnSync(process.execPath,['scripts/deploy-cloudflare.mjs'],{cwd:root,env:{...env,...extra},encoding:'utf8',timeout:30000});return {root,state,run};
}
test('actual default CLI with zero bindings, disabled workers.dev and no URL publishes web-init exactly once',t=>{
  const f=fixture(t),r=f.run();assert.equal(r.status,0,r.stdout+'\n'+r.stderr);assert.match(r.stdout,/ST_UNBOUND_GUARD_OK/);assert.match(r.stdout,/ST_CODE_RELEASE_VERIFIED/);assert.match(r.stdout,/ST_URL_NOT_VERIFIED/);assert.match(r.stdout,/ST_CODE_DEPLOYED_AWAITING_BINDINGS/);assert.doesNotMatch(r.stdout,/ST_UPGRADE_COMPLETE|ST_DIRECT_PUBLISH|ST_UPGRADE_WAIT/);
  assert.deepEqual(fs.readFileSync(path.join(f.state,'checks.log'),'utf8').trim().split('\n'),RELEASE_CHECKS);
  const result=JSON.parse(fs.readFileSync(path.join(f.root,'.upgrade/unbound-result.json')));assert.equal(result.codeDeployed,true);assert.equal(result.urlVerification.status,'not_configured');assert.equal(result.applicationReady,false);assert.equal(result.dataInitComplete,false);
  assert.match(fs.readFileSync(path.join(f.state,'published-release.js'),'utf8'),/deferred-web-init/);assert.ok(!fs.existsSync(path.join(f.root,'wrangler.unbound.json')));
  const calls=fs.readFileSync(path.join(f.state,'transport.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.ok(calls.every(c=>c.method==='GET'&&c.url.includes('/workers/')));
});
test('actual default CLI with KV preserves its ID and still uses web init',t=>{
  const f=fixture(t),r=f.run({FAKE_UNBOUND_KV:'1'});assert.equal(r.status,0,r.stdout+'\n'+r.stderr);assert.match(r.stdout,/ST_WEB_INIT_BINDINGS_PRESERVED/);assert.match(r.stdout,/ST_CODE_RELEASE_VERIFIED/);assert.doesNotMatch(r.stdout,/ST_DIRECT_PUBLISH/);const config=JSON.parse(fs.readFileSync(path.join(f.state,'published-config.json')));assert.equal(config.kv_namespaces[0].id,'b'.repeat(32));
});
test('actual default CLI with KV+D1 publishes both unchanged and awaits init',t=>{
  const f=fixture(t),r=f.run({FAKE_UNBOUND_KV:'1',FAKE_WEB_INIT_D1:'1'});assert.equal(r.status,0,r.stdout+'\n'+r.stderr);assert.match(r.stdout,/ST_CODE_DEPLOYED_AWAITING_INIT/);assert.doesNotMatch(r.stdout,/ST_DIRECT_PUBLISH|ST_UNBOUND_STILL_BOUND/);const config=JSON.parse(fs.readFileSync(path.join(f.state,'published-config.json')));assert.equal(config.d1_databases[0].database_id,'00000000-1111-2222-3333-000000000001');assert.equal(config.kv_namespaces[0].id,'b'.repeat(32));
});
test('actual default CLI with D1-only preserves it and waits for KV',t=>{
  const f=fixture(t),r=f.run({FAKE_WEB_INIT_D1:'1'});assert.equal(r.status,0,r.stdout+'\n'+r.stderr);const report=JSON.parse(fs.readFileSync(path.join(f.root,'.upgrade/unbound-result.json')));assert.deepEqual(report.missingBindings,['SUBSCRIPTIONS_KV']);
});
test('actual CLI uploader failure reports attempted but not confirmed, not a preflight failure',t=>{
  const f=fixture(t),r=f.run({FAKE_UNBOUND_PUBLISH_FAIL:'1'});assert.equal(r.status,1);assert.match(r.stderr,/ST_UNBOUND_PUBLISH_FAILED/);assert.match(r.stderr,/"publishAttempted":true/);assert.match(r.stderr,/"codeDeployed":null/);assert.doesNotMatch(r.stdout,/ST_CODE_RELEASE_VERIFIED|ST_CODE_DEPLOYED_AWAITING_BINDINGS/);
});
