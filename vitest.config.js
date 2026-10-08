// @ts-check
/**
 * Vitest 配置文件
 *
 * 用 @cloudflare/vitest-pool-workers 把单测跑在真实的 workerd 运行时里，
 * 这样 KV / fetch / crypto.subtle 等 Cloudflare 平台 API 不需要 mock 即可工作。
 *
 * 用法：
 *   npm test          # 跑一次（CI）
 *   npm run test:watch # watch 模式
 */
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  // 让 vite 把 .html 当作文本字符串 import（与 wrangler 生产环境的 text loader 行为一致）
  assetsInclude: ['**/*.html'],
  test: {
    include: ['tests/**/*.test.js'],
    setupFiles: ['./tests/worker-setup.js'],
    poolOptions: {
      workers: {
        miniflare: {
          compatibilityDate: '2024-09-23',
          compatibilityFlags: ['nodejs_compat'],
          kvNamespaces: ['SUBSCRIPTIONS_KV']
        },
        // 本机测试配置独立于正式发布 guard / 实际 KV、D1 ID / assets。
        // 正式 require-safe-upgrade guard 由 Node 部署回归测试单独覆盖。
        wrangler: {
          configPath: './wrangler.test.toml'
        }
      }
    }
  }
});
