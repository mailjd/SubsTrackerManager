import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';import {DatabaseSync} from 'node:sqlite';
import {fixture,sample,payment} from './helpers.mjs';import {decryptArchive} from '../../scripts/upgrade/archive.mjs';
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
async function setup(t,large=false){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'subs-safe-runner-')),state=path.join(root,'synthetic');fs.mkdirSync(state);
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const sub of ['src','scripts','tests/upgrade'])fs.cpSync(path.join(source,sub),path.join(root,sub),{recursive:true});
 // A repository may hold real production IDs. Offline tests must never use those IDs
 // or inherit a real deployment target; the actual protection code is still exercised.
 fs.writeFileSync(path.join(root,'wrangler.toml'),'name="synthetic-existing-worker"\nmain="src/index.js"\ncompatibility_date="2024-09-23"\n[build]\ncommand="node scripts/require-safe-upgrade.mjs"\n');
 fs.writeFileSync(path.join(root,'package.json'),'{"type":"module"}');
 const f=await fixture({rows:large?Array.from({length:25},(_,i)=>sample('many-'+i)):[sample('a',{paymentHistory:[payment()]}),sample('b')],mirrors:[sample('b')]});const b=f.bundle();fs.writeFileSync(path.join(state,'kv.json'),JSON.stringify(Object.fromEntries(f.values)));const db=new DatabaseSync(path.join(state,'d1.sqlite'));db.exec(b.d1Sql);db.close();f.close();
 const bin=path.join(root,'fakebin');fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'npx'),'#!/bin/sh\nnode "$FAKE_UPGRADE_ROOT/scripts/require-safe-upgrade.mjs" || exit $?\nprintf 1 > "$FAKE_UPGRADE_STATE/deployed"\n',{mode:0o700});
 const env={...process.env,WORKERS_CI:'',WORKERS_CI_BUILD_UUID:'',CF_PAGES:'',SUBSTRACKER_WORKER_NAME:'',SUBSTRACKER_ENVIRONMENT:'',PATH:bin+path.delimiter+process.env.PATH,FAKE_UPGRADE_ROOT:root,FAKE_UPGRADE_STATE:state,NODE_OPTIONS:'--import='+path.join(root,'tests/upgrade/fake-cloudflare-preload.mjs'),CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'synthetic-only',SUBSTRACKER_BACKUP_PASSWORD:'only-synthetic-archive-password',SUBSTRACKER_WORKER_URL:'https://upgrade.example.invalid'};
 const run=(phase,extra={})=>spawnSync(process.execPath,['scripts/safe-upgrade.mjs',phase],{cwd:root,env:{...env,...extra},encoding:'utf8',timeout:45000});
 return {root,state,env,run};
}
test('complete prepare→build guard→stage→backup→apply→restore→commit transport integration',async t=>{
 const f=await setup(t),before=fs.readFileSync(path.join(f.state,'kv.json'),'utf8');
 for(const p of ['prepare','stage','finish']){const r=f.run(p);assert.equal(r.status,0,r.stdout+'\n'+r.stderr);}
 const files=fs.readdirSync(path.join(f.root,'upgrade-backups'));assert.ok(files.some(x=>x.endsWith('acceptance.json')));assert.ok(files.some(x=>x.endsWith('maintenance.stbackup')));
 const state=decryptArchive(fs.readFileSync(path.join(f.root,'.upgrade/state.stbackup')),f.env.SUBSTRACKER_BACKUP_PASSWORD);assert.equal(state.phase,'complete');assert.equal(state.bindings.kvId,'b'.repeat(32));assert.equal(state.resourceNames.d1,'CUSTOM-EXISTING-D1');
 const after=JSON.parse(fs.readFileSync(path.join(f.state,'kv.json'),'utf8'));for(const [k,v] of Object.entries(JSON.parse(before)))assert.equal(after[k],v);
 const trace=fs.readFileSync(path.join(f.state,'transport.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.ok(!trace.some(x=>x.host==='api.cloudflare.com'&&['DELETE','PUT','PATCH'].includes(x.method)));assert.ok(trace.some(x=>x.path.endsWith('/api/upgrade/commit')));
});
test('lost apply response resumes from server report without rerunning or overwriting originals',async t=>{
 const f=await setup(t);for(const p of ['prepare','stage']){const r=f.run(p);assert.equal(r.status,0,r.stderr);}
 const failed=f.run('finish',{FAKE_LOSE_APPLY_RESPONSE:'1'});assert.notEqual(failed.status,0);assert.match(failed.stderr,/connection lost/);
 const retry=f.run('finish');assert.equal(retry.status,0,retry.stdout+'\n'+retry.stderr);
 const calls=fs.readFileSync(path.join(f.state,'transport.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.equal(calls.filter(x=>x.path.endsWith('/api/upgrade/apply')).length,1);assert.equal(calls.filter(x=>x.path.endsWith('/api/upgrade/report')).length,1);
});
test('raw build without safe-run capability is blocked before deploy',()=>{
 const r=spawnSync(process.execPath,['scripts/require-safe-upgrade.mjs'],{cwd:source,env:{...process.env,SUBSTRACKER_BACKUP_PASSWORD:'',SUBSTRACKER_SAFE_DEPLOY_RUN:''},encoding:'utf8'});assert.notEqual(r.status,0);assert.match(r.stderr,/禁止直接 wrangler deploy/);
});

test('lost commit acknowledgement recovers completed receipt without repeating migration',async t=>{
 const f=await setup(t);for(const p of ['prepare','stage']){const r=f.run(p);assert.equal(r.status,0,r.stderr);}
 const failed=f.run('finish',{FAKE_LOSE_COMMIT_RESPONSE:'1'});assert.notEqual(failed.status,0);assert.match(failed.stderr,/committed unlock/);
 const retry=f.run('finish');assert.equal(retry.status,0,retry.stdout+'\n'+retry.stderr);
 const state=decryptArchive(fs.readFileSync(path.join(f.root,'.upgrade/state.stbackup')),f.env.SUBSTRACKER_BACKUP_PASSWORD);assert.equal(state.phase,'complete');
 const report=JSON.parse(fs.readFileSync(path.join(f.root,'upgrade-backups',state.runId+'-acceptance.json'),'utf8'));assert.equal(report.ready,true);assert.equal(report.recoveredAcknowledgement,true);assert.equal(report.localVerification.originalsVerified,true);
});

test('runner iterates bounded migration batches and reports total additions',async t=>{
 const f=await setup(t,true);for(const phase of ['prepare','stage','finish']){const r=f.run(phase);assert.equal(r.status,0,r.stdout+'\n'+r.stderr);}
 const calls=fs.readFileSync(path.join(f.state,'transport.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.equal(calls.filter(x=>x.path.endsWith('/api/upgrade/apply')).length,4);
 const file=fs.readdirSync(path.join(f.root,'upgrade-backups')).find(x=>x.endsWith('-acceptance.json'));const report=JSON.parse(fs.readFileSync(path.join(f.root,'upgrade-backups',file),'utf8'));assert.equal(report.migration.added,26);assert.equal(report.ready,true);
});
