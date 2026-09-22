// @ts-check
/**
 * Smoke 测试 —— 验证基础测试设施与原生路由入口可加载。
 */
import { describe, it, expect } from 'vitest';
import app from '../src/app.js';

describe('smoke', () => {
  it('vitest 跑得起来', () => {
    expect(1 + 1).toBe(2);
  });

  it('原生 Cloudflare app 暴露 fetch/request', () => {
    expect(typeof app.fetch).toBe('function');
    expect(typeof app.request).toBe('function');
  });
});
