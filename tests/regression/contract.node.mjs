import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeTableChanges,mismatchedTableFields,canonicalRules} from '../../src/data/table-edit-contract.js';
import {defaultPresetRules,legacyFieldToRule} from '../../src/data/reminders.repo.js';
import {toSafeSnapshot} from '../../src/data/subscription-history.repo.js';
test('input intent: empty string must not match old nonempty value',()=>{
  const expected=normalizeTableChanges({customType:''});
  assert.deepEqual(mismatchedTableFields({customType:'开会员'},expected),['customType']);
  assert.deepEqual(mismatchedTableFields({customType:''},expected),[]);
});
test('date equivalence uses configured date semantics, not string representation',()=>{
  const expected=normalizeTableChanges({expiryDate:'2025-10-25'},'Asia/Shanghai');
  assert.equal(expected.expiryDate,'2025-10-24T16:00:00.000Z');
  assert.deepEqual(mismatchedTableFields({expiryDate:'2026-10-24T16:00:00.000Z'},expected),['expiryDate']);
  assert.deepEqual(mismatchedTableFields({expiryDate:'2025-10-24T16:00:00.000Z'},expected),[]);
});
test('empty optional values remain valid',()=>{
  assert.deepEqual(normalizeTableChanges({startDate:'',points:'',amount:'',notes:''}),{startDate:null,points:null,amount:null,notes:''});
});
test('normalization never silently accepts invalid dates or periods',()=>{
  for(const changes of [{periodValue:0},{periodValue:-1},{periodValue:1.5},{expiryDate:'2026-02-30'},{reminderRules:{}},{isActive:'false'},{name:''}]){
    assert.throws(()=>normalizeTableChanges(changes));
  }
});
test('disabled reminder rules are different; IDs and creation timestamps are not business values',()=>{
  const a=[{id:'a',type:'before_expiry',value:1,unit:'days',isEnabled:true}];
  const b=[{...a[0],id:'b',createdAt:'a different time'}];
  assert.deepEqual(canonicalRules(a),canonicalRules(b));
  assert.notDeepEqual(canonicalRules(a),canonicalRules([{...a[0],isEnabled:false}]));
});
test('D1 safe snapshot retains reminder content but no password data',()=>{
  const safe=toSafeSnapshot({id:'s',password:'plaintext',passwordEncrypted:'cipher',reminderRules:[]});
  assert.deepEqual(safe.reminderRules,[]);assert.equal('password' in safe,false);assert.equal('passwordEncrypted' in safe,false);
});
test('preset still builds 7/3 disabled and 1/day-of enabled',()=>{
  const rules=defaultPresetRules();assert.deepEqual(rules.map(r=>r.value),[7,3,1,0]);assert.deepEqual(rules.map(r=>r.isEnabled),[false,false,true,true]);
  assert.equal(legacyFieldToRule({}).value,1);
});
test('scheduler: empty rules stay disabled and legacy rule keeps stable dedupe id',async()=>{
  const {checkExpiringSubscriptions}=await import('../../src/services/scheduler.js');
  const map=new Map();
  const env={SUBSCRIPTIONS_KV:{
    async get(k){return map.get(k)??null;},async put(k,v){map.set(k,String(v));},async delete(k){map.delete(k);},
    async list({prefix=''}={}){return {keys:[...map.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name})),list_complete:true};}
  }};
  await env.SUBSCRIPTIONS_KV.put('config',JSON.stringify({JWT_SECRET:'test-only',TIMEZONE:'UTC',NOTIFICATION_HOURS:[],ENABLED_NOTIFIERS:['telegram'],TG_BOT_TOKEN:'test-only',TG_CHAT_ID:'test-only'}));
  const tomorrow=new Date();tomorrow.setUTCHours(0,0,0,0);tomorrow.setUTCDate(tomorrow.getUTCDate()+1);
  const fixture={name:'Regression',expiryDate:tomorrow.toISOString(),periodValue:1,periodUnit:'month',subscriptionMode:'reset',isActive:true,autoRenew:false,reminderValue:1,reminderUnit:'day',memberLevel:'Pro'};
  await env.SUBSCRIPTIONS_KV.put('sub_index',JSON.stringify(['legacy','empty']));
  await env.SUBSCRIPTIONS_KV.put('sub:legacy',JSON.stringify({...fixture,id:'legacy'}));
  await env.SUBSCRIPTIONS_KV.put('sub:empty',JSON.stringify({...fixture,id:'empty',reminderRules:[]}));
  await env.SUBSCRIPTIONS_KV.put('reminder_rules:empty','[]');
  const realFetch=globalThis.fetch;let sends=0;
  globalThis.fetch=async()=>{sends++;return new Response(JSON.stringify({ok:true,result:{message_id:1}}),{status:200});};
  try{
    const first=await checkExpiringSubscriptions(env);const second=await checkExpiringSubscriptions(env);
    assert.equal(first.matchedCount,1);assert.equal(first.sentCount,1);
    assert.equal(second.matchedCount,1);assert.equal(second.dedupedCount,1);assert.equal(second.sentCount,0);
    assert.equal(sends,1);
    assert.equal([...map.keys()].some(k=>k.startsWith('notify_dedupe:legacy:legacy:legacy:')),true);
  }finally{globalThis.fetch=realFetch;}
});
