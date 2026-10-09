/** Real direct CLI + real guard + real runtime gate, isolated CF transport and upload stand-in. */
import {installFakeToolchain} from '../upgrade/fake-local-toolchain.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {fixture,sample} from '../upgrade/helpers.mjs';
import {decryptArchive} from '../../scripts/upgrade/archive.mjs';
import {assertDirectGuard} from '../../scripts/upgrade/direct-release.mjs';
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const PASSWORD='direct-fixture-encryption-password';
async function setup(t,{kvOnly=true}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'subs-direct-')),state=path.join(root,'synthetic');fs.mkdirSync(state);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const dir of ['src','scripts','migrations','public','tests/upgrade'])fs.cpSync(path.join(source,dir),path.join(root,dir),{recursive:true});
  installFakeToolchain(source,root);
  fs.writeFileSync(path.join(root,'wrangler.toml'),'name="synthetic-existing-worker"\nmain="src/index.js"\ncompatibility_date="2024-09-23"\n[build]\ncommand="node scripts/require-safe-upgrade.mjs"\n');
  const f=await fixture({rows:[sample('a'),sample('b')]});fs.writeFileSync(path.join(state,'kv.json'),JSON.stringify(Object.fromEntries(f.values)));
  const db=new DatabaseSync(path.join(state,'d1.sqlite'));db.exec(f.bundle().d1Sql);db.close();f.close();fs.writeFileSync(path.join(state,'clock-ms'),'0');
  const bin=path.join(root,'bin');fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin,'npm'),'#!/bin/sh\nprintf "%s\\n" "$2" >> "$FAKE_UPGRADE_STATE/required-tests.log"\nif [ "$FAKE_TEST_FAILURE" = "$2" ]; then exit 1; fi\nexit 0\n',{mode:0o700});
  const env={...process.env,WORKERS_CI:'1',WORKERS_CI_BUILD_UUID:'direct-test',CF_PAGES:'',GITHUB_ACTIONS:'',SUBSTRACKER_WORKER_NAME:'',SUBSTRACKER_ENVIRONMENT:'',SUBSTRACKER_SAFE_DEPLOY_RUN:'',SUBSTRACKER_DIRECT_DEPLOY_RUN:'',
    PATH:bin+path.delimiter+process.env.PATH,FAKE_UPGRADE_ROOT:root,FAKE_UPGRADE_STATE:state,FAKE_SPLIT_CLOCK:'1',FAKE_ONLINE_KV_ONLY:kvOnly?'1':'',
    NODE_OPTIONS:'--import='+path.join(root,'tests/upgrade/fake-cloudflare-preload.mjs'),CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'synthetic-only-no-network',SUBSTRACKER_BACKUP_PASSWORD:PASSWORD,SUBSTRACKER_WORKER_URL:'https://upgrade.example.invalid'};
  const run=(extra={},args=[])=>spawnSync(process.execPath,['scripts/deploy-cloudflare.mjs',...args],{cwd:root,env:{...env,...extra},encoding:'utf8',timeout:60000});
  const trace=()=>fs.existsSync(path.join(state,'transport.jsonl'))?fs.readFileSync(path.join(state,'transport.jsonl'),'utf8').trim().split('\n').map(JSON.parse):[];
  const plan=()=>JSON.parse(fs.readFileSync(path.join(root,'.upgrade/direct-plan.json'),'utf8'));
  return {root,state,env,run,trace,plan};
}
function pass(result){assert.equal(result.status,0,result.stdout+'\n'+result.stderr);}
for(const kvOnly of [true,false])test('one default CLI build completes '+(kvOnly?'KV-only':'KV+D1')+' without split wait, lease or business writes',async t=>{
  const f=await setup(t,{kvOnly}),before=fs.readFileSync(path.join(f.state,'kv.json')),toml=fs.readFileSync(path.join(f.root,'wrangler.toml')),release=fs.readFileSync(path.join(f.root,'src/upgrade-release.js'));
  const r=f.run();pass(r);assert.match(r.stdout,/ST_DIRECT_GUARD_OK/);assert.match(r.stdout,/ST_UPGRADE_COMPLETE/);assert.doesNotMatch(r.stdout,/ST_UPGRADE_WAIT|ST_SPLIT_D1_REQUIRED/);
  assert.equal(f.plan().phase,'complete');assert.equal(f.plan().bindings.dbId===null,kvOnly);
  assert.equal(fs.readFileSync(path.join(f.state,'deploy-count'),'utf8'),'deploy\n');
  assert.deepEqual(fs.readFileSync(path.join(f.state,'kv.json')),before);assert.deepEqual(fs.readFileSync(path.join(f.root,'wrangler.toml')),toml);assert.deepEqual(fs.readFileSync(path.join(f.root,'src/upgrade-release.js')),release);
  const calls=f.trace();assert.ok(!calls.some(x=>x.path.endsWith('/apply')||x.path.endsWith('/commit')||x.method==='DELETE'));
  if(kvOnly)assert.ok(!calls.some(x=>x.path.includes('/d1/')));
  const database=new DatabaseSync(path.join(f.state,'d1.sqlite'));
  assert.equal(database.prepare("SELECT count(*) n FROM schema_meta WHERE key LIKE 'upgrade:3322:%' OR key LIKE 'upgrade:3320:%'").get().n,0);database.close();
  const p=f.plan(),backup=decryptArchive(fs.readFileSync(path.join(f.root,'upgrade-backups',p.backup.filename)),PASSWORD);
  assert.equal(backup.snapshotConsistency,'live-non-transactional');assert.equal(backup.bindings.dbId,p.bindings.dbId);
  assert.deepEqual(backup.kv.map(x=>[x.name,Buffer.from(x.valueBase64,'base64').toString('utf8')]).sort(),Object.entries(JSON.parse(before)).sort());
  assert.ok(!fs.existsSync(path.join(f.root,'wrangler.direct.json')));
});
test('same commit can be retried as another one-shot release without maintenance checkpoints',async t=>{
  const f=await setup(t);pass(f.run());const old=f.plan().backupId;pass(f.run());assert.notEqual(f.plan().backupId,old);assert.equal(f.plan().phase,'complete');
});
test('failed required test prevents artifact upload and Worker publication',async t=>{
  const f=await setup(t);const r=f.run({FAKE_TEST_FAILURE:'test'});assert.equal(r.status,1);assert.match(r.stderr,/ST_SPLIT_TEST/);assert.ok(!f.trace().some(x=>x.method==='PUT'));
  assert.ok(!fs.existsSync(path.join(f.state,'deployed')));
});
test('wrong local KV binding is rejected before backup or publish',async t=>{
  const f=await setup(t);fs.appendFileSync(path.join(f.root,'wrangler.toml'),'\n[[kv_namespaces]]\nbinding="SUBSCRIPTIONS_KV"\nid="'+ 'c'.repeat(32)+'"\n');
  const r=f.run();assert.equal(r.status,1);assert.match(r.stderr,/本地 KV ID/);assert.ok(!f.trace().some(x=>x.method==='PUT'));
});
test('old schema prevents publishing without modifying original records',async t=>{
  const f=await setup(t),file=path.join(f.state,'kv.json');const kv=JSON.parse(fs.readFileSync(file));kv.schema_version='v2';fs.writeFileSync(file,JSON.stringify(kv));const before=fs.readFileSync(file);
  const r=f.run();assert.equal(r.status,1);assert.match(r.stderr,/ST_DIRECT_SCHEMA/);assert.ok(!fs.existsSync(path.join(f.state,'deployed')));assert.deepEqual(fs.readFileSync(file),before);
});
test('missing credential encryption key never gets silently regenerated',async t=>{
  const f=await setup(t),file=path.join(f.state,'kv.json');const kv=JSON.parse(fs.readFileSync(file));kv.config='{}';fs.writeFileSync(file,JSON.stringify(kv));
  const r=f.run();assert.equal(r.status,1);assert.match(r.stderr,/ST_DIRECT_CONFIG/);assert.ok(!fs.existsSync(path.join(f.state,'deployed')));
});
test('Wrangler failure never logs success and leaves original source/records intact',async t=>{
  const f=await setup(t),before=fs.readFileSync(path.join(f.root,'src/upgrade-release.js'));
  const r=f.run({FAKE_DEPLOY_LOST_ACK:'1'});assert.equal(r.status,1);assert.match(r.stderr,/ST_DIRECT_PUBLISH_FAILED/);assert.doesNotMatch(r.stdout,/ST_UPGRADE_COMPLETE/);assert.deepEqual(fs.readFileSync(path.join(f.root,'src/upgrade-release.js')),before);
});
test('read-only direct backup download works for KV-only without any D1 or publish',async t=>{
  const f=await setup(t);pass(f.run());const p=f.plan(),start=f.trace().length;
  pass(f.run({},['download',p.backupId]));assert.ok(f.trace().slice(start).every(x=>x.method==='GET'));assert.equal(fs.readFileSync(path.join(f.state,'deploy-count'),'utf8'),'deploy\n');
});
test('wrong password cannot download existing backup or change original data',async t=>{
  const f=await setup(t);pass(f.run());const r=f.run({SUBSTRACKER_BACKUP_PASSWORD:'wrong-but-long-enough-password'},['download',f.plan().backupId]);assert.equal(r.status,1);assert.match(r.stderr,/密码不正确|损坏/);
});
test('bare direct environment variable does not bypass real guard',async t=>{
  const f=await setup(t);const r=spawnSync(process.execPath,['scripts/require-safe-upgrade.mjs'],{cwd:f.root,env:{...f.env,SUBSTRACKER_DIRECT_DEPLOY_RUN:'fake'},encoding:'utf8'});assert.equal(r.status,1);assert.ok(!fs.existsSync(path.join(f.state,'deployed')));
});
test('original binding drift after release checks stops before writes',async t=>{
  const f=await setup(t,{kvOnly:false});const r=f.run({FAKE_BINDING_DRIFT_AFTER_TESTS:'1'});assert.equal(r.status,1);assert.match(r.stderr,/ST_BINDING_CHANGED/);assert.ok(!f.trace().some(x=>x.method==='PUT'));
});

