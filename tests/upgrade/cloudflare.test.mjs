import test from 'node:test';
import assert from 'node:assert/strict';
import {Cloudflare,protectBindings} from '../../scripts/upgrade/cloudflare.mjs';
const accountId='a'.repeat(32),kv='b'.repeat(32),db='12345678-1234-1234-1234-123456789abc';
const settings=()=>({bindings:[{name:'SUBSCRIPTIONS_KV',type:'kv_namespace',namespace_id:kv},{name:'SUBSCRIPTIONS_DB',type:'d1',database_id:db},{name:'ORIGINAL_SECRET',type:'secret_text'},{name:'ENVIRONMENT',type:'plain_text',text:'production'}]});
const ok=(result,result_info)=>new Response(JSON.stringify({success:true,result,...(result_info?{result_info}:{})}),{status:200,headers:{'Content-Type':'application/json'}});
test('custom storage IDs retained without any name-based discovery',()=>{const out=protectBindings({},settings());assert.equal(out.kvId,kv);assert.equal(out.dbId,db);assert.deepEqual(out.secretNames,['ORIGINAL_SECRET']);});
test('matching explicit local binding retained',()=>assert.equal(protectBindings({kv_namespaces:[{binding:'SUBSCRIPTIONS_KV',id:kv}],d1_databases:[{binding:'SUBSCRIPTIONS_DB',database_id:db}]},settings()).kvId,kv));
test('local KV different from actual binding rejected',()=>assert.throws(()=>protectBindings({kv_namespaces:[{binding:'SUBSCRIPTIONS_KV',id:'c'.repeat(32)}]},settings()),/KV ID/));
test('local D1 different from actual binding rejected',()=>assert.throws(()=>protectBindings({d1_databases:[{binding:'SUBSCRIPTIONS_DB',database_id:'other'}]},settings()),/D1 ID/));
test('unknown binding rejected rather than removed at deploy',()=>{const s=settings();s.bindings.push({name:'OTHER_SERVICE',type:'service'});assert.throws(()=>protectBindings({},s),/其他绑定/);});
test('second KV rejected rather than silently dropped',()=>{const s=settings();s.bindings.push({name:'SECOND',type:'kv_namespace',namespace_id:'f'.repeat(32)});assert.throws(()=>protectBindings({},s),/结构不同/);});
test('legacy D1 id and modern database_id formats supported and conflicts refused',()=>{const s=settings();s.bindings[1].id=db;delete s.bindings[1].database_id;assert.equal(protectBindings({},s).dbId,db);s.bindings[1].database_id='87654321-1234-1234-1234-123456789abc';assert.throws(()=>protectBindings({},s),/不一致/);});
test('KV-only deployment does not create D1',()=>{const s=settings();s.bindings=s.bindings.filter(b=>b.type!=='d1');assert.equal(protectBindings({},s).dbId,null);});
test('missing bindings or missing token/account rejected',()=>{assert.throws(()=>protectBindings({},{}));assert.throws(()=>new Cloudflare({accountId:'',token:'x'}));assert.throws(()=>new Cloudflare({accountId,token:''}));});
test('full KV pagination preserves binary, expiration, metadata and encodes keys',async()=>{
 const trace=[];const c=new Cloudflare({accountId,token:'secret-never-log',fetchImpl:async(url,opts)=>{trace.push({url,opts});if(url.includes('/keys'))return url.includes('cursor=next')?ok([{name:'a/b'}],{cursor:'',count:1}):ok([{name:'x',expiration:4102444800,metadata:{tag:'keep'}}],{cursor:'next',count:1});return new Response(Uint8Array.from([0,255,127]));}});
 const rows=await c.snapshotKV(kv);assert.equal(rows.length,2);assert.deepEqual(rows.find(r=>r.name==='x').metadata,{tag:'keep'});assert.equal(rows[0].valueBase64,Buffer.from([0,255,127]).toString('base64'));assert.ok(trace.some(t=>t.url.endsWith('/values/a%2Fb')));assert.ok(trace.every(t=>!t.opts.method||t.opts.method==='GET'));
});
test('missing KV cursor metadata rejects partial backup',async()=>{const c=new Cloudflare({accountId,token:'x',fetchImpl:async()=>ok([])});await assert.rejects(c.snapshotKV(kv),/分页元数据/);});
test('KV pagination duplicate keys stop backup',async()=>{const c=new Cloudflare({accountId,token:'x',fetchImpl:async u=>u.includes('/keys')?ok([{name:'x'}],{cursor:'same',count:1}):new Response('one')});await assert.rejects(c.snapshotKV(kv),/重复 key/);});
test('KV key vanishing on read does not produce incomplete success',async()=>{const c=new Cloudflare({accountId,token:'x',fetchImpl:async u=>u.includes('/keys')?ok([{name:'gone'}],{cursor:'',count:1}):new Response('',{status:404})});await assert.rejects(c.snapshotKV(kv),/404/);});
test('Cloudflare API permission failure stops without create/delete calls',async()=>{const trace=[];const c=new Cloudflare({accountId,token:'x',fetchImpl:async(u,o)=>{trace.push(o.method);return new Response(JSON.stringify({success:false,errors:[{code:10000}]}),{status:403});}});await assert.rejects(c.settings('existing'),/403/);assert.deepEqual(trace,['GET']);});
test('D1 export polls actual API schema and never forwards token to signed URL',async()=>{
 const trace=[];let n=0;const c=new Cloudflare({accountId,token:'x',fetchImpl:async(u,o)=>{trace.push({url:String(u),opts:o});if(String(u).includes('export.invalid'))return new Response('CREATE TABLE example(id TEXT);');return ok(++n===1?{status:'active',at_bookmark:'book'}:{status:'complete',result:{signed_url:'https://export.invalid/sql'}});}});
 assert.match(await c.exportSQL(db),/CREATE TABLE/);assert.equal(JSON.parse(trace[1].opts.body).current_bookmark,'book');assert.equal(trace[2].opts.headers,undefined);
});
test('empty exported SQL or failed polling fail closed',async()=>{const c=new Cloudflare({accountId,token:'x',fetchImpl:async u=>String(u).includes('export.invalid')?new Response(''):ok({status:'complete',result:{signed_url:'https://export.invalid/sql'}})});await assert.rejects(c.exportSQL(db),/为空/);});
test('schedules and settings use correct endpoint and response structure',async()=>{
 const trace=[];const c=new Cloudflare({accountId,token:'x',fetchImpl:async u=>{trace.push(u);return u.endsWith('/schedules')?ok({schedules:[{cron:'0 * * * *'}]}):ok(settings());}});assert.equal((await c.schedules('my-worker'))[0].cron,'0 * * * *');assert.equal((await c.settings('my-worker')).bindings.length,4);assert.ok(trace[1].endsWith('/scripts/my-worker/settings'));
});
