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
