import test from 'node:test';
import assert from 'node:assert/strict';
import {webInitBindingIdentity,preservedStorageConfig,assertPreservedStorage,assertWebInitLocalBindings,storageSummary} from '../../scripts/upgrade/web-init-bindings.mjs';
const DB='12345678-1234-1234-1234-123456789abc',KV='b'.repeat(32);
const d1={name:'SUBSCRIPTIONS_DB',type:'d1',id:DB},kv={name:'SUBSCRIPTIONS_KV',type:'kv_namespace',namespace_id:KV};
for(const stores of [[],[kv],[d1],[kv,d1]])test('canonical storage round-trip count='+stores.length+' types='+stores.map(b=>b.type).join(','),()=>{
 const rows=webInitBindingIdentity({bindings:stores}),config=preservedStorageConfig(rows);assert.doesNotThrow(()=>assertPreservedStorage(config,rows));assert.equal(storageSummary(rows).length,stores.length);
});
test('both D1 API ID fields agree after case normalization',()=>{
 const rows=webInitBindingIdentity({bindings:[{...d1,id:DB.toUpperCase(),database_id:DB}]});assert.equal(rows[0].database_id,DB);
});
test('disagreeing D1 ID aliases do not select an arbitrary database',()=>{
 assert.throws(()=>webInitBindingIdentity({bindings:[{...d1,database_id:'22345678-1234-1234-1234-123456789abc'}]}),/ST_BINDING_D1_ID/);
});
for(const id of ['',null,'0'.repeat(32),'PLACEHOLDER','z'.repeat(32)])test('reject invalid or missing KV ID '+String(id),()=>{
 assert.throws(()=>webInitBindingIdentity({bindings:[{...kv,namespace_id:id}]}),/ST_WEB_INIT_KV_ID/);
});
test('invalid or absent D1 does not become an empty binding set',()=>{
 for(const id of ['',null,'not-a-uuid','00000000-0000-0000-0000-000000000000'])assert.throws(()=>webInitBindingIdentity({bindings:[{...d1,id}]}),/ST_(WEB_INIT_D1_ID|BINDING_D1_ID)/);
});
test('duplicate names cannot cause one store to hide another',()=>{
 assert.throws(()=>webInitBindingIdentity({bindings:[kv,{...d1,name:kv.name}]}),/ST_BINDING_DUPLICATE/);
});
test('generated binding list may not be stripped, renamed, extended or redirected',()=>{
 const rows=webInitBindingIdentity({bindings:[kv,d1]}),base=preservedStorageConfig(rows);
 for(const change of [c=>c.kv_namespaces=[],c=>c.d1_databases=[],c=>c.kv_namespaces[0].binding='WRONG',c=>c.d1_databases[0].database_id='22345678-1234-1234-1234-123456789abc',c=>c.kv_namespaces.push({binding:'EXTRA',id:'c'.repeat(32)})]){
  const c=structuredClone(base);change(c);assert.throws(()=>assertPreservedStorage(c,rows),/ST_UNBOUND_GUARD/);
 }
});
test('no local resource injector survives binding-preserving config validation',()=>{
 for(const key of ['unsafe','site','send_email','browser','ai','images','version_metadata','wasm_modules','text_blobs','data_blobs','mtls_certificates','logfwdr','services','r2_buckets','queues'])assert.throws(()=>assertWebInitLocalBindings({[key]:{binding:'UNREVIEWED'}}),/ST_(UNBOUND_LOCAL_BINDINGS|STORAGE_POLICY)/);
});
test('canonicalizing IDs never mutates API input; log summaries exclude secret/variable values',()=>{
 const rows=[d1,kv,{name:'SECRET',type:'secret_text'},{name:'ORIGINAL',type:'plain_text',text:'do-not-log-me'}],copy=structuredClone(rows);const result=webInitBindingIdentity({bindings:rows});assert.deepEqual(rows,copy);assert.ok(!JSON.stringify(storageSummary(result)).includes('do-not-log-me'));
});
