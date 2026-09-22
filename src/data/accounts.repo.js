// @ts-check
/**
 * D1 独立账号数据库。
 *
 * 数据模型：
 * - account_serial：账号序号，主键，一对一标识。
 * - account：账号，唯一。
 * - password_encrypted：AES-GCM 密文，不保存明文。
 *
 * 订阅记录仍保留 account/accountSerial 快照以兼容旧版本和 KV 主数据，
 * 但账号映射与密码以本表为统一来源；修改账号库时会同步关联订阅。
 */

import * as subRepo from './subscriptions.repo.js';
import { recordSubscriptionChange } from './subscription-history.repo.js';
import { ensureD1Schema } from './d1-schema.js';

let accountsSeedReady = false;

/** @param {any} env */
export function hasAccountsDb(env) {
  return !!(env && env.SUBSCRIPTIONS_DB && typeof env.SUBSCRIPTIONS_DB.prepare === 'function');
}

function normalizeSerial(value) {
  return String(value || '').trim();
}

function normalizeAccount(value) {
  return String(value || '').trim();
}

function mapRow(row) {
  if (!row) return null;
  return {
    accountSerial: String(row.account_serial || ''),
    account: String(row.account || ''),
    passwordEncrypted: String(row.password_encrypted || ''),
    hasPassword: !!row.password_encrypted,
    sourceSubscriptionId: row.source_subscription_id ? String(row.source_subscription_id) : '',
    createdAt: row.created_at ? String(row.created_at) : '',
    updatedAt: row.updated_at ? String(row.updated_at) : ''
  };
}

function safeRow(row) {
  const mapped = mapRow(row);
  if (!mapped) return null;
  const { passwordEncrypted: _passwordEncrypted, ...safe } = mapped;
  return safe;
}

