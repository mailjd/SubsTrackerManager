import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Cloudflare,protectBindings} from '../../scripts/upgrade/cloudflare.mjs';
import {assertD1KVConfig} from '../../scripts/upgrade/storage-policy.mjs';
import {RELEASE_CHECKS} from '../../scripts/upgrade/release-checks.mjs';
import {ACCOUNT,KV,DB,makeD1} from './helpers.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const settings={bindings:[{type:'kv_namespace',name:'SUBSCRIPTIONS_KV',namespace_id:KV},{type:'d1',name:'SUBSCRIPTIONS_DB',database_id:DB},{type:'assets',name:'ASSETS'}]};
test('R2 local/inactive environment bindings rejected; never silently stripped',()=>{assert.throws(()=>assertD1KVConfig({r2_buckets:[{binding:'BUCKET'}]}),/ST_STORAGE_POLICY/);assert.throws(()=>assertD1KVConfig({env:{staging:{r2_buckets:[{binding:'BUCKET'}]}}}),/ST_STORAGE_POLICY/);});
test('online R2 binding rejected without delete/create/migrate side effects',()=>{assert.throws(()=>protectBindings({}, {bindings:[...settings.bindings,{type:'r2_bucket',name:'OLD_BUCKET'}]}),/R2/);});
test('D1/KV/static assets/variables/secrets accepted without object storage',()=>assert.equal(protectBindings({assets:{binding:'ASSETS'}},settings).dbId,DB));
test('additional storage/services rejected locally to avoid implicit additions',()=>{for(const key of ['durable_objects','vectorize','hyperdrive','queues','services','pipelines'])assert.throws(()=>assertD1KVConfig({[key]:[{binding:'extra'}]}),/ST_STORAGE_POLICY/);});
test('R2 and D1 import/export jobs rejected before transport',async()=>{
 let calls=0;const c=new Cloudflare({accountId:ACCOUNT,token:'test-secret',fetchImpl:async()=>{calls++;throw Error('never');}});
 for(const p of ['/r2/buckets',`/d1/database/${DB}/export`,`/d1/database/${DB}/import`,'https://bucket.invalid/','/workers/../../r2/buckets'])await assert.rejects(c.request(p,{method:'POST'}),/ST_STORAGE_ROUTE/);assert.equal(calls,0);
});
test('redirect-style/absolute paths cannot send token to another storage host',async()=>{
 let calls=0;const c=new Cloudflare({accountId:ACCOUNT,token:'test-secret',fetchImpl:async()=>{calls++;throw Error('never');}});
 for(const p of ['//other.invalid/store','/workers/scripts/../settings','/workers/scripts/%2e%2e/settings',`/storage/kv/namespaces/${KV}/values/../../escape`])await assert.rejects(c.request(p),/ST_STORAGE_ROUTE/);assert.equal(calls,0);
});
test('schema response with wrong shape or success false is rejected',async()=>{
 for(const result of [[],[{success:false,results:[]}],[{success:true}],null]){const c=new Cloudflare({accountId:ACCOUNT,token:'x',fetchImpl:async()=>Response.json({success:true,result})});await assert.rejects(c.exportSQL(DB),/ST_D1_SNAPSHOT_RESPONSE/);}
});
test('D1 permission error stops backup, no silent fallback to bucket',async()=>{
 let calls=0;const c=new Cloudflare({accountId:ACCOUNT,token:'NEVER-PRINT',fetchImpl:async()=>{calls++;return Response.json({success:false,errors:[{code:10000}]},{status:403});}});await assert.rejects(c.exportSQL(DB),e=>e.message.includes('403')&&!e.message.includes('NEVER-PRINT'));assert.equal(calls,1);
});
test('all shipped Wrangler configs parse and only declare KV/D1 for data storage',()=>{
 for(const name of fs.readdirSync(root).filter(n=>/^wrangler.*\.toml$/.test(n))){const r=spawnSync(process.env.PYTHON||'python3',['-c','import tomllib,json,sys;print(json.dumps(tomllib.load(open(sys.argv[1],"rb"))))',path.join(root,name)],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assertD1KVConfig(JSON.parse(r.stdout));}
});
test('no direct S3/R2 SDK dependency is introduced',()=>{const p=JSON.parse(fs.readFileSync(path.join(root,'package.json')));for(const key of Object.keys({...p.dependencies,...p.devDependencies}))assert.ok(!/aws-sdk|client-s3|@aws-sdk|minio|r2-client/i.test(key),key);});
test('split and GitHub release require storage regression, not a bypass',()=>{
 const runner=fs.readFileSync(path.join(root,'scripts/deploy-cloudflare.mjs'),'utf8');
 assert.ok(RELEASE_CHECKS.includes('test:storage'));
 assert.match(runner,/import \{verifyReleaseChecks\} from '\.\/upgrade\/release-checks\.mjs'/);
 const call=runner.indexOf('if(!downloadOnly)verifyReleaseChecks(ROOT,deadline)');
 const probe=runner.indexOf('await cf.settings('),ready=runner.indexOf('assertSplitBindingsReady('),lease=runner.indexOf('await store.acquire()');
 assert.ok(probe>=0 && probe<ready && ready<call && call<lease, 'only read-only Worker-settings probe is allowed before mandatory checks; no remote write/lease until every test passes');
 const workflow=fs.readFileSync(path.join(root,'.github/workflows/deploy.yml'),'utf8');
 const check=workflow.indexOf('npm run test:storage');
 assert.ok(check>=0 && check<workflow.indexOf('npm run upgrade:prepare'));
});
