// @ts-check
import { ensureD1Schema } from './d1-schema.js';
/**
 * Cloudflare D1 订阅镜像与历史仓库。
 *
 * 设计：
 * - KV 仍作为现有业务读取/写入层，保持旧部署兼容。
 * - D1 保存 subscriptions_current 当前镜像，以及 subscription_history 不可变历史。
 * - 密码明文和 passwordEncrypted 都不会写入 D1；仅记录 hasPassword 布尔值。
 * - 未绑定 SUBSCRIPTIONS_DB 时自动跳过，不影响旧环境继续运行。
 */

/** @param {any} env */
let d1SeedReady = false;

export function hasD1(env) {
  return !!(env && env.SUBSCRIPTIONS_DB && typeof env.SUBSCRIPTIONS_DB.prepare === 'function');
}

/** @param {any} subscription */
export function toSafeSnapshot(subscription) {
  if (!subscription || typeof subscription !== 'object') return {};
  const {
    passwordEncrypted,
    password: _password,
    reminderRules: _reminderRules,
    reminderRulesSummary: _reminderRulesSummary,
    ...rest
  } = subscription;
  return {
    ...rest,
    hasPassword: !!passwordEncrypted
  };
}

/**
 * @param {D1Database} db
 * @param {any} subscription
 */
function buildUpsertStatement(db, subscription) {
  const safe = toSafeSnapshot(subscription);
  const syncedAt = new Date().toISOString();
  return db.prepare(`
    INSERT INTO subscriptions_current (
      id, name, custom_type, category, member_level, points,
      account, account_serial, users, amount, currency,
      period_value, period_unit, expiry_date,
      is_active, auto_renew, has_password,
      data_json, created_at, updated_at, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      custom_type = excluded.custom_type,
      category = excluded.category,
      member_level = excluded.member_level,
      points = excluded.points,
      account = excluded.account,
      account_serial = excluded.account_serial,
      users = excluded.users,
      amount = excluded.amount,
      currency = excluded.currency,
      period_value = excluded.period_value,
      period_unit = excluded.period_unit,
      expiry_date = excluded.expiry_date,
      is_active = excluded.is_active,
      auto_renew = excluded.auto_renew,
      has_password = excluded.has_password,
      data_json = excluded.data_json,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      synced_at = excluded.synced_at
  `).bind(
    String(safe.id || ''),
    String(safe.name || ''),
    String(safe.customType || ''),
    String(safe.category || ''),
    String(safe.memberLevel || ''),
    safe.points === null || safe.points === undefined ? null : Number(safe.points),
    String(safe.account || ''),
    String(safe.accountSerial || ''),
    String(safe.users || ''),
    safe.amount === null || safe.amount === undefined ? null : Number(safe.amount),
    String(safe.currency || 'CNY'),
    safe.periodValue === null || safe.periodValue === undefined ? null : Number(safe.periodValue),
    String(safe.periodUnit || ''),
    safe.expiryDate ? String(safe.expiryDate) : null,
    safe.isActive === false ? 0 : 1,
    safe.autoRenew === false ? 0 : 1,
    safe.hasPassword ? 1 : 0,
    JSON.stringify(safe),
    safe.createdAt ? String(safe.createdAt) : null,
    safe.updatedAt ? String(safe.updatedAt) : null,
    syncedAt
  );
}

/**
 * @param {D1Database} db
 * @param {string} action
 * @param {any} subscription
 * @param {any} metadata
 */
