/** Immutable business history, separate from current subscriptions and audit logs.
 * D1: current mirror + new receipts committed in one batch transaction.
 * KV-only: individual receipt keys (never an ever-growing single array). The same
 * operation key can be retried after a network interruption without appending twice.
 */
import { ensureD1Schema, hasD1Binding } from './d1-schema.js';
import { buildUpsertStatement, listCurrentSubscriptionSnapshots } from './subscription-history.repo.js';
import * as subRepo from './subscriptions.repo.js';
import {collectSubscriptionInventory,stableJSON,sha256,UpgradeConflict,hasTable,readKVTexts} from './upgrade-reconcile.js';
const PREFIX='subscription_ledger:';
const SEED_KEY='subscription_ledger_seed_3320';
export const LEDGER_UPGRADE_MARKER=SEED_KEY;
const seedPromises=new WeakMap();
export function isMembership(s) {
  // Empty type in old data meant an ordinary subscription. New writes are explicit.
  return !String(s?.customType || '').trim() || String(s.customType).trim()==='开会员';
}
export function memberKey(s) {
  return JSON.stringify([String(s?.name||'').normalize('NFKC').trim().toLowerCase(),String(s?.account||'').normalize('NFKC').trim().toLowerCase()]);
}
function canonical(x){if(Array.isArray(x))return x.map(canonical);if(x&&typeof x==='object')return Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])]));return x;}
export async function hashInput(x) {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(canonical(x))));
  return [...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');
}
export function safeLedgerSnapshot(sub) {
  const {password,passwordEncrypted,credentialsEncrypted,passwords,legacyPassword,legacyPasswordEncrypted,paymentHistory,...safe}=sub||{};
  return JSON.parse(JSON.stringify(safe));
}
export function makeLedgerEntry(sub,{id=crypto.randomUUID(),source='create',occurredAt,inputHash=''}={}) {
  const now=new Date().toISOString();
  return {id:String(id),subscriptionId:String(sub.id||''),source,occurredAt:occurredAt||sub.startDate||now,createdAt:now,snapshot:safeLedgerSnapshot(sub),inputHash};
}
function mapRow(r){return {id:r.entry_id,subscriptionId:r.subscription_id,source:r.source,occurredAt:r.occurred_at,createdAt:r.created_at,snapshot:JSON.parse(r.snapshot_json),inputHash:r.input_hash||''};}
export async function getLedgerEntry(env,id) {
  if(hasD1Binding(env)) {
    await ensureD1Schema(env);
    const r=await env.SUBSCRIPTIONS_DB.prepare('SELECT * FROM subscription_ledger WHERE entry_id=?').bind(String(id)).first();
    return r?mapRow(r):null;
  }
  const raw=await env.SUBSCRIPTIONS_KV.get(PREFIX+id);
  return raw?JSON.parse(raw):null;
}
function insertStatement(db,e){return db.prepare('INSERT INTO subscription_ledger (entry_id,subscription_id,source,occurred_at,created_at,snapshot_json,input_hash) VALUES (?,?,?,?,?,?,?)').bind(e.id,e.subscriptionId,e.source,e.occurredAt,e.createdAt,JSON.stringify(e.snapshot),e.inputHash||'');}

