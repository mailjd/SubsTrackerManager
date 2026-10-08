/** v3.3.20: read-only inventory shared by migration, backups and upgrade verification.
 * No source is silently discarded and no parsing/query failure is treated as an empty database.
 * Equal-version business conflicts stop the upgrade; originals are preserved in the raw backup.
 */
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export const stableJSON = value => JSON.stringify(canonical(value));
export async function sha256(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new TextEncoder().encode(stableJSON(value));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
export class UpgradeConflict extends Error {
  constructor(message, details = []) { super(message); this.name = 'UpgradeConflict'; this.code = 'UPGRADE_CONFLICT'; this.details = details; }
}
function parse(raw, label) {
  try { return JSON.parse(raw); } catch { throw new UpgradeConflict(`${label} 不是有效 JSON，已停止；没有按空数据继续迁移`); }
}
const privateKeys = new Set(['password', 'passwordEncrypted', 'credentialsEncrypted', 'legacyPasswordEncrypted', 'passwords', 'legacyPassword']);
const derivedKeys = new Set(['hasPassword', 'reminderRulesSummary']);
export function comparableSnapshot(sub) {
  return Object.fromEntries(Object.entries(sub).filter(([key]) => !privateKeys.has(key) && !derivedKeys.has(key) && key !== 'paymentHistory'));
}
function revision(s) {
  const raw = s.updatedAt || s.createdAt;
  const stamp = Date.parse(raw || '');
  return Number.isFinite(stamp) ? stamp : 0;
}
export async function hasTable(env, name) {
  if (!env.SUBSCRIPTIONS_DB) return false;
  return !!await env.SUBSCRIPTIONS_DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first();
}
/** Bulk get is one KV operation per up-to-100 keys. Legacy/local adapters may lack the overload. */
export async function readKVTexts(kv,names){
  const values=new Map();
  for(let i=0;i<names.length;i+=100){
    const keys=names.slice(i,i+100);let batch;
    try{batch=await kv.get(keys,{type:'text',cacheTtl:30});}
    catch(error){if(!/key.*string|string.*key|invalid.*argument/i.test(String(error?.message||error)))throw error;}
    if(batch instanceof Map){for(const key of keys){if(!batch.has(key))throw new UpgradeConflict('KV 批量读取缺少响应项：'+key);values.set(key,batch.get(key));}}
    else {for(const key of keys)values.set(key,await kv.get(key));}
  }
  return values;
}
async function scanKeys(kv, prefix) {
  const keys = new Set(), cursors = new Set(); let cursor;
  do {
    const page = await kv.list({prefix, limit: 500, ...(cursor ? {cursor} : {})});
    if (!page || !Array.isArray(page.keys)) throw new UpgradeConflict('KV 枚举失败：' + prefix);
    for (const key of page.keys) keys.add(key.name);
    if (page.list_complete) break;
    if (!page.cursor || cursors.has(page.cursor)) throw new UpgradeConflict('KV 分页不完整，拒绝将部分列表视为完整');
    cursors.add(page.cursor); cursor = page.cursor;
  } while (true);
  return [...keys].sort();
}
function validateSub(sub, origin) {
  if (!sub || typeof sub !== 'object' || Array.isArray(sub) || typeof sub.id !== 'string' || !sub.id) throw new UpgradeConflict(`订阅 ${origin} 缺少有效 ID`);
  if (sub.paymentHistory != null && !Array.isArray(sub.paymentHistory)) throw new UpgradeConflict(`订阅 ${sub.id} 的 paymentHistory 不是数组`);
  for (const p of sub.paymentHistory || []) if (!p || typeof p !== 'object' || Array.isArray(p)) throw new UpgradeConflict(`订阅 ${sub.id} 含无效支付明细`);
}
/** Keep the latest record; merge only demonstrably additive payment history.
 * A missing payment in the newer revision may mean a deliberate deletion, not a stale mirror.
 * In that ambiguous case fail closed instead of silently resurrecting money/history.
 */
export function reconcileVersions(versions, id) {
  const sorted = [...versions].sort((a,b) => revision(a.value) - revision(b.value) || a.source.localeCompare(b.source));
  let chosen = {...sorted[0].value}; let source = sorted[0].source;
  const notices = [];
  for (const item of sorted.slice(1)) {
    const incoming = item.value, oldTs = revision(chosen), newTs = revision(incoming);
    const old = comparableSnapshot(chosen), next = comparableSnapshot(incoming);
    const overlapping = Object.keys(old).filter(k => k in next && stableJSON(old[k]) !== stableJSON(next[k]));
    if (overlapping.length && (!oldTs || !newTs || oldTs === newTs)) {
      throw new UpgradeConflict(`订阅 ${id} 同版本或无时间戳的字段冲突，需核对原始副本`, [{id, fields: overlapping, sources: [source,item.source]}]);
    }
    const oldPayments = chosen.paymentHistory || [], newPayments = incoming.paymentHistory || [];
    // Position-based legacy IDs must remain stable. For id-less rows compare by position.
    const paymentKey = (p,i) => p.id != null && String(p.id) ? 'id:' + String(p.id) : 'position:' + i;
    const oldMap = new Map(), newMap = new Map();
    const fill = (map, rows) => rows.forEach((p,i) => {const k=paymentKey(p,i);if(map.has(k))throw new UpgradeConflict(`订阅 ${id} 存在重复支付 ID`);map.set(k,p);});
    fill(oldMap,oldPayments);fill(newMap,newPayments);
    for (const [key,p] of oldMap) {
      if (newMap.has(key) && stableJSON(newMap.get(key)) !== stableJSON(p)) {
        throw new UpgradeConflict(`订阅 ${id} 的支付 ${key} 有不同内容，不能推测哪一份财务记录正确`, [{id,payment:key}]);
      }
    }
    const missingInNew = [...oldMap.keys()].filter(k => !newMap.has(k));
    if (missingInNew.length && newTs > oldTs) throw new UpgradeConflict(`订阅 ${id} 的较新版本缺少旧支付明细，已停止防止误恢复已删除的支付`, [{id,payments:missingInNew}]);
    // Equal stamps and otherwise identical values permit a strict additive union.
    const payments = [...newPayments, ...oldPayments.filter((p,i) => !newMap.has(paymentKey(p,i)))];
    const merged = {...chosen,...incoming};
    for (const key of privateKeys) if (!(key in incoming) && key in chosen) merged[key] = chosen[key];
    if ('paymentHistory' in incoming || 'paymentHistory' in chosen) merged.paymentHistory = payments;
    if (stableJSON(chosen) !== stableJSON(merged)) notices.push({id,latestSource:item.source,fromSource:source});
    chosen = merged; source = item.source;
  }
  return {value:chosen,source,notices};
}
/** includeDeleted is for raw/restore-capable backups, never for the current membership page. */
export async function collectSubscriptionInventory(env) {
  const rawIndex = await env.SUBSCRIPTIONS_KV.get('sub_index');
  const ids = rawIndex == null ? [] : parse(rawIndex,'sub_index');
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id)) throw new UpgradeConflict('sub_index 不是有效 ID 数组');
  const listed = await scanKeys(env.SUBSCRIPTIONS_KV,'sub:');
  const names = [...new Set([...listed,...ids.map(id=>'sub:'+id)])].sort();
  const versions = new Map(), rawSources = [], kvIds = new Set();
  const add = (value, source) => {validateSub(value,source);const id=value.id;if(!versions.has(id))versions.set(id,[]);versions.get(id).push({value,source});rawSources.push({source,value});};
  const bulkValues=await readKVTexts(env.SUBSCRIPTIONS_KV,names);
  for (const key of names) {
    const raw = bulkValues.get(key);
    if (raw == null) {
      // An index-only entry may be recoverable from D1; checked after both sources are read.
      if (listed.includes(key)) throw new UpgradeConflict('KV 列举后记录消失：'+key+'；数据仍在变化，请稍后重试');
      continue;
    }
    const value = parse(raw,key);
    if (value?.id !== key.slice(4)) throw new UpgradeConflict('KV key 与订阅 ID 不一致：'+key);
    add(value,'kv');kvIds.add(value.id);
  }
  const legacy = await env.SUBSCRIPTIONS_KV.get('subscriptions');
  if (legacy != null) {
    const rows = parse(legacy,'subscriptions');
    if (!Array.isArray(rows)) throw new UpgradeConflict('旧 subscriptions 不是数组');
    rows.forEach(value=>add(value,'legacy-kv'));
  }
  if (await hasTable(env,'subscriptions_current')) {
    const result = await env.SUBSCRIPTIONS_DB.prepare('SELECT id,data_json,updated_at FROM subscriptions_current ORDER BY id').all();
    if (!result || result.success === false || !Array.isArray(result.results)) throw new UpgradeConflict('D1 当前记录读取不完整');
    for (const row of result.results) {
      const value = parse(row.data_json,'D1:'+row.id);
      if (value?.id !== String(row.id)) throw new UpgradeConflict('D1 ID 与快照 ID 不一致：'+row.id);
      // Do not manufacture a fresh timestamp. SQL fallback is only an existing recorded stamp.
      if (!value.updatedAt && row.updated_at) value.updatedAt=String(row.updated_at);
      add(value,'d1');
    }
  }
  const deleted = new Map();
  if (await hasTable(env,'subscription_history')) {
    const result=await env.SUBSCRIPTIONS_DB.prepare(`SELECT subscription_id,action,changed_at,history_id FROM subscription_history ORDER BY history_id`).all();
    if(result.success===false || !Array.isArray(result.results))throw new UpgradeConflict('删除审计读取不完整');
    for(const row of result.results){if(row.action==='delete')deleted.set(String(row.subscription_id),Date.parse(row.changed_at)||0);else if(deleted.has(String(row.subscription_id)) && row.action!=='initial_import')deleted.delete(String(row.subscription_id));}
  }
  for (const id of ids) if (!versions.has(id) && !deleted.has(id)) throw new UpgradeConflict(`索引指向不存在的订阅 ${id}，KV/D1 均缺失，不能标记无损升级完成`);
  const subscriptions=[], current=[], choices=[], warnings=[];
  for (const id of [...versions.keys()].sort()) {
    const result = reconcileVersions(versions.get(id),id); subscriptions.push(result.value);choices.push({id,source:result.source});warnings.push(...result.notices);
    if (!deleted.has(id) || revision(result.value)>deleted.get(id)) current.push(result.value);
  }
  const sourceDigest=await sha256({records:rawSources.sort((a,b)=>a.value.id.localeCompare(b.value.id)||a.source.localeCompare(b.source)),deletions:[...deleted].sort((a,b)=>a[0].localeCompare(b[0]))});
  return {subscriptions,current,sourceDigest,choices,warnings,counts:{kv:kvIds.size,d1:rawSources.filter(x=>x.source==='d1').length,total:subscriptions.length,payments:subscriptions.reduce((n,s)=>n+(s.paymentHistory||[]).length,0)},orphanIds:[...kvIds].filter(id=>!ids.includes(id)),deletedIds:[...deleted.keys()].sort()};
}