test('verified direct plan still refuses config, source, backup and account tampering',async t=>{
  const f=await setup(t);pass(f.run());
  const {writeDirectPlan}=await import('../../scripts/upgrade/direct-release.mjs');
  const p={...f.plan(),phase:'ready'};writeDirectPlan(f.root,p);
  const env={...f.env,SUBSTRACKER_DIRECT_DEPLOY_RUN:p.runId};
  assert.doesNotThrow(()=>assertDirectGuard(f.root,env));
  const configFile=path.join(f.root,'wrangler.direct.json');const config=fs.readFileSync(configFile);
  fs.writeFileSync(configFile,JSON.stringify({...p.config,vars:{ENVIRONMENT:'replaced'}}));assert.throws(()=>assertDirectGuard(f.root,env),/ST_DIRECT_GUARD/);fs.writeFileSync(configFile,config);
  const entry=path.join(f.root,'src/index.js'),sourceBytes=fs.readFileSync(entry);fs.appendFileSync(entry,'\n// changed after checks\n');assert.throws(()=>assertDirectGuard(f.root,env),/ST_DIRECT_SOURCE/);fs.writeFileSync(entry,sourceBytes);
  const backupFile=path.join(f.root,'upgrade-backups',p.backup.filename),backupBytes=fs.readFileSync(backupFile);const corrupt=Buffer.from(backupBytes);corrupt[corrupt.length-5]^=1;fs.writeFileSync(backupFile,corrupt);assert.throws(()=>assertDirectGuard(f.root,env),/ST_DIRECT_BACKUP/);fs.writeFileSync(backupFile,backupBytes);
  assert.throws(()=>assertDirectGuard(f.root,{...env,CLOUDFLARE_ACCOUNT_ID:'c'.repeat(32)}),/ST_DIRECT_GUARD/);
  assert.throws(()=>assertDirectGuard(f.root,{...env,SUBSTRACKER_BACKUP_PASSWORD:'wrong-but-long-password'}),/密码不正确|损坏/);
});

test('an already-active old maintenance run is not overwritten by a direct release',async t=>{
  const f=await setup(t);const r=f.run({FAKE_ORIGINAL_MAINTENANCE:'1'});assert.equal(r.status,1);assert.match(r.stderr,/ST_DIRECT_ACTIVE_MAINTENANCE/);assert.ok(!f.trace().some(x=>x.method==='PUT'));assert.ok(!fs.existsSync(path.join(f.state,'deployed')));
});
test('corrupted encrypted remote snapshot prevents Worker publication',async t=>{
  const f=await setup(t);const r=f.run({FAKE_CORRUPT_DIRECT_ARTIFACT:'1'});assert.equal(r.status,1);assert.match(r.stderr,/ST_DIRECT_BACKUP/);assert.ok(!fs.existsSync(path.join(f.state,'deployed')));assert.doesNotMatch(r.stdout,/ST_UPGRADE_COMPLETE/);
});
