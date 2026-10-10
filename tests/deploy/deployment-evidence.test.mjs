import test from 'node:test';
import assert from 'node:assert/strict';
import {Cloudflare} from '../../scripts/upgrade/cloudflare.mjs';
import {assertD1KVRequest} from '../../scripts/upgrade/storage-policy.mjs';
import {rootRouteOrigin,discoverReleaseURLs,verifyReleaseURL,deploymentMarker,RELEASE_MARKER,releaseEvidence} from '../../scripts/upgrade/deployment-evidence.mjs';
const A='00000000-1111-2222-3333-000000000001',B='00000000-1111-2222-3333-000000000002';
const plan={version:'3.3.33',runId:'3.3.33-web-init-'+B,sourceHash:'c'.repeat(64),previousDeployment:{deploymentId:A,versionId:A},bindingIdentity:[]};
test('policy allows only read-only filtered domain lookup and script listing',()=>{
  for(const url of ['/workers/scripts','/workers/domains?service=original-worker'])assert.doesNotThrow(()=>assertD1KVRequest(url));
  for(const method of ['PUT','POST','DELETE'])for(const url of ['/workers/scripts','/workers/domains?service=original-worker'])assert.throws(()=>assertD1KVRequest(url,method),/ST_STORAGE_ROUTE/);
  for(const url of ['/workers/domains','/workers/domains?service=a&account_id=b','/workers/domains?service=..','/workers/domains?service=a%2Fb'])assert.throws(()=>assertD1KVRequest(url),/ST_STORAGE_ROUTE/);
});
test('actual Cloudflare client uses correct filtered GET path and bounded optional discovery',async()=>{
  const calls=[];
  const cf=new Cloudflare({accountId:'a'.repeat(32),token:'synthetic-token',fetchImpl:async(url,options)=>{calls.push({url,options});assert.equal(options.method,'GET');assert.equal(options.redirect,'error');return Response.json({success:true,result:[{id:'domain',service:'original-worker',environment:'production',hostname:'original.invalid'}]});}});
  const result=await discoverReleaseURLs(cf,{worker:'original-worker',domain:{enabled:false}});
  assert.equal(calls.length,1);assert.ok(calls[0].url.endsWith('/accounts/'+'a'.repeat(32)+'/workers/domains?service=original-worker'));assert.deepEqual(result.candidates,[{url:'https://original.invalid',source:'custom-domain'}]);
});
test('actual client does not retry optional discovery for a five-hundred response',async()=>{
  let count=0;const cf=new Cloudflare({accountId:'a'.repeat(32),token:'synthetic',fetchImpl:async()=>{count++;return Response.json({success:false,errors:[{code:1}]},{status:503});}});
  const r=await discoverReleaseURLs(cf,{worker:'original-worker',domain:{enabled:false}});assert.equal(count,2);assert.equal(r.candidates.length,0);assert.equal(r.warnings.length,2);
});
test('malformed domain API does not create a guessed URL',async()=>{
  const cf={request:async()=>({result:{}})};const r=await discoverReleaseURLs(cf,{worker:'original-worker',domain:{enabled:false}});assert.equal(r.candidates.length,0);
});
test('other service and non-default legacy environment domains are not selected',async()=>{
  const cf={request:async p=>({result:p.startsWith('/workers/domains')?[{service:'elsewhere',hostname:'wrong.invalid'},{service:'original',environment:'staging',hostname:'wrong2.invalid'}]:[]})};
  const r=await discoverReleaseURLs(cf,{worker:'original',domain:{enabled:false}});assert.equal(r.candidates.length,0);
});
test('route extraction requires a unique HTTPS-capable root hostname',()=>{
  assert.equal(rootRouteOrigin('example.invalid/*'),'https://example.invalid');assert.equal(rootRouteOrigin('https://example.invalid/*'),'https://example.invalid');
  for(const p of ['http://example.invalid/*','*.invalid/*','example.invalid/app/*','example.invalid/*?secret=1','evil@host.invalid/*','example.invalid:443/*','example.invalid'])assert.equal(rootRouteOrigin(p),null);
});
test('explicit origin takes precedence without listing other domains',async()=>{
  const cf={request:async()=>assert.fail('unexpected lookup')};const r=await discoverReleaseURLs(cf,{worker:'original',domain:{enabled:false},explicit:'https://original.invalid'});assert.equal(r.candidates[0].url,'https://original.invalid');
});
test('URL status body is bounded and cannot stand in for deployment evidence',async()=>{
  const r=await verifyReleaseURL([{url:'https://test.invalid'}],plan,{fetchImpl:async()=>new Response('x'.repeat(40000))});assert.equal(r.verified,false);
});
test('wrong runtime version, mode, readiness and run ID all fail URL verification',async()=>{
  const valid={version:plan.version,runId:plan.runId,mode:'deferred-web-init',codeDeployed:true,scope:'code-only',dataAccessed:false,readinessChecked:false,applicationReady:null,dataInitComplete:null};
  for(const update of [{version:'old'},{runId:'old'},{mode:'direct-compatible'},{applicationReady:true},{readinessChecked:true},{scope:'data'},{dataAccessed:true},{dataInitComplete:true},{codeDeployed:false}]){
    const r=await verifyReleaseURL([{url:'https://test.invalid'}],plan,{fetchImpl:async()=>Response.json({...valid,...update})});assert.equal(r.verified,false);
  }
});
test('evidence requires both a changed deployment and version',()=>{
  const snapshot={active:{deploymentId:B,versionId:B},bindings:[{name:RELEASE_MARKER,type:'plain_text',text:deploymentMarker(plan)}]};assert.equal(releaseEvidence(plan,snapshot),true);
  assert.equal(releaseEvidence(plan,{...snapshot,active:{deploymentId:A,versionId:B}}),false);assert.equal(releaseEvidence(plan,{...snapshot,active:{deploymentId:B,versionId:A}}),false);
});
test('runtime secrets or vars disappearing cannot be waived by a matching marker',()=>{
  assert.throws(()=>releaseEvidence({...plan,bindingIdentity:[{name:'ORIGINAL_SECRET',type:'secret_text'}]},{active:{deploymentId:B,versionId:B},bindings:[{name:RELEASE_MARKER,type:'plain_text',text:deploymentMarker(plan)}]}),/ST_UNBOUND_CHANGED/);
});
test('client retry controls cannot accidentally turn a bounded request into an infinite loop',async()=>{
  const cf=new Cloudflare({accountId:'a'.repeat(32),token:'synthetic',fetchImpl:()=>assert.fail()});for(const opts of [{maxAttempts:0},{maxAttempts:6},{timeoutMs:NaN},{timeoutMs:-1}])await assert.rejects(()=>cf.request('/workers/scripts',opts),/請求重試預算/);
});

test('code identity endpoint verifies without claiming runtime/data readiness',async()=>{
 const r=await verifyReleaseURL([{url:'https://test.invalid'}],plan,{fetchImpl:async(url,opts)=>{assert.ok(url.endsWith('/api/upgrade/code-status'));assert.equal(opts.method,'GET');return Response.json({version:plan.version,runId:plan.runId,mode:'deferred-web-init',codeDeployed:true,scope:'code-only',dataAccessed:false,readinessChecked:false,applicationReady:null,dataInitComplete:null});}});assert.equal(r.verified,true);
});
