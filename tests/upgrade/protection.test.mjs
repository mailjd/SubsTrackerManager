import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,sample,payment,clone} from './helpers.mjs';
import {collectSubscriptionInventory,stableJSON,sha256} from '../../src/data/upgrade-reconcile.js';
import {planLedgerUpgrade,runLedgerUpgrade,readRawLedgerEntries,allLedgerEntries,makeLedgerEntry,LEDGER_UPGRADE_MARKER} from '../../src/data/subscription-ledger.js';
import {encryptArchive,decryptArchive,inspectBundle,assertOriginalsPreserved,restoreToMemory} from '../../scripts/upgrade/archive.mjs';
import {handleUpgradeGate,upgradeReady} from '../../src/data/upgrade-gate.js';
const password='strong-test-password-only-3320';
const own=(t,f)=>t.after(()=>f.close());
async function marker(f){return f.db?f.db.prepare('SELECT value FROM schema_meta WHERE key=?').get(LEDGER_UPGRADE_MARKER)?.value:f.values.get(LEDGER_UPGRADE_MARKER);}
async function originalAssert(before,f){const after=f.bundle(),a=await inspectBundle(before),b=await inspectBundle(after);assert.equal(assertOriginalsPreserved(before,after,a.image,b.image),true);}
for(const d1 of [false,true])test(`repair partial 3319 migration, preserve raw data, retry idempotent (${d1?'D1':'KV'})`,async t=>{
 const rows=[sample('a',{paymentHistory:[payment('p1'),payment('p2',{date:'2026-09-02T00:00:00.000Z'})]}),sample('b',{customType:'积分充值'}),sample('c')];
 const f=await fixture({d1,rows,mirrors:d1?[rows[2]]:null});own(t,f);
 if(f.db)f.db.prepare('INSERT INTO schema_meta(key,value) VALUES(?,?)').run('subscription_ledger_seed_3319','done');else f.values.set('subscription_ledger_seed_3319','done');
 const before=f.bundle();const r=await runLedgerUpgrade(f.env);assert.equal(r.expectedCount,4);assert.equal(r.added,4);assert.equal((await readRawLedgerEntries(f.env)).length,4);
 await originalAssert(before,f);const after=f.bundle();const again=await runLedgerUpgrade(f.env);assert.equal(again.added,0);await originalAssert(after,f);
});
test('full KV scan finds records omitted by index; D1-only record retained',async t=>{
 const f=await fixture({rows:[sample('a'),sample('b')],mirrors:[sample('c')]});own(t,f);f.values.set('sub_index','["a"]');f.control.pageSize=1;
 const i=await collectSubscriptionInventory(f.env);assert.deepEqual(i.subscriptions.map(x=>x.id),['a','b','c']);assert.deepEqual(i.orphanIds,['b']);assert.equal((await runLedgerUpgrade(f.env)).added,3);
});
test('latest D1 changes used without modifying original KV or losing encrypted field',async t=>{
 const old=sample('a',{passwordEncrypted:'ciphertext-opaque',paymentHistory:[payment()]});const recent={...old,notes:'LATEST',updatedAt:'2026-09-21T00:00:00.000Z'};
 const f=await fixture({rows:[old],mirrors:[recent]});own(t,f);const before=f.bundle();const info=await inspectBundle(before);
 assert.equal(info.inventory.current[0].notes,'LATEST');assert.equal(info.inventory.current[0].passwordEncrypted,'ciphertext-opaque');await runLedgerUpgrade(f.env);await originalAssert(before,f);
});
test('equal timestamp business conflict fails before writes',async t=>{
 const f=await fixture({rows:[sample()],mirrors:[sample('a',{notes:'DIFFERENT'})]});own(t,f);
 await assert.rejects(runLedgerUpgrade(f.env),/字段冲突/);assert.equal(f.writes.length,0);assert.equal(await marker(f),undefined);
});
test('same payment ID with conflicting amount fails before writes',async t=>{
 const f=await fixture({rows:[sample('a',{paymentHistory:[payment()]})],mirrors:[sample('a',{paymentHistory:[payment('p1',{amount:99})]})]});own(t,f);
 await assert.rejects(runLedgerUpgrade(f.env),/不同内容/);assert.equal(f.writes.length,0);
});
test('newer snapshot missing an older payment is not silently resurrected',async t=>{
 const f=await fixture({rows:[sample('a',{paymentHistory:[payment()]})],mirrors:[sample('a',{updatedAt:'2026-09-21T00:00:00.000Z'})]});own(t,f);
 await assert.rejects(runLedgerUpgrade(f.env),/缺少旧支付/);assert.equal(f.writes.length,0);
});
test('equal timestamp additive payments repair stale mirror',async t=>{
 const f=await fixture({rows:[sample('a',{paymentHistory:[payment()]})],mirrors:[sample()]});own(t,f);
 assert.equal((await runLedgerUpgrade(f.env)).added,1);assert.equal((await allLedgerEntries(f.env))[0].id,'legacy:a:p1');
});
test('corrupt JSON never becomes an empty record list',async t=>{
 const f=await fixture();own(t,f);f.values.set('sub:a','{"broken"');await assert.rejects(runLedgerUpgrade(f.env),/JSON/);assert.equal(f.writes.length,0);
});
test('enumeration error fails without writes or done marker',async t=>{
 const f=await fixture();own(t,f);f.control.failList=true;await assert.rejects(runLedgerUpgrade(f.env),/enumeration/);assert.equal(f.writes.length,0);assert.equal(await marker(f),undefined);
});
test('index-only missing entry fails instead of claiming complete',async t=>{
 const f=await fixture();own(t,f);f.values.set('sub_index','["a","missing"]');await assert.rejects(runLedgerUpgrade(f.env),/索引指向不存在/);
});
test('duplicate payment IDs rejected without writes',async t=>{
 const f=await fixture({rows:[sample('a',{paymentHistory:[payment(),payment()]})],mirrors:[]});own(t,f);await assert.rejects(runLedgerUpgrade(f.env),/重复/);assert.equal(f.writes.length,0);
});
test('old placeholder retained but excluded from spend after actual payments recovered',async t=>{
 const f=await fixture({rows:[sample('a',{paymentHistory:[payment(),payment('p2')]})]});own(t,f);
 const e=makeLedgerEntry(sample(),{id:'legacy:a:snapshot',source:'legacy_snapshot',occurredAt:sample().startDate});f.values.set('subscription_ledger:'+e.id,JSON.stringify(e));
 const before=f.bundle();await runLedgerUpgrade(f.env);assert.equal((await readRawLedgerEntries(f.env)).length,3);assert.equal((await allLedgerEntries(f.env)).length,2);await originalAssert(before,f);
});
for(const d1 of [false,true])test(`dropped ledger writes never report verified (${d1?'D1':'KV'})`,async t=>{
 const f=await fixture({d1});own(t,f);f.control.dropLedger=true;await assert.rejects(runLedgerUpgrade(f.env),/回读/);assert.equal(await marker(f),undefined);
 f.control.dropLedger=false;assert.equal((await runLedgerUpgrade(f.env)).verified,true);
});
test('failed marker write leaves retryable additive rows',async t=>{
 const f=await fixture();own(t,f);f.control.dropMarker=true;await assert.rejects(runLedgerUpgrade(f.env),/标记/);assert.equal((await readRawLedgerEntries(f.env)).length,1);assert.equal(await marker(f),undefined);
 f.control.dropMarker=false;assert.equal((await runLedgerUpgrade(f.env)).added,0);
});
test('source changes during additive migration prevents complete marker',async t=>{
 const f=await fixture({d1:false});own(t,f);f.control.onPut=async k=>{if(k.startsWith('subscription_ledger:'))f.values.set('sub:a',JSON.stringify(sample('a',{notes:'late change'})));};
 await assert.rejects(runLedgerUpgrade(f.env),/来源发生变化/);assert.equal(await marker(f),undefined);
});
test('wrong expected source digest stops before migration',async t=>{
 const f=await fixture();own(t,f);await assert.rejects(runLedgerUpgrade(f.env,{expectedSourceDigest:'0'.repeat(64)}),/备份不一致/);assert.equal(f.writes.length,0);
});
test('existing conflicting ledger row not overwritten',async t=>{
 const f=await fixture({rows:[sample('a',{paymentHistory:[payment()]})]});own(t,f);const e=makeLedgerEntry(sample('a',{amount:200}),{id:'legacy:a:p1',source:'legacy_payment',occurredAt:payment().date});f.values.set('subscription_ledger:'+e.id,JSON.stringify(e));
 await assert.rejects(runLedgerUpgrade(f.env),/现存历史/);assert.equal(f.writes.length,0);
});
test('deleted current not resurrected; original snapshot still protected',async t=>{
 const f=await fixture();own(t,f);f.db.prepare('INSERT INTO subscription_history(subscription_id,action,changed_at,snapshot_json) VALUES(?,?,?,?)').run('a','delete','2026-09-22T00:00:00.000Z',JSON.stringify(sample()));
 const i=await collectSubscriptionInventory(f.env);assert.equal(i.current.length,0);assert.equal(i.subscriptions.length,1);
});
test('encrypted full archive restores every SQL row, ciphertext, key, KV metadata and binary',async t=>{
 const f=await fixture();own(t,f);f.db.prepare('INSERT INTO accounts(account,account_serial,password_encrypted,created_at,updated_at) VALUES(?,?,?,?,?)').run('sample@example.invalid','公司01号','encrypted-v1-do-not-change','2026-01-01','2026-01-02');
 f.db.prepare('INSERT INTO account_credentials(account,credential_type,password_encrypted,created_at,updated_at) VALUES(?,?,?,?,?)').run('sample@example.invalid','tapnow','tapnow-ciphertext','2026-01-01','2026-01-02');
 const bundle=f.bundle();bundle.kv.push({name:'unrelated-binary',valueBase64:Buffer.from([0,255,128,2]).toString('base64'),metadata:{purpose:'keep'},expiration:4102444800});
 const encrypted=encryptArchive(bundle,password);assert.equal(encrypted.includes(Buffer.from('old-credential-secret')),false);const restored=decryptArchive(encrypted,password);assert.deepEqual(restored,bundle);
 const a=await inspectBundle(bundle),b=await inspectBundle(restored);assert.deepEqual(a.summary,b.summary);assert.equal(assertOriginalsPreserved(bundle,restored,a.image,b.image),true);
 assert.equal(b.image.account_credentials.rows[0].password_encrypted,'tapnow-ciphertext');
});
test('wrong backup password and file corruption rejected',async t=>{
 const f=await fixture();own(t,f);const encrypted=encryptArchive(f.bundle(),password);
 assert.throws(()=>decryptArchive(encrypted,'wrong-but-long-password'),/密码不正确/);const tamper=JSON.parse(encrypted);const raw=Buffer.from(tamper.data,'base64');raw[0]^=1;tamper.data=raw.toString('base64');assert.throws(()=>decryptArchive(Buffer.from(JSON.stringify(tamper)),password),/损坏/);
});
test('weak backup password refused',()=>assert.throws(()=>encryptArchive({},'short'),/16/));
test('missing original key refuses upgrade instead of generating a replacement',async t=>{
 const f=await fixture();own(t,f);f.values.set('config','{"JWT_SECRET":"old"}');await assert.rejects(inspectBundle(f.bundle()),/缺少/);assert.equal(f.writes.length,0);
});
test('row count equality cannot hide overwritten original values',async t=>{
 const f=await fixture();own(t,f);const before=f.bundle(),a=await inspectBundle(before);f.db.prepare("UPDATE subscriptions_current SET name='Changed' WHERE id='a'").run();const after=f.bundle(),b=await inspectBundle(after);
 assert.throws(()=>assertOriginalsPreserved(before,after,a.image,b.image),/原始记录/);
});
test('KV same count with altered template rejected',async t=>{
 const f=await fixture();own(t,f);const before=f.bundle(),a=await inspectBundle(before);f.values.set('table_templates','[]');const after=f.bundle(),b=await inspectBundle(after);assert.throws(()=>assertOriginalsPreserved(before,after,a.image,b.image),/KV:table_templates/);
});
test('SQL truncated file or foreign-key violation rejected in isolated restore',async t=>{
 const f=await fixture();own(t,f);const b=f.bundle();b.d1Sql='CREATE TABLE nope(';assert.throws(()=>restoreToMemory(b));b.d1Sql='CREATE TABLE p(id PRIMARY KEY);CREATE TABLE c(pid REFERENCES p(id));INSERT INTO c VALUES(99);';assert.throws(()=>restoreToMemory(b),/外键/);
});
async function setupGate(t,d1=true){const f=await fixture({d1});own(t,f);const token='upgrade-only-random-test-token',run={id:'test-'+crypto.randomUUID(),version:'3.3.20',tokenHash:await sha256(token)};const call=async(op,body,authed=true)=>handleUpgradeGate(new Request('https://test.invalid/api/upgrade/'+op,{method:body===undefined?'GET':'POST',headers:authed?{'X-Upgrade-Token':token}:{},...(body!==undefined?{body:JSON.stringify(body)}:{})}),f.env,run);return {f,run,call};}
for(const d1 of [false,true])test(`two-phase gate only unlocks after original/restore proof (${d1?'D1':'KV'})`,async t=>{
 const {f,run,call}=await setupGate(t,d1);const before=f.bundle(),i=await collectSubscriptionInventory(f.env);
 assert.equal(await upgradeReady(f.env,run),false);assert.equal((await handleUpgradeGate(new Request('https://test.invalid/api/subscriptions',{method:'POST',body:'{}'}),f.env,run)).status,503);assert.equal(f.writes.length,0);
 assert.equal((await call('apply',{},false)).status,403);assert.equal((await call('apply',{})).status,400);assert.equal((await call('commit',{})).status,409);
 const body={expectedSourceDigest:i.sourceDigest,backupReceipt:{runId:run.id,verified:true,archiveSha256:'a'.repeat(64)}};
 const applied=await (await call('apply',body)).json();assert.equal(applied.success,true);assert.equal(await upgradeReady(f.env,run),false);await originalAssert(before,f);
 const retry=await (await call('apply',body)).json();assert.deepEqual(retry,applied);assert.deepEqual(await (await call('report',{})).json(),applied);
 assert.equal((await call('commit',{reportDigest:'invalid',originalsVerified:true,restoreVerified:true})).status,409);
 const committed=await (await call('commit',{reportDigest:applied.reportDigest,originalsVerified:true,restoreVerified:true})).json();assert.equal(committed.ready,true);assert.equal(await upgradeReady(f.env,run),true);
 assert.equal(await handleUpgradeGate(new Request('https://test.invalid/api/subscriptions'),f.env,run),null);
 // Simulate another Worker isolate by using a different environment binding object over the same storage.
 const env={...f.env,SUBSCRIPTIONS_KV:{...f.env.SUBSCRIPTIONS_KV},...(d1?{SUBSCRIPTIONS_DB:{...f.env.SUBSCRIPTIONS_DB}}:{})};assert.equal(await upgradeReady(env,run),true);
});
test('commit rejects data changed since applied report',async t=>{
 const {f,run,call}=await setupGate(t);const i=await collectSubscriptionInventory(f.env);const applied=await (await call('apply',{expectedSourceDigest:i.sourceDigest,backupReceipt:{runId:run.id,verified:true,archiveSha256:'a'.repeat(64)}})).json();
 f.values.set('sub:a',JSON.stringify(sample('a',{notes:'EXTERNAL WRITE',updatedAt:'2026-09-22T00:00:00.000Z'})));
 assert.equal((await call('commit',{reportDigest:applied.reportDigest,originalsVerified:true,restoreVerified:true})).status,409);assert.equal(await upgradeReady(f.env,run),false);
});
test('manual raw deployment cannot silently migrate or expose application',async t=>{
 const f=await fixture();own(t,f);const run={id:'manual-3.3.20',version:'3.3.20',tokenHash:''};const response=await handleUpgradeGate(new Request('https://test.invalid/'),f.env,run);assert.equal(response.status,503);assert.equal(f.writes.length,0);assert.match(await response.text(),/升级保护/);
});
test('180 receipts migrate in bounded requests under strict 50-query cold-isolate budget',async t=>{
 const rows=Array.from({length:90},(_,i)=>sample('quota-'+i,{paymentHistory:[payment('p1'),payment('p2')]}));
 const f=await fixture({rows,mirrors:[rows[0]]});own(t,f);const token='quota-token',run={id:'quota-upgrade',version:'3.3.20',tokenHash:await sha256(token)};
 const inventory=await collectSubscriptionInventory(f.env),before=f.bundle();let count=0,previous=Infinity,last,maxObserved=0;
 f.control.maxQueries=50;
 for(let i=0;i<30;i++){
  f.control.queries=0;f.control.kvOperations=0;
  const cold={...f.env,SUBSCRIPTIONS_DB:{...f.env.SUBSCRIPTIONS_DB},SUBSCRIPTIONS_KV:{...f.env.SUBSCRIPTIONS_KV}};
  const r=await handleUpgradeGate(new Request('https://test.invalid/api/upgrade/apply',{method:'POST',headers:{'X-Upgrade-Token':token},body:JSON.stringify({expectedSourceDigest:inventory.sourceDigest,backupReceipt:{runId:run.id,verified:true,archiveSha256:'f'.repeat(64),ledgerCount:0}})}),cold,run);
  assert.equal(r.status,200);maxObserved=Math.max(maxObserved,f.control.queries);assert.ok(f.control.kvOperations<1000);last=await r.json();count++;
  if(!last.pending)break;assert.ok(last.progress.remaining<previous);previous=last.progress.remaining;
 }
 assert.equal(last.pending,undefined);assert.equal(last.report.added,180);assert.equal(last.report.ledgerCount,180);assert.equal(count,23);assert.ok(maxObserved<=50);
 f.control.maxQueries=Infinity;await originalAssert(before,f);assert.equal((await readRawLedgerEntries(f.env)).length,180);
});
test('bulk KV inventory reads >1000 subscriptions without >1000 storage operations',async t=>{
 const rows=Array.from({length:1100},(_,i)=>sample('bulk-'+i));const f=await fixture({d1:false,rows});own(t,f);f.control.kvOperations=0;
 const inventory=await collectSubscriptionInventory(f.env);assert.equal(inventory.subscriptions.length,1100);assert.ok(f.control.kvOperations<25,f.control.kvOperations);
});
test('missing key in a bulk Map is an error, never a skipped row',async t=>{
 const f=await fixture();own(t,f);const original=f.env.SUBSCRIPTIONS_KV.get;f.env.SUBSCRIPTIONS_KV.get=async function(keys,opt){if(Array.isArray(keys))return new Map();return original.call(this,keys,opt);};await assert.rejects(runLedgerUpgrade(f.env),/缺少响应项/);
});
