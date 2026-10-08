import {installFakeToolchain} from '../upgrade/fake-local-toolchain.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {fixture,sample,payment} from '../upgrade/helpers.mjs';
import {decryptArchive} from '../../scripts/upgrade/archive.mjs';
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const PASSWORD='synthetic-split-build-password-only';
async function setup(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'subs-split-build-')),state=path.join(root,'synthetic');fs.mkdirSync(state);
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const dir of ['src','scripts','migrations','public','tests/upgrade'])fs.cpSync(path.join(source,dir),path.join(root,dir),{recursive:true});
  installFakeToolchain(source,root);
  fs.writeFileSync(path.join(root,'wrangler.toml'),'name="synthetic-existing-worker"\nmain="src/index.js"\ncompatibility_date="2024-09-23"\n[build]\ncommand="node scripts/require-safe-upgrade.mjs"\n');
  const f=await fixture({rows:[sample('a',{paymentHistory:[payment()]}),sample('b')],mirrors:[sample('b')]});
  fs.writeFileSync(path.join(state,'kv.json'),JSON.stringify(Object.fromEntries(f.values)));
  const db=new DatabaseSync(path.join(state,'d1.sqlite'));db.exec(f.bundle().d1Sql);db.close();f.close();
  fs.writeFileSync(path.join(state,'clock-ms'),'0');
  const bin=path.join(root,'bin');fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin,'npm'),`#!/bin/sh\nprintf '%s\\n' "$2" >> "$FAKE_UPGRADE_STATE/required-tests.log"\nif [ "$FAKE_TEST_FAILURE" = "$2" ]; then exit 1; fi\nexit 0\n`,{mode:0o700});
  fs.writeFileSync(path.join(bin,'npx'),'#!/bin/sh\necho forbidden-npx >&2\nexit 99\n',{mode:0o700});
  const env={...process.env,WORKERS_CI:'1',WORKERS_CI_BUILD_UUID:'test-build',CF_PAGES:'',GITHUB_ACTIONS:'',SUBSTRACKER_WORKER_NAME:'',SUBSTRACKER_ENVIRONMENT:'',SUBSTRACKER_SAFE_DEPLOY_RUN:'',
    PATH:bin+path.delimiter+process.env.PATH,FAKE_UPGRADE_ROOT:root,FAKE_UPGRADE_STATE:state,FAKE_SPLIT_CLOCK:'1',
    NODE_OPTIONS:'--import='+path.join(root,'tests/upgrade/fake-cloudflare-preload.mjs'),CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'only-synthetic',SUBSTRACKER_BACKUP_PASSWORD:PASSWORD,SUBSTRACKER_WORKER_URL:'https://upgrade.example.invalid'};
  const run=(extra={})=>spawnSync(process.execPath,['scripts/deploy-cloudflare.mjs'],{cwd:root,env:{...env,...extra},encoding:'utf8',timeout:60000});
  const fresh=(ms=0)=>{for(const dir of ['.upgrade','upgrade-backups'])fs.rmSync(path.join(root,dir),{recursive:true,force:true});fs.rmSync(path.join(root,'wrangler.upgrade.json'),{force:true});fs.copyFileSync(path.join(source,'src/upgrade-release.js'),path.join(root,'src/upgrade-release.js'));fs.writeFileSync(path.join(state,'clock-ms'),String(ms));};
  const decoded=()=>decryptArchive(fs.readFileSync(path.join(root,'.upgrade/state.stbackup')),PASSWORD);
  const trace=()=>fs.existsSync(path.join(state,'transport.jsonl'))?fs.readFileSync(path.join(state,'transport.jsonl'),'utf8').trim().split('\n').map(JSON.parse):[];
  return {root,state,env,run,fresh,decoded,trace};
}
function pass(result){assert.equal(result.status,0,result.stdout+'\n'+result.stderr);}
function sameOriginalKV(f,before){assert.equal(fs.readFileSync(path.join(f.state,'kv.json'),'utf8'),before);}
test('Cloudflare first build really passes guard, remains closed, persists encrypted recovery; fresh second build unlocks once',async t=>{
 const f=await setup(t),before=fs.readFileSync(path.join(f.state,'kv.json'),'utf8');
 const first=f.run();pass(first);assert.match(first.stdout,/ST_UPGRADE_WAIT/);assert.doesNotMatch(first.stdout,/ST_UPGRADE_COMPLETE/);
 const staged=f.decoded();assert.equal(staged.phase,'staged');assert.ok(staged.readyAfter-staged.stagedAt===16*60*1000);
 const testCalls=fs.readFileSync(path.join(f.state,'required-tests.log'),'utf8').trim().split('\n');assert.deepEqual(testCalls,['test:runtime','test:toolchain','lint','test','test:context','test:syntax','test:bundle','test:storage','test:deploy','test:upgrade','test:table-contract','test:workflow']);
 const db1=new DatabaseSync(path.join(f.state,'d1.sqlite'));assert.equal(db1.prepare("SELECT count(*) AS n FROM schema_meta WHERE key LIKE '%:complete'").get().n,0);db1.close();sameOriginalKV(f,before);
 // A too-early new container must not redeploy or reset the waiting clock.
 f.fresh(2*60*1000);const early=f.run();pass(early);assert.match(early.stdout,/ST_UPGRADE_WAIT/);assert.equal(f.decoded().stagedAt,staged.stagedAt);assert.equal(f.decoded().runId,staged.runId);
 f.fresh(17*60*1000);const second=f.run();pass(second);assert.match(second.stdout,/ST_UPGRADE_COMPLETE/);
 assert.equal(f.decoded().phase,'complete');sameOriginalKV(f,before);
 const acceptance=fs.readdirSync(path.join(f.root,'upgrade-backups')).find(x=>x.endsWith('-acceptance.json'));
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'upgrade-backups',acceptance),'utf8')).originalsVerified,true);
 const calls=f.trace();assert.ok(calls.every(x=>['api.cloudflare.com','upgrade.example.invalid'].includes(x.host)));assert.ok(!calls.some(x=>/\/(?:r2|export|import)(?:\/|$)/.test(x.path)));assert.equal(calls.filter(x=>x.path.endsWith('/api/upgrade/commit')).length,1);assert.ok(!calls.some(x=>x.method==='DELETE'));
 const deployText=fs.readFileSync(path.join(f.state,'deploy-count'),'utf8');assert.equal(deployText.match(/deploy/g).length,1);
 const artifacts=Object.values(JSON.parse(fs.readFileSync(path.join(f.state,'artifacts.json'),'utf8'))).map(v=>Buffer.from(v,'base64').toString('utf8')).join('');
 assert.ok(!artifacts.includes('old-auth-secret'));assert.ok(!artifacts.includes(PASSWORD));
 f.fresh(18*60*1000);pass(f.run());assert.equal(fs.readFileSync(path.join(f.state,'deploy-count'),'utf8'),deployText);sameOriginalKV(f,before);
});
test('test failure stops before lease, artifact upload or Worker deployment',async t=>{
 const f=await setup(t);const r=f.run({FAKE_TEST_FAILURE:'lint'});assert.notEqual(r.status,0);assert.match(r.stderr,/ST_SPLIT_TEST/);
 assert.ok(!fs.existsSync(path.join(f.state,'deployed')));assert.ok(!f.trace().some(x=>x.method==='PUT'||x.path.endsWith('/query')));
});
test('wrong backup password on a fresh Build cannot create a replacement run',async t=>{
 const f=await setup(t);pass(f.run());const before=fs.readFileSync(path.join(f.state,'kv.json'),'utf8'),deploys=fs.readFileSync(path.join(f.state,'deploy-count'),'utf8');
 f.fresh(17*60*1000);const r=f.run({SUBSTRACKER_BACKUP_PASSWORD:'wrong-password-but-long-enough'});assert.notEqual(r.status,0);assert.match(r.stderr,/密码不正确|已损坏/);
 assert.equal(fs.readFileSync(path.join(f.state,'deploy-count'),'utf8'),deploys);sameOriginalKV(f,before);
});
test('changed code while maintenance is active is rejected rather than silently starting another run',async t=>{
 const f=await setup(t);pass(f.run());f.fresh(17*60*1000);fs.appendFileSync(path.join(f.root,'src/index.js'),'\n// unrelated incoming deployment\n');
 const r=f.run();assert.notEqual(r.status,0);assert.match(r.stderr,/ST_SPLIT_SOURCE/);assert.ok(!f.trace().some(x=>x.path.endsWith('/api/upgrade/apply')));
});
test('lost apply acknowledgement resumes from durable checkpoint in a new Build',async t=>{
 const f=await setup(t);pass(f.run());f.fresh(17*60*1000);
 const r=f.run({FAKE_LOSE_APPLY_RESPONSE:'1'});assert.notEqual(r.status,0);assert.match(r.stderr,/connection lost/);
 f.fresh(18*60*1000);const retry=f.run();pass(retry);assert.match(retry.stdout,/ST_UPGRADE_COMPLETE/);
 assert.equal(f.trace().filter(x=>x.path.endsWith('/api/upgrade/apply')).length,1);
});
test('lost commit acknowledgement recovers without remigrating or reopening a new run',async t=>{
 const f=await setup(t);pass(f.run());f.fresh(17*60*1000);
 const r=f.run({FAKE_LOSE_COMMIT_RESPONSE:'1'});assert.notEqual(r.status,0);assert.match(r.stderr,/committed unlock/);
 f.fresh(18*60*1000);pass(f.run());assert.equal(f.decoded().phase,'complete');assert.equal(f.trace().filter(x=>x.path.endsWith('/api/upgrade/commit')).length,1);
});
test('lost Wrangler acknowledgement detects actual maintenance version without duplicate upload and restarts conservative drain',async t=>{
 const f=await setup(t);const fail=f.run({FAKE_DEPLOY_LOST_ACK:'1'});assert.notEqual(fail.status,0);assert.match(fail.stderr,/部署命令失败/);
 f.fresh(3*60*1000);const retry=f.run();pass(retry);assert.match(retry.stdout,/ST_UPGRADE_WAIT/);
 assert.equal(fs.readFileSync(path.join(f.state,'deploy-count'),'utf8').match(/deploy/g).length,1);
 f.fresh(21*60*1000);pass(f.run());assert.equal(f.decoded().phase,'complete');
});
test('corrupted remote ciphertext is detected before any new deployment or migration',async t=>{
 const f=await setup(t);pass(f.run());const file=path.join(f.state,'artifacts.json'),artifacts=JSON.parse(fs.readFileSync(file,'utf8'));
 for(const key of Object.keys(artifacts)){const bytes=Buffer.from(artifacts[key],'base64');bytes[bytes.length-5]^=1;artifacts[key]=bytes.toString('base64');}
 fs.writeFileSync(file,JSON.stringify(artifacts));f.fresh(17*60*1000);const r=f.run();assert.notEqual(r.status,0);assert.match(r.stderr,/校验失败/);assert.ok(!f.trace().some(x=>x.path.endsWith('/api/upgrade/apply')));
});
test('original SQL modified between maintenance backup and retry is not accepted as internal bookkeeping',async t=>{
 const f=await setup(t);pass(f.run());f.fresh(17*60*1000);
 const lost=f.run({FAKE_LOSE_APPLY_RESPONSE:'1'});assert.notEqual(lost.status,0);
 const db=new DatabaseSync(path.join(f.state,'d1.sqlite'));db.prepare('UPDATE schema_meta SET value=? WHERE key=?').run('changed-by-external-writer','schema_version');
 // Use a guaranteed existing subscription row, modifying the originally preserved raw snapshot.
 const row=db.prepare('SELECT id,data_json FROM subscriptions_current LIMIT 1').get();const data=JSON.parse(row.data_json);data.notes='external change after backup';db.prepare('UPDATE subscriptions_current SET data_json=? WHERE id=?').run(JSON.stringify(data),row.id);db.close();
 f.fresh(18*60*1000);const r=f.run();assert.notEqual(r.status,0);assert.ok(!f.trace().some(x=>x.path.endsWith('/api/upgrade/commit')));assert.match(r.stderr,/原始记录|冲突|来源/);
});
test('encrypted backup download works from a new local directory without a deploy or test bypass',async t=>{
 const f=await setup(t);pass(f.run());f.fresh(3*60*1000);const before=f.trace().length;
 const r=spawnSync(process.execPath,['scripts/deploy-cloudflare.mjs','download'],{cwd:f.root,env:f.env,encoding:'utf8',timeout:30000});pass(r);assert.match(r.stdout,/已下载并验证/);
 assert.ok(fs.readdirSync(path.join(f.root,'upgrade-backups')).some(x=>x.endsWith('-before-deploy.stbackup')));
 assert.ok(!f.trace().slice(before).some(x=>x.method==='PUT'||x.path.endsWith('/apply')||x.path.endsWith('/commit')));
});

test('required bundle failure stops before ANY Cloudflare request or checkpoint write',async t=>{
 const f=await setup(t);const r=f.run({FAKE_TEST_FAILURE:'test:bundle'});assert.equal(r.status,1);assert.match(r.stderr,/ST_SPLIT_TEST.*test:bundle/);assert.equal(f.trace().length,0);assert.ok(!fs.existsSync(path.join(f.state,'deployed')));assert.ok(!fs.existsSync(path.join(f.root,'.upgrade/state.stbackup')));
});
