// @ts-check
/**
 * SubsTracker 原生 Cloudflare 路由装配。
 *
 * v3.2.2 起不再依赖 Hono 等第三方运行时路由包，避免 Cloudflare Pages
 * 在 Functions bundling 阶段因 node_modules 未准备完成而出现
 * `Could not resolve "hono"` 并导致整次部署失败。
 *
 * Pages Functions 与 Workers 共用同一个 fetch 入口，业务 handler 保持不变。
 */

import { handleApiRequest } from './api/router.js';
import { handleAdminRequest, handleLoginPage } from './api/admin.js';
import { handleDebug } from './api/debug.js';
import { getUserFromRequest } from './api/handlers/auth.js';
import { ensureMigrations } from './data/migrate.js';
import { checkExpiringSubscriptions } from './services/scheduler.js';

/**
 * @typedef {{
 *   SUBSCRIPTIONS_KV: KVNamespace,
 *   SUBSCRIPTIONS_DB?: D1Database,
 *   SUBSTRACKER_ADMIN_PASSWORD?: string,
 *   SUBSTRACKER_SUPERADMIN_USERNAME?: string,
 *   SUBSTRACKER_SUPERADMIN_PASSWORD?: string,
 *   SUBSTRACKER_CRON_SECRET?: string
 * }} Bindings
 */

/** @param {string} a @param {string} b */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** @param {unknown} err */
function errorResponse(err) {
  console.error('[app] 未捕获异常:', err && typeof err === 'object' && 'stack' in err ? err.stack : err);
  const message = err && typeof err === 'object' && 'message' in err
    ? String(err.message)
    : '服务异常';
  return Response.json(
    { success: false, message, code: 'internal_error' },
    { status: 500 }
  );
}

/**
 * @param {Request} request
 * @param {Bindings} env
 * @param {ExecutionContext | any} [ctx]
 */
async function routeRequest(request, env, ctx) {
  void ctx;

  try {
    // 与旧 Hono 全局 middleware 行为一致：每次请求先透明检查迁移。
    try {
      await ensureMigrations(env);
    } catch (err) {
      console.error('[app] 迁移失败，回退继续处理请求:', err);
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    // 根路径：已登录进入后台，否则显示登录页。
    if (path === '/' && method === 'GET') {
      const { user } = await getUserFromRequest(request, env);
      if (user) {
        return new Response(null, {
          status: 302,
          headers: { Location: '/admin' }
        });
      }
      return handleLoginPage();
    }

    // Debug：保持原来的登录保护。
    if (path === '/debug') {
      const { user } = await getUserFromRequest(request, env);
      if (!user) {
        return new Response('未授权访问', {
          status: 401,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }
      return handleDebug(request, env);
    }

    // Pages Cron Bridge 内部调度接口。
    if (path === '/api/internal/scheduler' && method === 'POST') {
      const expected = String(env.SUBSTRACKER_CRON_SECRET || '');
      if (!expected) {
        return Response.json({ success: false, message: '调度密钥尚未配置' }, { status: 503 });
      }

      const auth = request.headers.get('Authorization') || '';
      const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!supplied || !safeEqual(supplied, expected)) {
        return Response.json({ success: false, message: '未授权的调度请求' }, { status: 401 });
      }

      const result = await checkExpiringSubscriptions(env);
      return Response.json({ success: true, result });
    }

    // API：认证逻辑仍由现有 API handler 负责。
    if (path === '/api' || path.startsWith('/api/')) {
      return handleApiRequest(request, env);
    }

    // Admin 页面。
    if (path === '/admin' || path.startsWith('/admin/')) {
      return handleAdminRequest(request, env);
    }

    // 保持旧行为：未知页面回到登录页。
    return handleLoginPage();
  } catch (err) {
    return errorResponse(err);
  }
}

const app = {
  fetch: routeRequest,

  /**
   * 测试辅助接口，兼容旧测试中 app.request(...) 的调用方式。
   * @param {string | Request} input
   * @param {RequestInit} [init]
   * @param {Bindings} [env]
   */
  async request(input, init = {}, env = /** @type {Bindings} */ ({})) {
    const request = input instanceof Request
      ? input
      : new Request(
          /^https?:\/\//i.test(String(input)) ? String(input) : `http://localhost${String(input)}`,
          init
        );
    return routeRequest(request, env, {
      waitUntil() {},
      passThroughOnException() {}
    });
  }
};

export default app;
