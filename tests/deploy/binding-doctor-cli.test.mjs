import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
const ROOT=path.resolve(import.meta.dirname,'../..');
const D1='11111111-2222-4333-8444-555555555555',KV='a'.repeat(32);
const expected=['schema_meta','subscriptions_current','subscription_history','accounts','account_credentials','account_history','menu_option_groups','menu_options','account_database_backups'];
const PRELOAD=`import fs from 'node:fs';const KV='${KV}', D1='${D1}';
const schema=${JSON.stringify(expected)};
globalThis.fetch=async(url,options={})=>{
  const method=options.method||'GET';
  fs.appendFileSync(process.env.ST_MOCK_CALLS,JSON.stringify({method,url:url.split('/client/v4/accounts/')[1]?.slice(32)||url})+'\\n');
  const mode=process.env.ST_MOCK_MODE;
  const kv={type:'kv_namespace',name:'SUBSCRIPTIONS_KV',namespace_id:KV},db={type:'d1',name:'SUBSCRIPTIONS_DB',database_id:D1};
  if(url.endsWith('/settings'))return Response.json({success:true,result:{bindings:mode==='kvonly'?[kv]:[kv,db]}});
  if(url.endsWith('/database/'+D1))return Response.json({success:true,result:{name:'original-business'}});
  if(url.endsWith('/database/'+D1+'/query'))return Response.json({success:true,result:[{success:true,results:(mode==='empty'?[schema[0]]:schema).map(name=>({name}))}]});
  return Response.json({success:false,errors:[{code:1000}]},{status:404});
};`;
function fixture(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'substracker-ci-pin-'));const files=[
'scripts/existing-d1-doctor.mjs','scripts/upgrade/cloudflare.mjs','scripts/upgrade/deploy-environment.mjs',
'scripts/upgrade/storage-policy.mjs','scripts/upgrade/d1-query-snapshot.mjs','scripts/upgrade/original-binding-repair.mjs','src/version.js'];
for(const file of files){fs.mkdirSync(path.dirname(path.join(dir,file)),{recursive:true});fs.copyFileSync(path.join(ROOT,file),path.join(dir,file));}
const wrangler=`name = "subscription-manager"\nmain = "src/index.js"\n[env.production]\nname = "subscription-manager"\n[env.staging]\nname = "subscription-manager-staging"\n[build]\ncommand = "node scripts/require-safe-upgrade.mjs"\n`;
fs.writeFileSync(path.join(dir,'package.json'),'{"type":"module"}');fs.writeFileSync(path.join(dir,'wrangler.toml'),wrangler);
const preload=path.join(dir,'preload.mjs'),calls=path.join(dir,'calls.jsonl');fs.writeFileSync(preload,PRELOAD);return {dir,wrangler,preload,calls,cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};}
function run(f,{mode='kvonly',pin=false,id=D1,environment}={}){
const env={...process.env,CLOUDFLARE_ACCOUNT_ID:'c'.repeat(32),CLOUDFLARE_API_TOKEN:'fake-test-only',SUBSTRACKER_WORKER_NAME:'subscription-manager',SUBSTRACKER_ORIGINAL_D1_ID:id,ST_MOCK_CALLS:f.calls,ST_MOCK_MODE:mode};if(environment)env.SUBSTRACKER_ENVIRONMENT=environment;else delete env.SUBSTRACKER_ENVIRONMENT;
const r=spawnSync(process.execPath,['--import',f.preload,path.join(f.dir,'scripts/existing-d1-doctor.mjs'),...(pin?['--pin']:[])],{cwd:f.dir,env,encoding:'utf8',timeout:15000});
const calls=fs.existsSync(f.calls)?fs.readFileSync(f.calls,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)):[];
return {...r,calls,output:r.stdout+'\n'+r.stderr};}
test('KV-only diagnosis uses one remote GET and never modifies Worker or file',()=>{const f=fixture();try{const r=run(f);assert.equal(r.status,1);assert.match(r.output,/ST_D1_LIVE_MISSING/);assert.deepEqual(r.calls.map(c=>c.method),['GET']);assert.equal(fs.readFileSync(path.join(f.dir,'wrangler.toml'),'utf8'),f.wrangler);}finally{f.cleanup();}});
test('binding pin checks actual live original D1 and read-only schema before local update',()=>{const f=fixture();try{const r=run(f,{mode:'d1',pin:true});assert.equal(r.status,0,r.output);assert.deepEqual(r.calls.map(c=>c.method),['GET','GET','POST']);assert.equal(r.calls.at(-1).url.endsWith('/query'),true);const parsed=JSON.parse(execFileSync('python3',['-c','import sys,json,tomllib;print(json.dumps(tomllib.load(open(sys.argv[1],"rb"))))',path.join(f.dir,'wrangler.toml')],{encoding:'utf8'}));assert.equal(parsed.d1_databases[0].database_id,D1);assert.equal(parsed.kv_namespaces[0].id,KV);assert.equal(parsed.env.staging.d1_databases,undefined);assert.ok(fs.existsSync(path.join(f.dir,'.binding-backups')));assert.equal(r.output.includes('fake-test-only'),false);}finally{f.cleanup();}});
test('wrong explicit id rejected without any remote D1 query or local write',()=>{const f=fixture();try{const r=run(f,{mode:'d1',pin:true,id:'99999999-2222-4333-8444-555555555555'});assert.equal(r.status,1);assert.match(r.output,/ST_D1_NOT_ACTIVE/);assert.deepEqual(r.calls.map(c=>c.method),['GET']);assert.equal(fs.readFileSync(path.join(f.dir,'wrangler.toml'),'utf8'),f.wrangler);}finally{f.cleanup();}});
test('empty existing D1 rejected, no local source written',()=>{const f=fixture();try{const r=run(f,{mode:'empty',pin:true});assert.equal(r.status,1);assert.match(r.output,/ST_D1_EMPTY_OR_WRONG/);assert.deepEqual(r.calls.map(c=>c.method),['GET','GET','POST']);assert.equal(fs.readFileSync(path.join(f.dir,'wrangler.toml'),'utf8'),f.wrangler);}finally{f.cleanup();}});
test('production Wrangler env pins to env.production only; staging and root untouched',()=>{const f=fixture();try{const r=run(f,{mode:'d1',pin:true,environment:'production'});assert.equal(r.status,0,r.output);const parsed=JSON.parse(execFileSync('python3',['-c','import sys,json,tomllib;print(json.dumps(tomllib.load(open(sys.argv[1],"rb"))))',path.join(f.dir,'wrangler.toml')],{encoding:'utf8'}));assert.equal(parsed.env.production.d1_databases[0].database_id,D1);assert.equal(parsed.env.staging.d1_databases,undefined);assert.equal(parsed.d1_databases,undefined);}finally{f.cleanup();}});
