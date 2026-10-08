import {hasD1,listCurrentSubscriptionSnapshots} from './subscription-history.repo.js';
/** User-entered business operations. Table edits deliberately do not use this path. */
import { createSubscription, getAllSubscriptions } from './subscriptions.js';
import { normalizeRule, defaultPresetRules, deriveLegacyFromRules, formatRulesSummary, replaceForSubscription } from './reminders.repo.js';
import { getMenuOptions, addMenuOption } from './menu-options.js';
import { addCategory } from './categories.js';
import { ensureLedgerSeed, isMembership, memberKey, hashInput, getLedgerEntry, makeLedgerEntry, commitLedgerAndCurrent } from './subscription-ledger.js';

export async function acceptSubscriptionRecord(raw,env,{operationId,source='create'}={}) {
  try {
    await ensureLedgerSeed(env);
    const input={...raw};delete input.__sourceRow;delete input.__operationId;delete input.importAccountToDatabase;
    const id=String(operationId||crypto.randomUUID());
    if(id.length>160||!id.trim())throw new Error('操作编号无效');
    const hashable={...input};
    if(Array.isArray(hashable.reminderRules))hashable.reminderRules=hashable.reminderRules.map(({id,createdAt,updatedAt,...rule})=>rule);
    const inputHash=await hashInput(hashable);
    const replay=await getLedgerEntry(env,id);
    if(replay){
      if(replay.inputHash!==inputHash)throw new Error('同一操作编号的内容已变化；请重新解析后提交');
      // Repair the KV-only mirror after an interrupted operation, but never replace
      // a newer current revision. D1 operations are already atomic.
      const historyOnly=!isMembership(replay.snapshot);
      if(!historyOnly && !env.SUBSCRIPTIONS_DB){
        const repo=await import('./subscriptions.repo.js');const old=await repo.getById(env,replay.subscriptionId);
        if(!old||Date.parse(old.updatedAt||0)<Date.parse(replay.snapshot.updatedAt||0))await repo.save(env,replay.snapshot);
      }
      const metadataWarnings = await syncAcceptedCategory(env, replay.snapshot);
      return {success:true,replayed:true,historyOnly,historyId:id,subscription:replay.snapshot,metadataWarnings,message:'本次操作已保存，未重复写入历史'};
    }
    // Blank input remains backwards compatible with the original ordinary-membership form.
    input.customType=String(input.customType||'开会员').trim();
    const prepared=await createSubscription(input,env,{prepareOnly:true,preserveEnteredDates:true});
    if(!prepared.success)return prepared;
    let sub=prepared.subscription;
    const rules=Array.isArray(input.reminderRules)?input.reminderRules.map(normalizeRule):defaultPresetRules();
    const legacy=deriveLegacyFromRules(rules);
    sub={...sub,workflowVersion:3319,reminderRules:rules,reminderRulesSummary:formatRulesSummary(rules),reminderUnit:legacy.unit,reminderValue:legacy.value,reminderDays:legacy.unit==='day'?legacy.value:undefined,reminderHours:legacy.unit==='hour'?legacy.value:undefined};
    const historyOnly=!isMembership(sub);
    let existing=null;
    if(!historyOnly){
      const candidates=hasD1(env)?await listCurrentSubscriptionSnapshots(env):await getAllSubscriptions(env);
      const matches=candidates.filter(isMembership).filter(s=>memberKey(s)===memberKey(sub)).sort((a,b)=>Date.parse(b.updatedAt||b.createdAt||0)-Date.parse(a.updatedAt||a.createdAt||0));
      existing=matches[0]||null;
      const stableId=existing?.id||'membership-'+(await hashInput(memberKey(sub))).slice(0,32);
      sub={...existing,...sub,id:stableId,createdAt:existing?.createdAt||sub.createdAt,paymentHistory:[...(existing?.paymentHistory||[]),...(sub.paymentHistory||[])]};
      // Only the current compatibility list is bounded. The separate ledger is never trimmed.
      if(sub.paymentHistory.length>1000)sub.paymentHistory=sub.paymentHistory.slice(-1000);
    }
    // The historical receipt keeps the input member level, not a derived Free label.
    const receipt={...sub,memberLevel:typeof input.memberLevel==='string'?input.memberLevel.trim():sub.memberLevel};
    const entry=makeLedgerEntry(receipt,{id,source,occurredAt:sub.startDate||sub.createdAt,inputHash});
    await commitLedgerAndCurrent(env,[entry],historyOnly?null:sub);
    if(!historyOnly){
      // The committed current snapshot already contains the rules. This secondary
      // compatibility cache failing cannot undo the committed operation.
      try{await replaceForSubscription(env,sub.id,rules);}catch(e){console.error('[workflow] Reminder mirror delayed:',e);}
    }
    const additions=[['subscriptionNames',sub.name],['subscriptionTypes',sub.customType],['memberLevels',input.memberLevel]];
    String(sub.users||'').split(/[,，]/).forEach(v=>additions.push(['users',v]));
    String(sub.category||'').split(/[,，/\s]+/).forEach(v=>additions.push(['categories',v]));
    const metadataWarnings = await syncAcceptedCategory(env, sub);
    // A committed financial operation must not be returned as a failed creation
    // merely because an auxiliary menu write failed. Return explicit warnings.
    try {
      const menus=await getMenuOptions(env);
      for(const [group,value] of additions)if(value&&String(value).trim()&&!menus[group]?.includes(String(value).trim()))try{await addMenuOption(env,group,String(value),{returnMenus:false});}catch(e){metadataWarnings.push('基础资料菜单同步失败：'+group);console.warn('[workflow] menu sync delayed:',e.message);}
    } catch(e) {metadataWarnings.push('基础资料菜单读取失败');console.warn('[workflow] menu sync delayed:',e.message);}
    return {success:true,historyOnly,updated:!!existing,historyId:id,subscription:sub,metadataWarnings,message:historyOnly?'已累计写入订阅历史':existing?'已更新现有订阅，并新增一条订阅历史':'已新增订阅，并写入订阅历史'};
  }catch(error){return {success:false,message:error.message||'订阅保存失败'};}
}

/** prepareOnly deliberately has no writes. After the real commit, maintain the
 * legacy /api/categories and backup.categories contract as the old create path did.
 * Database menus continue to use menu-options; existing categories are only appended.
 * Replaying the same operation can repair this auxiliary write without a new receipt.
 */
async function syncAcceptedCategory(env, sub) {
  const category = typeof sub?.category === 'string' ? sub.category.trim() : '';
  if (!category) return [];
  try { await addCategory(env, category); return []; }
  catch (error) {
    console.warn('[workflow] legacy category sync delayed:', error?.message);
    return ['订阅已保存，但兼容分类同步失败；可重试相同操作编号修复'];
  }
}