/** @param {D1Database} db @param {string} action @param {any} row @param {any} [metadata] */
function buildHistoryStatement(db, action, row, metadata = {}) {
  const mapped = mapRow(row) || {
    accountSerial: normalizeSerial(row?.accountSerial),
    account: normalizeAccount(row?.account),
    hasPassword: !!row?.passwordEncrypted
  };
  return db.prepare(`
    INSERT INTO account_history (
      account_serial, action, changed_at, account, has_password, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    mapped.accountSerial,
    action || 'update',
    new Date().toISOString(),
    mapped.account,
    mapped.hasPassword ? 1 : 0,
    metadata && Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null
  );
}

/** @param {any} env @param {string} serial */
export async function getBySerial(env, serial) {
  if (!hasAccountsDb(env)) return null;
  try { await ensureD1Schema(env); } catch { return null; }
  const value = normalizeSerial(serial);
  if (!value) return null;
  try {
    const row = await env.SUBSCRIPTIONS_DB.prepare(`
      SELECT account_serial, account, password_encrypted, source_subscription_id, created_at, updated_at
      FROM accounts WHERE account_serial = ?
    `).bind(value).first();
    return mapRow(row);
  } catch (error) {
    console.error('[accounts] 按账号序号查询失败:', error);
    return null;
  }
}

/** @param {any} env @param {string} account */
export async function getByAccount(env, account) {
  if (!hasAccountsDb(env)) return null;
  try { await ensureD1Schema(env); } catch { return null; }
  const value = normalizeAccount(account);
  if (!value) return null;
  try {
    const row = await env.SUBSCRIPTIONS_DB.prepare(`
      SELECT account_serial, account, password_encrypted, source_subscription_id, created_at, updated_at
      FROM accounts WHERE account = ?
    `).bind(value).first();
    return mapRow(row);
  } catch (error) {
    console.error('[accounts] 按账号查询失败:', error);
    return null;
  }
}

/**
 * 返回用于订阅编辑页双向联动的全部账号映射，不包含密码密文。
 * @param {any} env
 */
export async function listOptions(env) {
  if (!hasAccountsDb(env)) return [];
  try {
    await ensureD1Schema(env);
    const result = await env.SUBSCRIPTIONS_DB.prepare(`
      SELECT account_serial, account,
             CASE WHEN password_encrypted <> '' THEN 1 ELSE 0 END AS has_password,
             updated_at
      FROM accounts
      ORDER BY account_serial COLLATE NOCASE ASC
      LIMIT 5000
    `).all();
    return (result.results || []).map((row) => ({
      accountSerial: String(row.account_serial || ''),
      account: String(row.account || ''),
      hasPassword: Number(row.has_password || 0) === 1,
      updatedAt: row.updated_at ? String(row.updated_at) : ''
    }));
  } catch (error) {
    console.error('[accounts] 读取账号选项失败:', error);
    return [];
  }
}

/**
 * 分页查询账号库。
 * @param {any} env
 * @param {{ page?: number, pageSize?: number, q?: string }} [options]
 */
export async function listPaged(env, options = {}) {
  if (!hasAccountsDb(env)) return { items: [], total: 0, page: 1, pageSize: 20, totalPages: 0 };
  await ensureD1Schema(env);
  const pageSize = Math.min(100, Math.max(10, Number(options.pageSize) || 20));
  const page = Math.max(1, Number(options.page) || 1);
  const q = String(options.q || '').trim();
  const where = q ? 'WHERE account_serial LIKE ? OR account LIKE ?' : '';
  const binds = q ? [`%${q}%`, `%${q}%`] : [];
  const countStmt = env.SUBSCRIPTIONS_DB.prepare(`SELECT COUNT(*) AS count FROM accounts ${where}`);
  const countRow = q ? await countStmt.bind(...binds).first() : await countStmt.first();
  const total = Number(countRow?.count || 0);
  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
  const safePage = totalPages > 0 ? Math.min(page, totalPages) : 1;
  const offset = (safePage - 1) * pageSize;
  const sql = `
    SELECT account_serial, account, password_encrypted, source_subscription_id, created_at, updated_at
    FROM accounts
    ${where}
    ORDER BY updated_at DESC, account_serial COLLATE NOCASE ASC
    LIMIT ? OFFSET ?
  `;
  const stmt = env.SUBSCRIPTIONS_DB.prepare(sql);
  const result = q
    ? await stmt.bind(...binds, pageSize, offset).all()
    : await stmt.bind(pageSize, offset).all();
  return {
    items: (result.results || []).map(safeRow).filter(Boolean),
    total,
    page: safePage,
    pageSize,
    totalPages
  };
}

/**
 * 检查一对一映射冲突。
 * @param {any} env
 * @param {string} serial
 * @param {string} account
 * @param {string} [excludeSerial]
 */
export async function validatePair(env, serial, account, excludeSerial = '') {
  if (!hasAccountsDb(env)) return { ok: true, reason: 'd1_not_bound' };
  const normalizedSerial = normalizeSerial(serial);
  const normalizedAccount = normalizeAccount(account);
  if (!normalizedSerial && !normalizedAccount) return { ok: true, reason: 'empty' };
  if (!normalizedSerial || !normalizedAccount) {
    return { ok: false, message: '账号序号和账号必须同时填写' };
  }

  try {
    const serialRow = await getBySerial(env, normalizedSerial);
    if (serialRow && serialRow.account !== normalizedAccount && normalizedSerial !== excludeSerial) {
      return { ok: false, message: `账号序号 ${normalizedSerial} 已绑定账号 ${serialRow.account}` };
    }
    if (serialRow && serialRow.account !== normalizedAccount && normalizedSerial === excludeSerial) {
      // 编辑当前记录允许变更账号，但新账号不能被其他序号占用。
    }

    const accountRow = await getByAccount(env, normalizedAccount);
    if (accountRow && accountRow.accountSerial !== normalizedSerial && accountRow.accountSerial !== excludeSerial) {
      return { ok: false, message: `账号 ${normalizedAccount} 已绑定账号序号 ${accountRow.accountSerial}` };
    }
    return { ok: true };
  } catch (error) {
    // 迁移尚未执行时不阻塞旧 KV 业务。
    console.error('[accounts] 校验账号映射失败:', error);
    return { ok: true, reason: 'accounts_table_unavailable' };
  }
}

/**
 * 新增/同步账号。若 exact pair 已存在，则只在提供新密文时更新密码。
 * @param {any} env
 * @param {{ accountSerial: string, account: string, passwordEncrypted?: string, sourceSubscriptionId?: string }} data
 * @param {{ action?: string, metadata?: any }} [options]
 */
export async function upsert(env, data, options = {}) {
  if (!hasAccountsDb(env)) return { success: true, skipped: true, reason: 'd1_not_bound' };
  await ensureD1Schema(env);
  const accountSerial = normalizeSerial(data.accountSerial);
  const account = normalizeAccount(data.account);
  if (!accountSerial && !account) return { success: true, skipped: true, reason: 'empty' };
  if (!accountSerial || !account) return { success: false, message: '账号序号和账号必须同时填写' };

  const check = await validatePair(env, accountSerial, account);
  if (!check.ok) return { success: false, message: check.message };

  const existing = await getBySerial(env, accountSerial);
  const now = new Date().toISOString();
  const passwordEncrypted = data.passwordEncrypted !== undefined
    ? String(data.passwordEncrypted || '')
    : String(existing?.passwordEncrypted || '');
  const sourceSubscriptionId = String(data.sourceSubscriptionId || existing?.sourceSubscriptionId || '');
  const createdAt = existing?.createdAt || now;
  const db = env.SUBSCRIPTIONS_DB;
  try {
    const write = db.prepare(`
      INSERT INTO accounts (
        account_serial, account, password_encrypted, source_subscription_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_serial) DO UPDATE SET
        account = excluded.account,
        password_encrypted = excluded.password_encrypted,
        source_subscription_id = excluded.source_subscription_id,
        updated_at = excluded.updated_at
    `).bind(accountSerial, account, passwordEncrypted, sourceSubscriptionId || null, createdAt, now);
    const historyRow = {
      account_serial: accountSerial,
      account,
      password_encrypted: passwordEncrypted
    };
    await db.batch([
      write,
      buildHistoryStatement(db, options.action || (existing ? 'sync' : 'create'), historyRow, options.metadata || {})
    ]);
    return { success: true, account: { accountSerial, account, hasPassword: !!passwordEncrypted, createdAt, updatedAt: now } };
  } catch (error) {
    console.error('[accounts] 保存账号失败:', error);
    return { success: false, message: '保存账号失败: ' + (error?.message || String(error)) };
  }
}

/**
 * 从订阅同步账号库。订阅已有 AES-GCM 密文可直接复用，无需解密重加密。
 * @param {any} env
 * @param {any} subscription
 * @param {{ action?: string, metadata?: any, syncPassword?: boolean }} [options]
 */
export async function syncFromSubscription(env, subscription, options = {}) {
  if (!subscription) return { success: true, skipped: true, reason: 'empty_subscription' };
  /** @type {any} */
  const payload = {
    accountSerial: subscription.accountSerial || '',
    account: subscription.account || '',
    sourceSubscriptionId: subscription.id || ''
  };
  if (options.syncPassword !== false) {
    payload.passwordEncrypted = subscription.passwordEncrypted || '';
  }
  return upsert(env, payload, {
    action: options.action || 'subscription_sync',
    metadata: { source: 'subscription', ...(options.metadata || {}) }
  });
}

/**
 * 修改账号库，同时把账号/序号同步到所有关联订阅 KV + D1 镜像。密码只保存在账号 Database。
 * @param {any} env
 * @param {string} originalSerial
 * @param {{ accountSerial: string, account: string, passwordEncrypted?: string }} data
 */
export async function updateAndPropagate(env, originalSerial, data) {
  if (!hasAccountsDb(env)) return { success: false, message: 'D1 数据库未绑定' };
  const oldSerial = normalizeSerial(originalSerial);
  const current = await getBySerial(env, oldSerial);
  if (!current) return { success: false, message: '账号记录不存在' };

  const newSerial = normalizeSerial(data.accountSerial);
  const newAccount = normalizeAccount(data.account);
  if (!newSerial || !newAccount) return { success: false, message: '账号序号和账号不能为空' };

  const check = await validatePair(env, newSerial, newAccount, oldSerial);
  if (!check.ok) return { success: false, message: check.message };
  const existingByNewSerial = newSerial === oldSerial ? current : await getBySerial(env, newSerial);
  if (existingByNewSerial && newSerial !== oldSerial) {
    return { success: false, message: `账号序号 ${newSerial} 已存在` };
  }

  const passwordEncrypted = data.passwordEncrypted !== undefined
    ? String(data.passwordEncrypted || '')
    : current.passwordEncrypted;
  const now = new Date().toISOString();
  const db = env.SUBSCRIPTIONS_DB;

  try {
    const statements = [];
    statements.push(db.prepare(`
      UPDATE accounts
      SET account_serial = ?, account = ?, password_encrypted = ?, updated_at = ?
      WHERE account_serial = ?
    `).bind(newSerial, newAccount, passwordEncrypted, now, oldSerial));
    statements.push(buildHistoryStatement(db, 'update', {
      account_serial: newSerial,
      account: newAccount,
      password_encrypted: passwordEncrypted
    }, { previousSerial: oldSerial, previousAccount: current.account }));
    await db.batch(statements);

    const subscriptions = await subRepo.listAll(env);
    const affected = subscriptions.filter((sub) => {
      const serial = normalizeSerial(sub.accountSerial);
      const account = normalizeAccount(sub.account);
      return serial === oldSerial || (serial === '' && account === current.account) || (serial === oldSerial && account === current.account);
    });
    let syncedSubscriptions = 0;
    let syncFailures = 0;
    for (const sub of affected) {
      const { passwordEncrypted: _legacyPasswordEncrypted, password: _legacyPassword, ...subscriptionWithoutPassword } = sub;
      const updated = {
        ...subscriptionWithoutPassword,
        accountSerial: newSerial,
        account: newAccount,
        updatedAt: new Date().toISOString()
      };
      try {
        await subRepo.save(env, updated);
        await recordSubscriptionChange(env, 'account_database_sync', updated, {
          source: 'accounts_database',
          previousSerial: oldSerial,
          accountSerial: newSerial
        });
        syncedSubscriptions += 1;
      } catch (syncError) {
        syncFailures += 1;
        console.error('[accounts] 同步关联订阅失败:', sub.id, syncError);
      }
    }

    return {
      success: true,
      account: { accountSerial: newSerial, account: newAccount, hasPassword: !!passwordEncrypted, updatedAt: now },
      affectedSubscriptions: syncedSubscriptions,
      syncFailures
    };
  } catch (error) {
    console.error('[accounts] 更新并同步账号失败:', error);
    return { success: false, message: '更新账号失败: ' + (error?.message || String(error)) };
  }
}

/** @param {any} env @param {string} serial */
export async function countLinkedSubscriptions(env, serial) {
  const value = normalizeSerial(serial);
  if (!value) return 0;
  let d1Count = 0;
  if (hasAccountsDb(env)) {
    try {
      const row = await env.SUBSCRIPTIONS_DB.prepare(`
        SELECT COUNT(*) AS count FROM subscriptions_current WHERE account_serial = ?
      `).bind(value).first();
      d1Count = Number(row?.count || 0);
    } catch {
      d1Count = 0;
    }
  }
  // 删除保护同时检查 KV 主数据，避免 D1 镜像暂时落后时误删仍被引用的账号。
  const subs = await subRepo.listAll(env);
  const kvCount = subs.filter((sub) => normalizeSerial(sub.accountSerial) === value).length;
  return Math.max(d1Count, kvCount);
}

/** @param {any} env @param {string} serial */
export async function deleteAccount(env, serial) {
  if (!hasAccountsDb(env)) return { success: false, message: 'D1 数据库未绑定' };
  const value = normalizeSerial(serial);
  const existing = await getBySerial(env, value);
  if (!existing) return { success: false, message: '账号记录不存在' };
  const linked = await countLinkedSubscriptions(env, value);
  if (linked > 0) {
    return { success: false, message: `该账号仍被 ${linked} 条订阅引用，请先调整关联订阅`, linkedSubscriptions: linked };
  }
  try {
    const db = env.SUBSCRIPTIONS_DB;
    await db.batch([
      db.prepare('DELETE FROM accounts WHERE account_serial = ?').bind(value),
      buildHistoryStatement(db, 'delete', {
        account_serial: existing.accountSerial,
        account: existing.account,
        password_encrypted: existing.passwordEncrypted
      })
    ]);
    return { success: true };
  } catch (error) {
    console.error('[accounts] 删除账号失败:', error);
    return { success: false, message: '删除账号失败' };
  }
}

/**
 * 首次部署独立账号表时，从现有 KV 订阅抽取账号数据。
 * 最新订阅优先，冲突的旧映射会跳过并记录日志。
 * @param {any} env
 * @param {any[]} [knownSubscriptions]
 */
export async function ensureAccountsSeed(env, knownSubscriptions) {
  if (!hasAccountsDb(env)) return { seeded: false, reason: 'd1_not_bound' };
  try { await ensureD1Schema(env); } catch { return { seeded: false, reason: 'schema_init_failed' }; }
  if (accountsSeedReady) return { seeded: false, reason: 'cached' };
  const db = env.SUBSCRIPTIONS_DB;
  try {
    const marker = await db.prepare("SELECT value FROM schema_meta WHERE key = 'accounts_seed_v1'").first();
    if (marker) {
      accountsSeedReady = true;
      return { seeded: false, reason: 'already_seeded' };
    }

    const subscriptions = Array.isArray(knownSubscriptions) ? knownSubscriptions : await subRepo.listAll(env);
    const rows = subscriptions
      .filter((sub) => normalizeSerial(sub?.accountSerial) && normalizeAccount(sub?.account))
      .slice()
      .sort((a, b) => {
        const aTime = Date.parse(a.updatedAt || a.createdAt || '') || 0;
        const bTime = Date.parse(b.updatedAt || b.createdAt || '') || 0;
        return bTime - aTime;
      });

    let imported = 0;
    let skipped = 0;
    const seenSerials = new Set();
    const seenAccounts = new Set();
    for (const sub of rows) {
      const serial = normalizeSerial(sub.accountSerial);
      const account = normalizeAccount(sub.account);
      if (seenSerials.has(serial) || seenAccounts.has(account)) {
        skipped += 1;
        continue;
      }
      const result = await syncFromSubscription(env, sub, {
        action: 'initial_import',
        metadata: { seed: 'accounts_seed_v1' },
        syncPassword: true
      });
      if (result.success && !result.skipped) {
        imported += 1;
        seenSerials.add(serial);
        seenAccounts.add(account);
      } else {
        skipped += 1;
      }
    }

    await db.prepare(`
      INSERT INTO schema_meta (key, value, updated_at)
      VALUES ('accounts_seed_v1', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).bind(JSON.stringify({ imported, skipped }), new Date().toISOString()).run();
    accountsSeedReady = true;
    console.log(`[d1] 已从订阅抽取 ${imported} 条账号记录，跳过 ${skipped} 条冲突/空记录`);
    return { seeded: true, imported, skipped };
  } catch (error) {
    console.error('[accounts] 初始化账号数据库失败，请确认已执行 0002_accounts_database.sql:', error);
    return { seeded: false, reason: 'seed_failed' };
  }
}