/** Records cannot be overwritten. A reused key with different input is rejected. */
export async function commitLedgerAndCurrent(env,entries,current=null) {
  const pending=[];
  for(const e of entries){
    const old=await getLedgerEntry(env,e.id);
    if(old){if(old.inputHash!==e.inputHash)throw new Error('操作编号已使用且内容不同，请重新打开表单后提交');}
    else pending.push(e);
  }
  if(hasD1Binding(env)) {
    await ensureD1Schema(env);
    if(pending.length){
      const statements=pending.map(e=>insertStatement(env.SUBSCRIPTIONS_DB,e));
      if(current)statements.push(buildUpsertStatement(env.SUBSCRIPTIONS_DB,current));
      try { await env.SUBSCRIPTIONS_DB.batch(statements); }
      catch(error){
        // A concurrent retry may have committed exactly this operation. Verify it,
        // rather than treating every constraint or storage error as success.
        for(const e of entries){const stored=await getLedgerEntry(env,e.id);if(!stored||stored.inputHash!==e.inputHash)throw error;}
      }
      for(const e of entries){const stored=await getLedgerEntry(env,e.id);if(!stored||stored.inputHash!==e.inputHash)throw new Error('订阅历史写入未通过回读验证');}
    }
    // Never replay an old receipt over a newer current subscription.
    if(current && pending.length){
      try{await subRepo.save(env,current);}catch(e){console.error('[ledger] D1已提交，KV镜像延迟:',e);}
    }
  } else {
    // KV-only deployments remain supported; D1 is recommended for concurrent writers.
    for(const e of pending)await env.SUBSCRIPTIONS_KV.put(PREFIX+e.id,JSON.stringify(e));
    if(current && pending.length)await subRepo.save(env,current);
  }
  return {created:pending.length,replayed:pending.length===0};
}
/** Raw union: KV receipts remain visible after adding D1. Invalid data is never skipped. */
export async function readRawLedgerEntries(env) {
  const byId=new Map();
  const add=e=>{
    if(!e||!e.id||!e.subscriptionId||!e.snapshot)throw new UpgradeConflict('发现损坏的订阅历史，已停止');
    const old=byId.get(e.id);
    if(old && stableJSON(old)!==stableJSON(e))throw new UpgradeConflict('KV/D1 存在不同内容的历史编号：'+e.id);
    byId.set(e.id,e);
  };
  let cursor;const cursors=new Set();
  do {
    const result=await env.SUBSCRIPTIONS_KV.list({prefix:PREFIX,limit:500,...(cursor?{cursor}:{})});
    if(!Array.isArray(result?.keys))throw new UpgradeConflict('历史 KV 枚举失败');
    const bulk=await readKVTexts(env.SUBSCRIPTIONS_KV,result.keys.map(k=>k.name));
    for(const key of result.keys){const raw=bulk.get(key.name);if(raw==null)throw new UpgradeConflict('历史读取期间发生变化：'+key.name);const e=JSON.parse(raw);if(key.name!==PREFIX+e.id)throw new UpgradeConflict('历史 ID 与 KV key 不符');add(e);}
    if(result.list_complete)break;
    if(!result.cursor||cursors.has(result.cursor))throw new UpgradeConflict('历史 KV 分页不完整');
    cursors.add(result.cursor);cursor=result.cursor;
  }while(true);
  if(await hasTable(env,'subscription_ledger')){
    const rows=await env.SUBSCRIPTIONS_DB.prepare('SELECT * FROM subscription_ledger ORDER BY entry_id').all();
    if(rows.success===false||!Array.isArray(rows.results))throw new UpgradeConflict('D1 历史读取失败');
    for(const row of rows.results)add(mapRow(row));
  }
  return [...byId.values()].sort((a,b)=>a.id.localeCompare(b.id));
}
/** A legacy_snapshot is a placeholder, not an extra charge once actual legacy payments exist.
 * Keep the original row forever and in backups; exclude only from the financial view. */
