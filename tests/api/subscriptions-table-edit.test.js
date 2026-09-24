// @ts-check
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-ignore
import { env } from 'cloudflare:test';
import app from '../../src/app.js';
import * as subRepo from '../../src/data/subscriptions.repo.js';

async function clearKv() {
  const list = await env.SUBSCRIPTIONS_KV.list();
  await Promise.all(list.keys.map((k) => env.SUBSCRIPTIONS_KV.delete(k.name)));
}

async function loginCookie() {
  await env.SUBSCRIPTIONS_KV.put('config', JSON.stringify({
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'password', JWT_SECRET: 'k',
    CREDENTIALS_ENCRYPTION_KEY: 'c', TIMEZONE: 'Asia/Shanghai'
  }));
  const res = await app.request('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'password' })
  }, env);
  return res.headers.get('Set-Cookie')?.split(';')[0] || '';
}

beforeEach(clearKv);

describe('订阅表格字段级保存', () => {
  it('表格修改实际写入 KV，而不是只返回成功', async () => {
    const cookie = await loginCookie();
    const create = await app.request('/api/subscriptions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        name: 'Before', startDate: '2026-09-24', expiryDate: '2026-10-24',
        periodValue: 1, periodUnit: 'month', amount: 10, currency: 'CNY'
      })
    }, env);
    const created = await create.json();
    const id = created.subscription.id;

    const save = await app.request(`/api/subscriptions/${id}/table-edit`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ changes: { name: 'After', amount: 88, notes: 'table saved' } })
    }, env);
    const body = await save.json();
    expect(save.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.saved).toBe(true);
    expect(body.storageVerified).toBe(true);

    const stored = await subRepo.getById(env, id);
    expect(stored.name).toBe('After');
    expect(stored.amount).toBe(88);
    expect(stored.notes).toBe('table saved');
  });

  it('同一次保存修改提醒规则时，不会把其他单格修改覆盖回旧值', async () => {
    const cookie = await loginCookie();
    const create = await app.request('/api/subscriptions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        name: 'Old', startDate: '2026-09-24', expiryDate: '2026-10-24',
        periodValue: 1, periodUnit: 'month', amount: 10, currency: 'CNY'
      })
    }, env);
    const created = await create.json();
    const id = created.subscription.id;

    const save = await app.request(`/api/subscriptions/${id}/table-edit`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ changes: {
        name: 'New', amount: 99,
        reminderRules: [
          { type: 'before_expiry', value: 7, unit: 'days', isEnabled: false },
          { type: 'before_expiry', value: 1, unit: 'days', isEnabled: true },
          { type: 'on_expiry', value: 0, unit: 'days', isEnabled: true }
        ]
      } })
    }, env);
    const body = await save.json();
    expect(body.success).toBe(true);

    const stored = await subRepo.getById(env, id);
    expect(stored.name).toBe('New');
    expect(stored.amount).toBe(99);
    expect(stored.reminderValue).toBe(1);
  });
});

// 3.3.18: the acknowledgement must reflect INPUT values, not only updater output.
describe('表格保存输入值契约回归', () => {
  async function fixture() {
    const cookie=await loginCookie();
    await subRepo.save(env, {id:'intent-regression',name:'Before',customType:'开会员',
      expiryDate:'2030-10-24T16:00:00.000Z',startDate:'2030-09-24T16:00:00.000Z',
      periodValue:1,periodUnit:'month',subscriptionMode:'reset',memberLevel:'Pro',
      isActive:true,autoRenew:false,useLunar:false,endOfMonth:false,amount:null,currency:'CNY',notes:'Original',
      createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'});
    return (changes)=>app.request('/api/subscriptions/intent-regression/table-edit',{
      method:'PATCH',headers:{'Content-Type':'application/json',Cookie:cookie},
      body:JSON.stringify({changes,clientVersion:'3.3.18'})
    },env);
  }
  it('空订阅类型不回填旧值',async()=>{
    const patch=await fixture();const response=await patch({customType:''});
    expect(response.status).toBe(200);
    const body=await response.json();expect(body.subscription.customType).toBe('');
    expect(body.tableEditProtocol).toBe(2);
    expect((await subRepo.getById(env,'intent-regression')).customType).toBe('');
  });
  it('过去的到期日期不被表格更新流程续期',async()=>{
    const patch=await fixture();const response=await patch({expiryDate:'2025-10-25'});
    expect(response.status).toBe(200);
    expect((await subRepo.getById(env,'intent-regression')).expiryDate).toBe('2025-10-24T16:00:00.000Z');
  });
  it('业务规则会丢弃输入值时必须在写入前拒绝',async()=>{
    const patch=await fixture();await patch({expiryDate:'2025-10-25'});
    const response=await patch({memberLevel:'Pro',notes:'MUST NOT WRITE'});
    expect(response.status).toBe(400);
    expect((await response.json()).saved).toBe(false);
    expect((await subRepo.getById(env,'intent-regression')).notes).toBe('Original');
  });
  it('清空提醒后 GET 不重新补回旧 legacy 提醒',async()=>{
    const patch=await fixture();const response=await patch({reminderRules:[]});
    expect(response.status).toBe(200);
    const saved=await response.json();expect(saved.verification.reminders).toBe(true);
    expect((await subRepo.getById(env,'intent-regression')).reminderRules).toEqual([]);
  });
  it('零周期与未知字段不允许静默转换/忽略',async()=>{
    const patch=await fixture();expect((await patch({periodValue:0})).status).toBe(400);
    expect((await patch({updatedAt:'edited'})).status).toBe(400);
  });
});