/**
 * 备份用：导出全部账号（含密文，调用方决定是否解密）。
 * @param {any} env
 */
export async function listAllRaw(env) {
  if (!hasAccountsDb(env)) return [];
  try {
    await ensureD1Schema(env);
    const result = await env.SUBSCRIPTIONS_DB.prepare(`
      SELECT account_serial, account, password_encrypted, source_subscription_id, created_at, updated_at
      FROM accounts ORDER BY account_serial COLLATE NOCASE ASC
    `).all();
    return (result.results || []).map(mapRow).filter(Boolean);
  } catch (error) {
    console.error('[accounts] 导出账号库失败:', error);
    return [];
  }
}

/**
 * 恢复账号库。passwordEncrypted 必须已经用目标环境密钥加密。
 * @param {any} env
 * @param {any[]} accounts
 * @param {{ replace?: boolean }} [options]
 */
export async function restoreAccounts(env, accounts, options = {}) {
  if (!hasAccountsDb(env)) return { success: false, imported: 0, message: 'D1 数据库未绑定' };
  await ensureD1Schema(env);
  const db = env.SUBSCRIPTIONS_DB;
  try {
    if (options.replace) await db.prepare('DELETE FROM accounts').run();
    let imported = 0;
    for (const item of Array.isArray(accounts) ? accounts : []) {
      const serial = normalizeSerial(item?.accountSerial);
      const account = normalizeAccount(item?.account);
      if (!serial || !account) continue;
      const result = await upsert(env, {
        accountSerial: serial,
        account,
        passwordEncrypted: String(item.passwordEncrypted || ''),
        sourceSubscriptionId: String(item.sourceSubscriptionId || '')
      }, { action: 'restore' });
      if (result.success) imported += 1;
    }
    return { success: true, imported };
  } catch (error) {
    return { success: false, imported: 0, message: error?.message || String(error) };
  }
}