function buildHistoryStatement(db, action, subscription, metadata) {
  const safe = toSafeSnapshot(subscription);
  return db.prepare(`
    INSERT INTO subscription_history (
      subscription_id, action, changed_at, name, account, account_serial,
      snapshot_json, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    String(safe.id || ''),
    String(action || 'update'),
    new Date().toISOString(),
    String(safe.name || ''),
    String(safe.account || ''),
    String(safe.accountSerial || ''),
    JSON.stringify(safe),
    metadata && Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null
  );
}

/**
 * 仅同步当前镜像，不新增历史。
 * @param {any} env
 * @param {any} subscription
 */
export async function mirrorCurrentSubscription(env, subscription) {
  if (!hasD1(env) || !subscription || !subscription.id) return false;
  try {
    await ensureD1Schema(env);
    await buildUpsertStatement(env.SUBSCRIPTIONS_DB, subscription).run();
    return true;
  } catch (error) {
    console.error('[d1] 同步订阅当前镜像失败:', error);
    return false;
  }
}

/**
 * 同步当前镜像并写入一条历史记录。
 * @param {any} env
 * @param {string} action
 * @param {any} subscription
 * @param {any} [metadata]
 */
export async function recordSubscriptionChange(env, action, subscription, metadata = {}) {
  if (!hasD1(env) || !subscription || !subscription.id) return false;
  try {
    await ensureD1Schema(env);
    const db = env.SUBSCRIPTIONS_DB;
    await db.batch([
      buildUpsertStatement(db, subscription),
      buildHistoryStatement(db, action, subscription, metadata)
    ]);
    return true;
  } catch (error) {
    console.error(`[d1] 写入订阅历史失败 (${action}):`, error);
    return false;
  }
}

/**
 * 删除当前镜像，但把删除前快照永久写入历史。
 * @param {any} env
 * @param {any} subscription
 * @param {any} [metadata]
 */
export async function recordSubscriptionDelete(env, subscription, metadata = {}) {
  if (!hasD1(env) || !subscription || !subscription.id) return false;
  try {
    await ensureD1Schema(env);
    const db = env.SUBSCRIPTIONS_DB;
    await db.batch([
      db.prepare('DELETE FROM subscriptions_current WHERE id = ?').bind(String(subscription.id)),
      buildHistoryStatement(db, 'delete', subscription, metadata)
    ]);
    return true;
  } catch (error) {
    console.error('[d1] 写入订阅删除历史失败:', error);
    return false;
  }
}

/**
 * 把一批 KV 当前数据同步到 D1。
 * replace=true 时只替换 current 表，不删除历史表。
 * @param {any} env
 * @param {any[]} subscriptions
 * @param {{ replace?: boolean, recordHistory?: boolean, action?: string }} [options]
 */
export async function syncCurrentSubscriptions(env, subscriptions, options = {}) {
  if (!hasD1(env)) return false;
  await ensureD1Schema(env);
  const db = env.SUBSCRIPTIONS_DB;
  const list = Array.isArray(subscriptions) ? subscriptions.filter((s) => s && s.id) : [];
  try {
    if (options.replace) {
      await db.prepare('DELETE FROM subscriptions_current').run();
    }

    const batchSize = 40;
    for (let i = 0; i < list.length; i += batchSize) {
      const chunk = list.slice(i, i + batchSize);
      const statements = [];
      for (const sub of chunk) {
        statements.push(buildUpsertStatement(db, sub));
        if (options.recordHistory) {
          statements.push(buildHistoryStatement(db, options.action || 'sync', sub, { source: 'bulk_sync' }));
        }
      }
      if (statements.length > 0) await db.batch(statements);
    }
    return true;
  } catch (error) {
    console.error('[d1] 批量同步订阅失败:', error);
    return false;
  }
}

/**
 * 首次绑定 D1 后，把现有 KV 订阅导入 D1 一次。
 * 标记保存在 D1 自己的 schema_meta 中，因此不会影响没有 D1 的旧部署。
 * @param {any} env
 */
export async function ensureD1Seed(env) {
  if (!hasD1(env)) return { seeded: false, reason: 'd1_not_bound' };
  try { await ensureD1Schema(env); } catch { return { seeded: false, reason: 'schema_init_failed' }; }
  const accountsRepo = await import('./accounts.repo.js');
  if (d1SeedReady) {
    await accountsRepo.ensureAccountsSeed(env);
    return { seeded: false, reason: 'cached' };
  }
  const db = env.SUBSCRIPTIONS_DB;
  try {
    const marker = await db.prepare("SELECT value FROM schema_meta WHERE key = 'kv_seed_v1'").first();
    if (marker) {
      d1SeedReady = true;
      await accountsRepo.ensureAccountsSeed(env);
      return { seeded: false, reason: 'already_seeded' };
    }

    const subRepo = await import('./subscriptions.repo.js');
    const subscriptions = await subRepo.listAll(env);
    await syncCurrentSubscriptions(env, subscriptions, {
      replace: false,
      recordHistory: true,
      action: 'initial_import'
    });
    await db.prepare(`
      INSERT INTO schema_meta (key, value, updated_at)
      VALUES ('kv_seed_v1', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).bind(String(subscriptions.length), new Date().toISOString()).run();
    await accountsRepo.ensureAccountsSeed(env, subscriptions);
    d1SeedReady = true;
    console.log(`[d1] 已导入 ${subscriptions.length} 条现有订阅到 D1`);
    return { seeded: true, count: subscriptions.length };
  } catch (error) {
    // 最常见原因是还没执行 migrations；不阻塞现有 KV 业务。
    console.error('[d1] 初始化 D1 镜像失败，请确认已执行数据库迁移:', error);
    return { seeded: false, reason: 'seed_failed' };
  }
}


