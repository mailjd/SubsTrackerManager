import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Cloudflare,protectBindings} from '../../scripts/upgrade/cloudflare.mjs';
import {readWranglerConfig} from '../../scripts/upgrade/deploy-environment.mjs';
import {assertSameBindingIdentity} from '../../scripts/upgrade/worker-bindings.mjs';

const ACCOUNT='a'.repeat(32),KV='b'.repeat(32),DB='12345678-1234-1234-1234-123456789abc';
const VERSION='12345678-1111-2222-3333-123456789abc',DEPLOY='12345678-aaaa-bbbb-cccc-123456789abc';
const OTHER='87654321-1111-2222-3333-123456789abc';
const rows=()=>[{name:'SUBSCRIPTIONS_KV',type:'kv_namespace',namespace_id:KV},{name:'SUBSCRIPTIONS_DB',type:'d1',database_id:DB},{name:'KEEP_SECRET',type:'secret_text'},{name:'MODE',type:'plain_text',text:'production'}];
const deployment=()=>({id:DEPLOY,versions:[{version_id:VERSION,percentage:100}]});
const envelope=result=>Response.json({success:true,result});
function fixture({settings=rows().filter(b=>b.type!=='d1'),deployed=rows(),errorOn,changes=false,settingsChange=false,record=deployment(),versionId=VERSION}={}){
 const calls=[];let n=0,s=0;
 const cf=new Cloudflare({accountId:ACCOUNT,token:'TEST-PRIVATE-TOKEN',fetchImpl:async(url,options)=>{
  const p=new URL(url).pathname;calls.push({path:p,method:options.method});
  if(errorOn&&p.endsWith(errorOn))return Response.json({success:false,errors:[{code:10000,message:'must-not-use-remote-body'}]},{status:403});
  if(p.endsWith('/settings')){s++;return envelope({bindings:settingsChange&&s>1?rows():settings});}
  if(p.endsWith('/deployments')){n++;return envelope({deployments:[changes&&n>1?{...record,id:OTHER}:record]});}
  if(p.endsWith('/versions/'+VERSION))return envelope({id:versionId,resources:{bindings:deployed}});
  throw Error('Unexpected synthetic network route: '+p);
 }});
 return {cf,calls};
}
test('complete settings uses the existing fast path and preserves original bindings',async()=>{
 const f=fixture({settings:rows()});const result=await f.cf.settings('original',{requireD1:true});
 assert.equal(protectBindings({},result).dbId,DB);assert.equal(f.calls.length,1);
});
test('D1 absent from settings is recovered ONLY from the active 100-percent deployment',async()=>{
 const f=fixture();const result=await f.cf.settings('original',{requireD1:true});
 assert.equal(protectBindings({},result).dbId,DB);assert.equal(result.bindingDiscovery.source,'active-deployment');
 assert.equal(f.calls.length,5);assert.ok(f.calls.every(x=>x.method==='GET'));assert.ok(f.calls.some(x=>x.path.endsWith('/versions/'+VERSION)));
 assert.ok(!f.calls.some(x=>x.path.endsWith('/versions')||x.path.includes('/d1/database')),'never enumerate names or latest uploaded versions');
});
test('D1 row without ID is resolved, not dropped, even for a long-run upgrade',async()=>{
 const settings=rows();delete settings[1].database_id;
 const f=fixture({settings});assert.equal(protectBindings({},await f.cf.settings('original')).dbId,DB);
});
test('legacy id spelling in the active version remains supported',async()=>{
 const deployed=rows();deployed[1].id=deployed[1].database_id;delete deployed[1].database_id;
 const f=fixture({deployed});assert.equal(protectBindings({},await f.cf.settings('original',{requireD1:true})).dbId,DB);
});
test('settings/current version agree on KV-only: preserve null and let the split guard stop',async()=>{
 const f=fixture({deployed:rows().filter(b=>b.type!=='d1')});
 assert.equal(protectBindings({},await f.cf.settings('original',{requireD1:true})).dbId,null);
 assert.ok(f.calls.every(x=>x.method==='GET'));
});
test('KV-only long-run path does not acquire a new version-API requirement',async()=>{
 const f=fixture();assert.equal(protectBindings({},await f.cf.settings('original')).dbId,null);assert.equal(f.calls.length,1);
});
test('missing-ID D1 cannot be silently deployed as KV-only by protectBindings',()=>{
 const bindings=rows();delete bindings[1].database_id;
 assert.throws(()=>protectBindings({}, {bindings}),/ST_BINDING_D1_UNRESOLVED/);
});
test('unresolved deployed D1 does not become null',async()=>{
 const deployed=rows();delete deployed[1].database_id;
 const f=fixture({deployed});await assert.rejects(f.cf.settings('original',{requireD1:true}),/ST_BINDING_D1_UNRESOLVED/);
});
test('a D1 row in settings and none in the current version is a conflict',async()=>{
 const settings=rows();delete settings[1].database_id;
 const f=fixture({settings,deployed:rows().filter(b=>b.type!=='d1')});
 await assert.rejects(f.cf.settings('original'),/ST_BINDING_D1_UNRESOLVED/);
});
test('permission failure is unresolved, not a false KV-only verdict or a write attempt',async()=>{
 const f=fixture({errorOn:'/deployments'});
 await assert.rejects(f.cf.settings('original',{requireD1:true}),e=>/ST_BINDING_PROBE_INCOMPLETE.*HTTP 403/.test(e.message)&&!e.message.includes('TEST-PRIVATE-TOKEN')&&!e.message.includes('must-not-use-remote-body'));
 assert.ok(f.calls.every(x=>x.method==='GET'));
});
test('missing binding list stops before any version fallback',async()=>{
 const f=fixture({settings:null});await assert.rejects(f.cf.settings('original',{requireD1:true}),/ST_BINDING_RESPONSE/);assert.equal(f.calls.length,1);
});
test('malformed current version response fails closed',async()=>{
 const f=fixture({deployed:{}});await assert.rejects(f.cf.settings('original',{requireD1:true}),/ST_BINDING_RESPONSE/);
});
test('version identity must match the live deployment rather than an arbitrary uploaded version',async()=>{
 const f=fixture({versionId:OTHER});await assert.rejects(f.cf.settings('original',{requireD1:true}),/ST_BINDING_PROBE_INCOMPLETE/);
});
test('live deployment changing during the probe stops without writes',async()=>{
 const f=fixture({changes:true});await assert.rejects(f.cf.settings('original',{requireD1:true}),/ST_BINDING_CHANGED/);
});
test('settings changing during the probe stops without merging the two results',async()=>{
 const f=fixture({settingsChange:true});await assert.rejects(f.cf.settings('original',{requireD1:true}),/ST_BINDING_CHANGED/);
});
test('gradual deployment is not collapsed into a guessed D1 binding',async()=>{
 const f=fixture({record:{...deployment(),versions:[{version_id:VERSION,percentage:50},{version_id:OTHER,percentage:50}]}});
 await assert.rejects(f.cf.settings('original',{requireD1:true}),/ST_BINDING_MULTIVERSION/);assert.equal(f.calls.length,2);
});
for(const kind of ['kv','variables','secret-names','extra-bindings'])test('cross-source '+kind+' mismatch stops instead of merging resources',async()=>{
 const deployed=rows();
 if(kind==='kv')deployed[0].namespace_id='c'.repeat(32);
 if(kind==='variables')deployed[3].text='staging';
 if(kind==='secret-names')deployed[2].name='DIFFERENT_SECRET';
 if(kind==='extra-bindings')deployed.push({name:'ANOTHER_STORE',type:'kv_namespace',namespace_id:'d'.repeat(32)});
 const f=fixture({deployed});await assert.rejects(f.cf.settings('original',{requireD1:true}),/ST_BINDING_SOURCE_CONFLICT/);
});
test('duplicate remote names are refused before deciding the storage mode',async()=>{
 const f=fixture({settings:[...rows(),rows()[0]]});await assert.rejects(f.cf.settings('original',{requireD1:true}),/ST_BINDING_DUPLICATE/);
});
test('UUIDs are validated structurally and case normalized; two inconsistent IDs fail',()=>{
 const bindings=rows();bindings[1].database_id=DB.toUpperCase();bindings[1].id=DB;
 assert.equal(protectBindings({}, {bindings}).dbId,DB);
 bindings[1].id=OTHER;assert.throws(()=>protectBindings({}, {bindings}),/不一致/);
 delete bindings[1].id;bindings[1].database_id='-'.repeat(36);assert.throws(()=>protectBindings({}, {bindings}),/ST_BINDING_D1_ID/);
});
test('identity revalidation catches binding drift after slow release checks',()=>{
 const a=protectBindings({}, {bindings:rows()});const b=structuredClone(a);b.dbId=OTHER;
 assert.throws(()=>assertSameBindingIdentity(a,b),/ST_BINDING_CHANGED/);
 const c=structuredClone(a);c.variables[0].text='changed';assert.throws(()=>assertSameBindingIdentity(a,c),/ST_BINDING_CHANGED/);
 const d=structuredClone(a);d.secretNames.push('NEW_SECRET');assert.throws(()=>assertSameBindingIdentity(a,d),/ST_BINDING_CHANGED/);
 assert.equal(assertSameBindingIdentity(a,structuredClone(a)),true);
});
test('read-only route allowlist admits only scoped deployment and UUID-version GETs',async()=>{
 const f=fixture();
 for(const route of ['/workers/scripts/original/deployments','/workers/scripts/original/versions/'+VERSION])
  await assert.rejects(f.cf.request(route,{method:'POST'}),/ST_STORAGE_ROUTE/);
 for(const route of ['/workers/scripts/original/versions','/workers/scripts/original/versions/../settings','/workers/scripts/original/versions/not-a-uuid'])
  await assert.rejects(f.cf.request(route),/ST_STORAGE_ROUTE/);
 assert.equal(f.calls.length,0);
});
function configFixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'st-env3330-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.writeFileSync(path.join(root,'wrangler.toml'),`name="original"\n[[kv_namespaces]]\nbinding="SUBSCRIPTIONS_KV"\nid="${KV}"\n[[d1_databases]]\nbinding="SUBSCRIPTIONS_DB"\ndatabase_id="${DB}"\n[vars]\nTOP_ONLY="never-inherit"\n[env.staging]\n[env.production]\nname="explicit-original"\n[[env.production.kv_namespaces]]\nbinding="SUBSCRIPTIONS_KV"\nid="${'c'.repeat(32)}"\n`);
 return root;
}
test('named environment without explicit name uses original-env, not the top-level Worker',t=>{
 const root=configFixture(t);assert.equal(readWranglerConfig(root,{SUBSTRACKER_ENVIRONMENT:'staging'}).name,'original-staging');
});
test('named environment never inherits top-level KV/D1 IDs or variables',t=>{
 const root=configFixture(t);const c=readWranglerConfig(root,{SUBSTRACKER_ENVIRONMENT:'staging'});
 assert.equal(c.kv_namespaces,undefined);assert.equal(c.d1_databases,undefined);assert.equal(c.vars,undefined);
});
test('explicit environment name/binding and explicit original Worker override remain intact',t=>{
 const root=configFixture(t);const c=readWranglerConfig(root,{SUBSTRACKER_ENVIRONMENT:'production'});
 assert.equal(c.name,'explicit-original');assert.equal(c.kv_namespaces[0].id,'c'.repeat(32));assert.equal(c.d1_databases,undefined);
 assert.equal(readWranglerConfig(root,{SUBSTRACKER_ENVIRONMENT:'production',SUBSTRACKER_WORKER_NAME:'actual-original'}).name,'actual-original');
 assert.equal(readWranglerConfig(root,{}).kv_namespaces[0].id,KV);
});
