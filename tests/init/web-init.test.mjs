import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,sample,payment} from '../upgrade/helpers.mjs';
import {handleWebInitGate,webInitReady,inspectWebInit} from '../../src/data/web-init.js';
import {handleUpgradeGate,upgradeReady} from '../../src/data/upgrade-gate.js';
import {WEB_INIT_MODE,WEB_INIT_PREFIX,WEB_INIT_TABLE} from '../../src/data/web-init-protocol.js';
import {inspectWebSchema} from '../../src/data/web-init-schema.js';
import {readRawLedgerEntries} from '../../src/data/subscription-ledger.js';
import {VERSION} from '../../src/version.js';
const origin='https://example.invalid';
const run={version:VERSION,id:VERSION+'-web-init-test',mode:WEB_INIT_MODE,tokenHash:''};
const password='Keep-original-SuperAdmin-9876';
function req(path,{method='GET',body,headers={}}={}){return new Request(origin+path,{method,...(body!==undefined?{body:JSON.stringify(body)}:{}),headers:{...(method==='POST'?{'Origin':origin,'Content-Type':'application/json','X-SubsTracker-Init':'1'}:{}),...headers}});}
const api=(f,op,body={})=>handleWebInitGate(req('/api/init/'+op,{method:'POST',body:{password,...body},headers:{'CF-Connecting-IP':f.ip||'192.0.2.1'}}),f.env,run);
async function result(f,op,body={}){const r=await api(f,op,body),data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data;}
let ipIndex=10;
async function setup(t,options={}){const f=await fixture(options);f.ip='192.0.2.'+(ipIndex++);t.after(()=>f.close());f.env.SUBSTRACKER_SUPERADMIN_PASSWORD=password;return f;}
async function start(f){const p=await result(f,'preview');return result(f,'start',{expectedDigest:p.expectedDigest,confirmOriginalBindings:true,confirmBackup:true});}
async function finish(f,limit=80){let d;for(let n=0;n<limit;n++){d=await result(f,'step');if(d.applicationReady)return d;}assert.fail('init not complete: '+JSON.stringify(d));}
const businessSnapshot=f=>f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_meta','subscription_ledger',?) ORDER BY name").all(WEB_INIT_TABLE).map(t=>[t.name,f.db.prepare('SELECT * FROM "'+t.name+'" ORDER BY rowid').all()]);

