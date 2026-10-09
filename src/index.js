import {UPGRADE_RUN} from './upgrade-release.js';
import {usesWebInit} from './data/web-init-protocol.js';
import {upgradeReady} from './data/upgrade-gate.js';
// @ts-check
/**
 * Worker 入口
 *
 * fetch handler 委托给 Hono 应用（src/app.js）。
 * scheduled handler 触发定时任务执行。
 *
 */

import app from './app.js';
import { ensureMigrations } from './data/migrate.js';
import { checkExpiringSubscriptions } from './services/scheduler.js';

export default {
  fetch: app.fetch,

  /**
   * 每小时由 Cron 触发一次。
   *
   * @param {ScheduledEvent} event
   * @param {{ SUBSCRIPTIONS_KV: KVNamespace, SUBSCRIPTIONS_DB?: D1Database }} env
   * @param {ExecutionContext} ctx
   */
  async scheduled(event, env, ctx) {
    void ctx;
    if(!await upgradeReady(env)){console.log("[upgrade] 验收前暂停定时任务");return;}
    try {
      if(!usesWebInit(UPGRADE_RUN))await ensureMigrations(env);
    } catch (err) {
      console.error('[index] scheduled 迁移失败:', err);
      return;
    }
    console.log(
      '[Workers] 定时任务触发',
      'cron:',
      event?.cron || '(unknown)',
      'UTC:',
      new Date().toISOString()
    );
    await checkExpiringSubscriptions(env);
  }
};
