// @ts-check
/**
 * Cloudflare Pages Functions 适配层。
 *
 * Pages 的 EventContext 与 Workers 的 ExecutionContext 接口相近，但不是同一个对象。
 * 这里将 Pages 请求转发给原生 Cloudflare app，从而让 Workers / Pages 共用同一套业务代码。
 */
import app from './app.js';

/**
 * @param {{
 *   request: Request,
 *   env: any,
 *   waitUntil: (promise: Promise<any>) => void,
 *   passThroughOnException?: () => void
 * }} context
 */
export async function handlePagesRequest(context) {
  const executionContext = {
    waitUntil(promise) {
      context.waitUntil(promise);
    },
    passThroughOnException() {
      if (typeof context.passThroughOnException === 'function') {
        context.passThroughOnException();
      }
    }
  };

  return app.fetch(context.request, context.env, executionContext);
}