test('unbound GET renders a self-contained init page and reports CODE deployed, not application ready',async()=>{
  const env={};for(const path of ['/','/init','/admin']){const r=await handleUpgradeGate(req(path),env,run);assert.equal(r.status,200);assert.match(await r.text(),/SuperAdmin/);}
  const r=await handleUpgradeGate(req('/api/upgrade/status'),env,run),s=await r.json();assert.equal(r.status,200);assert.equal(s.phase,'bindings_required');assert.equal(s.codeDeployed,true);assert.equal(s.applicationReady,false);assert.equal(s.maintenance,true);
  assert.equal(await upgradeReady(env,run),false);
});
test('missing KV or missing D1 is not treated as a new install',async t=>{
  const f=await setup(t);for(const absent of ['SUBSCRIPTIONS_DB','SUBSCRIPTIONS_KV']){const env={...f.env};delete env[absent];assert.equal(await webInitReady(env,run),false);const r=await handleWebInitGate(req('/api/subscriptions',{method:'POST',body:{}}),env,run);assert.equal(r.status,503);}assert.deepEqual(f.writes,[]);
});
test('GETs and page refreshes with both resources bound do not run migration or initialize config',async t=>{
  const f=await setup(t);const snapshot=JSON.stringify([...f.values]);for(const path of ['/','/init','/api/init/status','/api/upgrade/status','/api/init/start','/api/init/step'])await handleWebInitGate(req(path),f.env,run);assert.deepEqual(f.writes,[]);assert.equal(JSON.stringify([...f.values]),snapshot);assert.equal(await webInitReady(f.env,run),false);
});
test('init auth is runtime SuperAdmin, not normal admin or any hard-coded password',async t=>{
  const f=await setup(t);for(const secret of ['','password','same-hash','wrong']){const r=await api(f,'preview',{password:secret});assert.equal(r.status,403);}assert.deepEqual(f.writes,[]);
});
test('runtime SuperAdmin username is required only when already configured',async t=>{
  const f=await setup(t);f.env.SUBSTRACKER_SUPERADMIN_USERNAME='ExistingOwner';const r=await api(f,'preview');assert.equal(r.status,403);assert.equal((await api(f,'preview',{username:'ExistingOwner'})).status,200);assert.deepEqual(f.writes,[]);
});
test('missing runtime secret still permits code/page deployment but refuses all initialization writes',async t=>{
  const f=await setup(t);delete f.env.SUBSTRACKER_SUPERADMIN_PASSWORD;assert.equal((await handleWebInitGate(req('/init'),f.env,run)).status,200);assert.equal((await api(f,'start',{confirmBackup:true,confirmOriginalBindings:true})).status,503);assert.deepEqual(f.writes,[]);
});
for(const headers of [{'Origin':'https://evil.invalid'},{'Origin':''},{'X-SubsTracker-Init':''},{'Content-Type':'text/plain'}])test('cross-site/simple-form request rejected '+JSON.stringify(headers),async t=>{
  const f=await setup(t);const r=await handleWebInitGate(req('/api/init/start',{method:'POST',body:{password},headers}),f.env,run);assert.equal(r.status,403);assert.deepEqual(f.writes,[]);
});
test('oversized chunked request rejected before any data read/write',async t=>{
  const f=await setup(t);const r=await api(f,'preview',{junk:'a'.repeat(17000)});assert.equal(r.status,413);assert.deepEqual(f.writes,[]);
});
test('unconfirmed start does not even CREATE the control table',async t=>{
  const f=await setup(t);const r=await api(f,'start');assert.equal(r.status,400);assert.deepEqual(f.writes,[]);
});
test('old KV schema, empty original config, missing encryption key and malformed data are not reset',async t=>{
  for(const [key,value] of [['schema_version','v2'],['config','{}'],['config','invalid-json'],['sub_index','broken']]){const f=await fixture();t.after(()=>f.close());f.env.SUBSTRACKER_SUPERADMIN_PASSWORD=password;f.values.set(key,value);const before=JSON.stringify([...f.values]);assert.equal((await api(f,'preview')).status,409);assert.equal(JSON.stringify([...f.values]),before);assert.deepEqual(f.writes,[]);}
});
test('source changes between preview and start prevent all writes',async t=>{
  const f=await setup(t),p=await result(f,'preview');const s=JSON.parse(f.values.get('sub:a'));s.amount=66;f.values.set('sub:a',JSON.stringify(s));const r=await api(f,'start',{expectedDigest:p.expectedDigest,confirmOriginalBindings:true,confirmBackup:true});assert.equal(r.status,409);assert.deepEqual(f.writes,[]);
});
test('complete web init preserves every original KV value and all business SQL rows',async t=>{
  const f=await setup(t,{rows:[sample('a',{paymentHistory:[payment()]})]}),kvBefore=new Map(f.values),sqlBefore=JSON.stringify(businessSnapshot(f));
  await start(f);const d=await finish(f);assert.equal(d.code,'ST_WEB_INIT_COMPLETE');assert.equal(await webInitReady(f.env,run),true);
  for(const [k,v] of kvBefore)assert.equal(f.values.get(k),v,k);
  assert.equal(JSON.stringify(businessSnapshot(f)),sqlBefore);assert.equal(d.report.ledgerCount,1);assert.equal(d.report.added,1);
  for(const k of f.values.keys())if(!kvBefore.has(k))assert.ok(k.startsWith(WEB_INIT_PREFIX));
  assert.equal(await handleUpgradeGate(req('/api/subscriptions'),f.env,run),null);
  const s=await (await handleWebInitGate(req('/api/upgrade/status'),f.env,run)).json();assert.equal(s.phase,'ready');assert.equal(s.maintenance,false);
});
test('repeat init after completion is read-only and never duplicates history',async t=>{
  const f=await setup(t);await start(f);await finish(f);const before=(await readRawLedgerEntries(f.env)).length;f.writes.length=0;await start(f);await finish(f);assert.equal((await readRawLedgerEntries(f.env)).length,before);assert.deepEqual(f.writes,[]);
});
test('legacy account primary key is rejected before any write (no DROP, replacement or reset)',async t=>{
  const f=await setup(t);f.db.exec('DROP TABLE account_credentials; DROP TABLE accounts; CREATE TABLE accounts(account_serial TEXT PRIMARY KEY,account TEXT);');const r=await api(f,'preview');assert.equal(r.status,409);assert.equal((await r.json()).code,'INIT_SCHEMA_CONFLICT');assert.deepEqual(f.writes,[]);
});
test('missing modern optional account column is added without changing original rows',async t=>{
  const f=await setup(t);f.db.exec("INSERT INTO accounts(account,account_serial,created_at,updated_at) VALUES('existing','公司01号','old','old'); ALTER TABLE accounts DROP COLUMN owner_type;");
  await start(f);await finish(f);const row=f.db.prepare('SELECT * FROM accounts').get();assert.equal(row.account,'existing');assert.equal(row.created_at,'old');assert.equal(row.owner_type,'');assert.equal(row.account_serial,'公司01号');
  assert.ok(f.writes.some(s=>s.includes('ADD COLUMN owner_type')));assert.ok(!f.writes.some(s=>/DROP TABLE|INSERT OR REPLACE|DELETE FROM accounts|UPDATE accounts/i.test(s)));
});
test('empty original D1 can gain missing modern tables; no database resource is created',async t=>{
  const f=await setup(t);f.db.exec('PRAGMA foreign_keys=OFF;');for(const row of f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all())f.db.exec('DROP TABLE "'+row.name+'"');
  await start(f);const d=await finish(f);assert.equal(d.applicationReady,true);assert.ok(f.db.prepare("SELECT name FROM sqlite_master WHERE name='accounts'").get());assert.equal(f.values.get('schema_version'),'v3');
});
test('schema preflight is entirely read-only and identifies modern schema gaps',async t=>{
  const f=await setup(t);f.db.exec('DROP INDEX idx_subscription_ledger_time');const p=await inspectWebSchema(f.env.SUBSCRIPTIONS_DB);assert.ok(p.sql.some(s=>s.includes('idx_subscription_ledger_time')));assert.deepEqual(f.writes,[]);
});
test('step is resumable after a rejected insert batch; no completion marker is fabricated',async t=>{
  const f=await setup(t);await start(f);await result(f,'step');f.control.dropLedger=true;const r=await api(f,'step');assert.equal(r.status,409);assert.equal(await webInitReady(f.env,run),false);f.control.dropLedger=false;await finish(f);assert.equal((await readRawLedgerEntries(f.env)).length,1);
});
test('multiple small ledger batches retain progress across browser sessions',async t=>{
  const f=await setup(t,{rows:Array.from({length:25},(_,i)=>sample('s'+i))});await start(f);let d=await result(f,'step');assert.equal(d.phase,'ledger');d=await result(f,'step');assert.equal(d.phase,'ledger');assert.equal(d.progress.written,8);const p=await result(f,'preview');assert.equal(p.resume,true);await start(f);d=await finish(f);assert.equal(d.report.ledgerCount,25);
});
test('KV eventual-consistency read miss waits, does not repeat marker writes or unlock early',async t=>{
  const f=await setup(t);await start(f);await result(f,'step');await result(f,'step');const get=f.env.SUBSCRIPTIONS_KV.get;let hide=true;
  f.env.SUBSCRIPTIONS_KV.get=async(k,opt)=>typeof k==='string'&&k.startsWith(WEB_INIT_PREFIX)&&hide?null:get(k,opt);
  let d=await result(f,'step');assert.equal(d.phase,'verify_kv');const putCount=f.writes.filter(x=>x.startsWith(WEB_INIT_PREFIX)).length;
  for(let n=0;n<4;n++){d=await result(f,'step');assert.equal(d.applicationReady,false);assert.equal(d.phase,'verify_kv');assert.equal(d.retryAfterSeconds,5);}
  assert.equal(f.writes.filter(x=>x.startsWith(WEB_INIT_PREFIX)).length,putCount);hide=false;await finish(f);
});
test('substituting KV after completion never reuses cached D1 approval',async t=>{
  const f=await setup(t);await start(f);await finish(f);const g=await setup(t);const env={...f.env,SUBSCRIPTIONS_KV:g.env.SUBSCRIPTIONS_KV};assert.equal(await webInitReady(env,run),false);assert.equal(await webInitReady(f.env,{...run,id:run.id+'-new'}),false);
});
test('changing original source during a paused init stops before the next write',async t=>{
  const f=await setup(t);await start(f);f.values.set('config',f.values.get('config').replace('same-admin','changed-admin'));f.writes.length=0;const r=await api(f,'step');assert.equal(r.status,409);assert.equal((await r.json()).code,'INIT_CONFIG_CHANGED');assert.deepEqual(f.writes,[]);
});
test('public status and HTML do not disclose stored config, source records, secrets or hashes',async t=>{
  const f=await setup(t);await start(f);await finish(f);for(const path of ['/api/upgrade/status','/api/init/status','/init']){const text=await (await handleWebInitGate(req(path),f.env,run)).text();for(const sensitive of [password,'old-auth-secret','old-credential-secret','same-admin','demo@example.invalid'])assert.ok(!text.includes(sensitive),path+':'+sensitive);}
});
test('ordinary direct and legacy upgrade endpoints are not exposed by deferred init mode',async t=>{
  const f=await setup(t);for(const op of ['apply','commit','progress','report'])assert.equal((await handleWebInitGate(req('/api/upgrade/'+op,{method:'POST',body:{}}),f.env,run)).status,409);assert.deepEqual(f.writes,[]);
});
test('two concurrent ledger retries never duplicate or overwrite originals',async t=>{
  const f=await setup(t,{rows:Array.from({length:10},(_,i)=>sample('s'+i))});await start(f);await result(f,'step');const replies=await Promise.all([api(f,'step'),api(f,'step')]);for(const r of replies)assert.ok([200,409].includes(r.status));await finish(f);assert.equal((await readRawLedgerEntries(f.env)).length,10);
});
test('each small init step stays within 50 D1 statements on a representative modern fixture',async t=>{
  const f=await setup(t,{rows:Array.from({length:20},(_,i)=>sample('n'+i))});f.control.maxQueries=50;
  f.control.queries=0;const p=await result(f,'preview');f.control.queries=0;await result(f,'start',{expectedDigest:p.expectedDigest,confirmOriginalBindings:true,confirmBackup:true});
  let done=false;for(let n=0;n<20;n++){f.control.queries=0;const d=await result(f,'step');assert.ok(f.control.queries<=50);if(d.applicationReady){done=true;break;}}assert.equal(done,true);
});
test('ordinary config changes after completion do not invalidate init; original key replacement does',async t=>{
  const f=await setup(t);await start(f);await finish(f);const cfg=JSON.parse(f.values.get('config'));cfg.THEME_MODE='light';f.values.set('config',JSON.stringify(cfg));assert.equal(await webInitReady(f.env,run),true);cfg.JWT_SECRET='changed-secret';f.values.set('config',JSON.stringify(cfg));assert.equal(await webInitReady(f.env,run),false);
});
test('conflicting KV receipt never gets overwritten or treated as complete',async t=>{
  const f=await setup(t);await start(f);await result(f,'step');await result(f,'step');const key=WEB_INIT_PREFIX+run.id+':complete';f.values.set(key,'different existing value');f.writes.length=0;const r=await api(f,'step');assert.equal(r.status,409);assert.equal((await r.json()).code,'INIT_KV_RECEIPT_CONFLICT');assert.equal(f.values.get(key),'different existing value');assert.deepEqual(f.writes,[]);
});
test('existing malformed historical completion flag fails in preview, before all writes',async t=>{
  const f=await setup(t);f.db.prepare("INSERT INTO schema_meta(key,value,updated_at) VALUES('subscription_ledger_seed_3320','broken','old')").run();const r=await api(f,'preview');assert.equal(r.status,409);assert.equal((await r.json()).code,'INIT_OLD_MARKER_INVALID');assert.deepEqual(f.writes,[]);
});
test('custom same-name wrong index is detected instead of silently accepted or rebuilt',async t=>{
  const f=await setup(t);f.db.exec('DROP INDEX idx_subscription_ledger_time; CREATE INDEX idx_subscription_ledger_time ON subscription_ledger(source);');const r=await api(f,'preview');assert.equal(r.status,409);assert.equal((await r.json()).code,'INIT_SCHEMA_CONFLICT');assert.deepEqual(f.writes,[]);
});
test('an interrupted response after ledger commit resumes without replaying an immutable receipt',async t=>{
  const f=await setup(t);await start(f);await result(f,'step');let injected=false;
  f.control.onBatch=async stmts=>{if(!injected&&stmts.some(s=>s.text.startsWith('INSERT INTO subscription_ledger'))){injected=true;throw new Error('lost response after committed transaction');}};
  assert.equal((await api(f,'step')).status,409);assert.equal((await readRawLedgerEntries(f.env)).length,1);f.control.onBatch=null;await finish(f);assert.equal((await readRawLedgerEntries(f.env)).length,1);
});
test('concurrent start creates a single stable checkpoint without overwriting its nonce',async t=>{
  const f=await setup(t),p=await result(f,'preview'),body={expectedDigest:p.expectedDigest,confirmOriginalBindings:true,confirmBackup:true};const replies=await Promise.all([api(f,'start',body),api(f,'start',body)]);for(const r of replies)assert.equal(r.status,200);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM '+WEB_INIT_TABLE).get().n,1);await finish(f);
});
test('init HTML has a nonce CSP, no external script, and never uses persistent browser credential storage',async()=>{
  const r=await handleWebInitGate(req('/init'),{},run),html=await r.text();assert.match(r.headers.get('Content-Security-Policy'),/frame-ancestors 'none'/);assert.match(r.headers.get('Content-Security-Policy'),/script-src 'nonce-/);assert.ok(!/localStorage|sessionStorage|<script[^>]+src=/.test(html));
});