export async function allLedgerEntries(env,{includeSuperseded=false}={}) {
  const rows=await readRawLedgerEntries(env);
  const actualPayments=new Set(rows.filter(e=>e.source==='legacy_payment').map(e=>e.subscriptionId));
  return rows.filter(e=>includeSuperseded||e.source!=='legacy_snapshot'||!actualPayments.has(e.subscriptionId))
    .sort((a,b)=>b.occurredAt.localeCompare(a.occurredAt)||b.id.localeCompare(a.id));
}
function sameLegacyReceipt(old,expected){
  return old.subscriptionId===expected.subscriptionId && old.source===expected.source &&
    (old.source==='legacy_snapshot' || (old.occurredAt===expected.occurredAt &&
      stableJSON([old.snapshot.amount,old.snapshot.currency])===stableJSON([expected.snapshot.amount,expected.snapshot.currency])));
}
/** Read-only preflight. Existing receipts are never overwritten even after a failed 3.3.19 seed. */
export async function planLedgerUpgrade(env,inventory=null){
  const source=inventory||await collectSubscriptionInventory(env);
  const existing=await readRawLedgerEntries(env), byId=new Map(existing.map(e=>[e.id,e]));
  const expected=await buildLegacyLedgerEntries(source.subscriptions), seen=new Set(), additions=[];
  for(const e of expected){
    if(seen.has(e.id))throw new UpgradeConflict('重复的旧支付编号：'+e.id);seen.add(e.id);
    if(!Number.isFinite(Date.parse(e.occurredAt)))throw new UpgradeConflict('历史日期无效：'+e.id);
    const old=byId.get(e.id);
    if(old&&!sameLegacyReceipt(old,e))throw new UpgradeConflict('现存历史与旧支付来源冲突，保留两边原始资料并停止：'+e.id);
    if(!old)additions.push(e);
  }
  const finalRows=[...existing,...additions];
  const payments=new Set(finalRows.filter(e=>e.source==='legacy_payment').map(e=>e.subscriptionId));
  return {source,existing,additions,expectedIds:expected.map(e=>e.id).sort(),
    supersededSnapshotIds:finalRows.filter(e=>e.source==='legacy_snapshot'&&payments.has(e.subscriptionId)).map(e=>e.id).sort(),
    existingDigest:await sha256(existing),expectedCount:expected.length};
}
/** Additive, retryable migration. A new verified marker repairs old erroneous 3319 done flags. */
export async function runLedgerUpgrade(env,{expectedSourceDigest=null,maxWrites=Infinity}={}){
  const plan=await planLedgerUpgrade(env);
  if(expectedSourceDigest && plan.source.sourceDigest!==expectedSourceDigest)throw new UpgradeConflict('当前来源与维护期备份不一致，已停止；请重新制作备份');
  let candidates=plan.additions;
  if(hasD1Binding(env)){
    await ensureD1Schema(env);
    const ids=new Set((await env.SUBSCRIPTIONS_DB.prepare('SELECT entry_id FROM subscription_ledger').all()).results.map(r=>r.entry_id));
    candidates=[...plan.existing,...plan.additions].filter(e=>!ids.has(e.id));
  }
  const writes=candidates.slice(0,maxWrites);
  if(hasD1Binding(env)){
    for(let i=0;i<writes.length;i+=8)await env.SUBSCRIPTIONS_DB.batch(writes.slice(i,i+8).map(e=>env.SUBSCRIPTIONS_DB.prepare('INSERT OR IGNORE INTO subscription_ledger(entry_id,subscription_id,source,occurred_at,created_at,snapshot_json,input_hash) VALUES(?,?,?,?,?,?,?)').bind(e.id,e.subscriptionId,e.source,e.occurredAt,e.createdAt,JSON.stringify(e.snapshot),e.inputHash||'')));
  }else for(const e of writes)await env.SUBSCRIPTIONS_KV.put(PREFIX+e.id,JSON.stringify(e));
  const saved=await readRawLedgerEntries(env),byId=new Map(saved.map(e=>[e.id,e]));
  for(const e of [...plan.existing,...writes])if(stableJSON(byId.get(e.id))!==stableJSON(e))throw new UpgradeConflict('历史回读不一致，未标记完成：'+e.id);
  const after=await collectSubscriptionInventory(env);
  if(after.sourceDigest!==plan.source.sourceDigest)throw new UpgradeConflict('迁移期间来源发生变化，未标记完成；只新增的历史保留，下次可重试');
  if(candidates.length>writes.length)return {version:'3.3.20',pending:true,sourceDigest:after.sourceDigest,written:writes.length,remaining:candidates.length-writes.length,expectedCount:plan.expectedCount,ledgerCount:saved.length};
  if(plan.expectedIds.some(id=>!byId.has(id)))throw new UpgradeConflict('历史迁移仍有缺项，未标记完成');
  const report={version:'3.3.20',verified:true,sourceDigest:after.sourceDigest,counts:after.counts,
    expectedCount:plan.expectedCount,retained:plan.existing.length,added:plan.additions.length,
    ledgerCount:saved.length,ledgerDigest:await sha256(saved),supersededSnapshotIds:plan.supersededSnapshotIds,
    orphanIds:after.orphanIds,completedAt:new Date().toISOString()};
  const value=JSON.stringify(report);
  if(hasD1Binding(env)){
    const previous=await env.SUBSCRIPTIONS_DB.prepare('SELECT value FROM schema_meta WHERE key=?').bind(SEED_KEY).first();
    if(previous?.value){if(JSON.parse(previous.value)?.verified!==true)throw new UpgradeConflict('已有迁移标记无效，保留原值并停止');return report;}
    await env.SUBSCRIPTIONS_DB.prepare('INSERT INTO schema_meta(key,value,updated_at) VALUES(?,?,?)').bind(SEED_KEY,value,report.completedAt).run();
    const actual=await env.SUBSCRIPTIONS_DB.prepare('SELECT value FROM schema_meta WHERE key=?').bind(SEED_KEY).first();
    if(actual?.value!==value)throw new UpgradeConflict('迁移完成标记未通过回读校验');
  }else{
    const previous=await env.SUBSCRIPTIONS_KV.get(SEED_KEY);
    if(previous){if(JSON.parse(previous)?.verified!==true)throw new UpgradeConflict('已有迁移标记无效，保留原值并停止');return report;}
    await env.SUBSCRIPTIONS_KV.put(SEED_KEY,value);
    if(await env.SUBSCRIPTIONS_KV.get(SEED_KEY)!==value)throw new UpgradeConflict('迁移标记暂未可读，保持未完成并稍后重试');
  }
  return report;
}
export async function ensureLedgerSeed(env) {
  const binding=env.SUBSCRIPTIONS_DB||env.SUBSCRIPTIONS_KV;
  if(seedPromises.has(binding))return seedPromises.get(binding);
  const work=(async()=>{
    let marker;
    if(await hasTable(env,'schema_meta'))marker=(await env.SUBSCRIPTIONS_DB.prepare('SELECT value FROM schema_meta WHERE key=?').bind(SEED_KEY).first())?.value;
    else if(!hasD1Binding(env))marker=await env.SUBSCRIPTIONS_KV.get(SEED_KEY);
    if(marker){const report=JSON.parse(marker);if(report.verified===true)return report;}
    return runLedgerUpgrade(env);
  })().catch(e=>{seedPromises.delete(binding);throw e;});
  seedPromises.set(binding,work);return work;
}

