// @ts-check
/**
 * Cloudflare Pages 的轻量定时任务桥接 Worker。
 *
 * Pages Functions 本身没有 scheduled/cron 事件，因此完整部署模式下使用这个极小的
 * Worker 每小时调用 Pages 内部受保护的调度端点。网站与 API 仍全部运行在 Pages。
 */

async function triggerScheduler(env) {
  const baseUrl = String(env.PAGES_BASE_URL || '').replace(/\/+$/, '');
  const secret = String(env.SUBSTRACKER_CRON_SECRET || '');
  if (!baseUrl) throw new Error('缺少 PAGES_BASE_URL');
  if (!secret) throw new Error('缺少 SUBSTRACKER_CRON_SECRET');

  const response = await fetch(`${baseUrl}/api/internal/scheduler`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json'
    },
    body: '{}'
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Pages 调度端点返回 ${response.status}: ${text.slice(0, 500)}`);
  }
  console.log('[Pages Cron Bridge] 调度成功:', text.slice(0, 1000));
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(triggerScheduler(env));
  }
};
