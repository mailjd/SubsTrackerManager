import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertSplitBindingsReady} from '../../scripts/upgrade/cloudflare-checkpoints.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const settingsD1={bindings:[{name:'SUBSCRIPTIONS_KV',type:'kv_namespace',namespace_id:'b'.repeat(32)},{name:'SUBSCRIPTIONS_DB',type:'d1',database_id:'12345678-1234-1234-1234-123456789abc'}]};
const settingsKV={bindings:settingsD1.bindings.filter(b=>b.type!=='d1')};
test('D1 coordination succeeds only with a verified original D1 id',()=>{
  const x=assertSplitBindingsReady({worker:'existing-worker',settings:settingsD1,bindings:{dbId:'12345678-1234-1234-1234-123456789abc'}});
  assert.equal(x.atomicLeaseReady,true);assert.deepEqual(x.d1Bindings,[{name:'SUBSCRIPTIONS_DB',idVisible:true}]);
});
test('KV-only diagnosis gives exact safe alternative, without printing secrets or IDs',()=>{
  const old=console.log;let entry='';console.log=t=>{entry=t;};
  try{assert.throws(()=>assertSplitBindingsReady({worker:'existing-worker',settings:settingsKV,bindings:{kvId:'b'.repeat(32),dbId:null}}),e=>{
    assert.match(e.message,/ST_SPLIT_D1_REQUIRED/);
    assert.match(e.message,/GitHub Actions/);
    assert.match(e.message,/不要新建/);
    assert.doesNotMatch(e.message,/12345678-1234/);
    return true;
  });}finally{console.log=old;}
  assert.match(entry,/ST_SPLIT_BINDING_PROBE.*atomicLeaseReady":false/);
  assert.doesNotMatch(entry,/b{32}/);
});
test('a malformed existing D1 binding is distinct from no D1 and fails closed',()=>{
  const malformed={bindings:[...settingsKV.bindings,{name:'SUBSCRIPTIONS_DB',type:'d1'}]};
  assert.throws(()=>assertSplitBindingsReady({worker:'existing',settings:malformed,bindings:{dbId:null}}),/没有可核实的 database_id\/id/);
});
test('Cloudflare routing puts read-only real binding inspection BEFORE all expensive release checks',()=>{
  const src=fs.readFileSync(path.join(root,'scripts/deploy-cloudflare.mjs'),'utf8');
  assert.ok(src.indexOf('await cf.settings(config.name)')<src.indexOf('verifyReleaseChecks(ROOT,deadline)'));
  assert.ok(src.indexOf('assertSplitBindingsReady(')<src.indexOf('verifyReleaseChecks(ROOT,deadline)'));
  assert.ok(src.indexOf('verifyReleaseChecks(ROOT,deadline)')<src.indexOf('store.acquire()'));
});
test('GitHub safe upgrade push is opt-in and serial; manual workflow remains available',()=>{
  const workflow=fs.readFileSync(path.join(root,'.github/workflows/deploy.yml'),'utf8');
  assert.match(workflow,/workflow_dispatch:/);
  assert.match(workflow,/push:\s*\n\s*branches:\s*\[main, master\]/);
  assert.match(workflow,/github\.event_name == 'push' && vars\.SUBSTRACKER_AUTO_DEPLOY == 'true'/);
  assert.match(workflow,/concurrency:\s*\n\s*group: substracker-production\s*\n\s*cancel-in-progress: false/);
  assert.match(workflow,/npm run upgrade:prepare/);
  assert.match(workflow,/npm run upgrade:stage/);
  assert.match(workflow,/npm run upgrade:finish/);
  assert.match(workflow,/upload-artifact@v4/);
  assert.doesNotMatch(workflow,/npm run deploy:cloudflare/);
});