export async function restoreLedgerEntries(env,entries) {
  if(!Array.isArray(entries))return 0;
  let n=0;
  for(const e of entries){
    if(!e||!e.id||!e.subscriptionId||!e.snapshot||!Number.isFinite(Date.parse(e.occurredAt||'')))throw new Error('订阅历史备份格式无效');
    const safe={...e,snapshot:safeLedgerSnapshot(e.snapshot),inputHash:e.inputHash||'',source:e.source||'restore',createdAt:e.createdAt||new Date().toISOString()};
    const old=await getLedgerEntry(env,e.id);
    if(old){if(JSON.stringify(canonical(old.snapshot))!==JSON.stringify(canonical(safe.snapshot)))throw new Error('备份历史与现存同编号记录冲突：'+e.id);continue;}
    await commitLedgerAndCurrent(env,[safe]);n++;
  }return n;
}

export async function buildLegacyLedgerEntries(subs) {
  const seedEntries=[];
    for(const sub of subs){
      if(sub.workflowVersion>=3319)continue;
      const payments=Array.isArray(sub.paymentHistory)?sub.paymentHistory:[];
      const rows=payments.length?payments:[null];
      for(let i=0;i<rows.length;i++){
        const p=rows[i];
        const snap={...sub,...(p?{amount:p.amount,currency:p.currency||sub.currency,startDate:p.periodStart||p.date||sub.startDate,expiryDate:p.periodEnd||sub.expiryDate}:{}),legacySource:true};
        const id='legacy:'+sub.id+':'+(p?String(p.id||i):'snapshot');
        seedEntries.push(makeLedgerEntry(snap,{id,source:p?'legacy_payment':'legacy_snapshot',occurredAt:p?.date||sub.startDate||sub.createdAt,inputHash:await hashInput({id})}));
      }
    }
  return seedEntries;
}

/** Validate all entries before a restore writes any current subscriptions. */
export async function validateLedgerRestore(env,entries) {
  if(!Array.isArray(entries))throw new Error('subscriptionLedger 必须是数组');
  const existing=new Map((await allLedgerEntries(env,{includeSuperseded:true})).map(e=>[e.id,e]));
  const seen=new Map();
  for(const e of entries){
    if(!e||typeof e.id!=='string'||!e.id||typeof e.subscriptionId!=='string'||!e.subscriptionId||!e.snapshot||typeof e.snapshot!=='object'||Array.isArray(e.snapshot)||!Number.isFinite(Date.parse(e.occurredAt||'')))throw new Error('订阅历史备份格式无效');
    if((e.source!=null && typeof e.source!=='string')||(e.inputHash!=null && typeof e.inputHash!=='string')||(e.createdAt!=null && !Number.isFinite(Date.parse(e.createdAt))))throw new Error('订阅历史备份元数据无效');
    const snapshot=JSON.stringify(canonical(safeLedgerSnapshot(e.snapshot)));
    const old=existing.get(e.id);
    if(old&&JSON.stringify(canonical(old.snapshot))!==snapshot)throw new Error('备份历史与现存同编号记录冲突：'+e.id);
    if(seen.has(e.id)&&seen.get(e.id)!==snapshot)throw new Error('备份内部存在冲突的历史编号：'+e.id);
    seen.set(e.id,snapshot);
  }
}