/**
 * 读取 D1 中的订阅当前快照。用于需要强一致回读的编辑流程。
 * D1 未绑定或记录不存在时返回 null。
 * @param {any} env
 * @param {string} subscriptionId
 */
export async function getCurrentSubscriptionSnapshot(env, subscriptionId) {
  if (!hasD1(env) || !subscriptionId) return null;
  try {
    await ensureD1Schema(env);
    const row = await env.SUBSCRIPTIONS_DB.prepare(`
      SELECT data_json, updated_at
      FROM subscriptions_current
      WHERE id = ?
      LIMIT 1
    `).bind(String(subscriptionId)).first();
    if (!row || !row.data_json) return null;
    const parsed = JSON.parse(String(row.data_json));
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.updatedAt && row.updated_at) parsed.updatedAt = String(row.updated_at);
    return parsed;
  } catch (error) {
    console.error('[d1] 读取订阅当前快照失败:', error);
    return null;
  }
}

/**
 * 批量读取 D1 当前快照。只用于与 KV 当前列表做“较新版本覆盖”，
 * 不单独把 D1-only 记录重新加入列表，避免已删除记录被误恢复。
 * @param {any} env
 * @returns {Promise<any[]>}
 */
export async function listCurrentSubscriptionSnapshots(env) {
  if (!hasD1(env)) return [];
  try {
    await ensureD1Schema(env);
    const result = await env.SUBSCRIPTIONS_DB.prepare(`
      SELECT id, data_json, updated_at
      FROM subscriptions_current
    `).all();
    const out = [];
    for (const row of result.results || []) {
      if (!row || !row.data_json) continue;
      try {
        const parsed = JSON.parse(String(row.data_json));
        if (!parsed || typeof parsed !== 'object') continue;
        if (!parsed.id && row.id) parsed.id = String(row.id);
        if (!parsed.updatedAt && row.updated_at) parsed.updatedAt = String(row.updated_at);
        out.push(parsed);
      } catch (_) {}
    }
    return out;
  } catch (error) {
    console.error('[d1] 批量读取订阅当前快照失败:', error);
    return [];
  }
}

/**
 * 查询指定订阅的历史记录。
 * @param {any} env
 * @param {string} subscriptionId
 * @param {number} [limit]
 */
export async function listSubscriptionHistory(env, subscriptionId, limit = 100) {
  if (!hasD1(env)) return [];
  try { await ensureD1Schema(env); } catch { return []; }
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
  try {
    const result = await env.SUBSCRIPTIONS_DB.prepare(`
      SELECT history_id, subscription_id, action, changed_at,
             name, account, account_serial, snapshot_json, metadata_json
      FROM subscription_history
      WHERE subscription_id = ?
      ORDER BY changed_at DESC, history_id DESC
      LIMIT ?
    `).bind(String(subscriptionId), safeLimit).all();

    return (result.results || []).map((row) => {
      let snapshot = {};
      let metadata = null;
      try { snapshot = row.snapshot_json ? JSON.parse(String(row.snapshot_json)) : {}; } catch { snapshot = {}; }
      try { metadata = row.metadata_json ? JSON.parse(String(row.metadata_json)) : null; } catch { metadata = null; }
      return {
        id: row.history_id,
        subscriptionId: row.subscription_id,
        action: row.action,
        changedAt: row.changed_at,
        name: row.name,
        account: row.account,
        accountSerial: row.account_serial,
        snapshot,
        metadata
      };
    });
  } catch (error) {
    console.error('[d1] 查询订阅历史失败:', error);
    return [];
  }
}
