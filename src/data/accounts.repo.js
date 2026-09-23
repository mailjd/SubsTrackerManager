// @ts-check
/**
 * D1 独立账号数据库。
 *
 * 数据模型：
 * - accounts：账号序号、账号、实名人、账号类型等账号资料。
 * - account_credentials：按工具独立保存 AES-GCM 密文，并以唯一账号(account)关联。
 *   当前工具：Tapnow / 即梦 / 微信 / QQ；另保留 legacy 槽位兼容旧版单一密码。
 *
 * 账号默认仍是一对一映射；仅“配音供应商”允许多个不同账号共用同一个账号序号。
 * 账号(account)始终保持唯一，避免重复建立同一登录账号。
 */

import * as subRepo from './subscriptions.repo.js';
import { recordSubscriptionChange } from './subscription-history.repo.js';
import { ensureD1Schema } from './d1-schema.js';

export const ACCOUNT_CREDENTIAL_TYPES = ['tapnow', 'jimeng', 'wechat', 'qq'];
const ALL_CREDENTIAL_TYPES = [...ACCOUNT_CREDENTIAL_TYPES, 'legacy'];
export const DUPLICATE_SERIAL_EXCEPTIONS = ['配音供应商'];

let accountsSeedReady = false;

/** @param {any} env */
export function hasAccountsDb(env) {
  return !!(env && env.SUBSCRIPTIONS_DB && typeof env.SUBSCRIPTIONS_DB.prepare === 'function');
}

function normalizeSerial(value) { return String(value || '').trim(); }
function normalizeAccount(value) { return String(value || '').trim(); }
function normalizeText(value) { return String(value || '').trim(); }

export function isDuplicateSerialAllowed(serial) {
  return DUPLICATE_SERIAL_EXCEPTIONS.includes(normalizeSerial(serial));
}

function emptyCredentialMap() {
  return { tapnow: '', jimeng: '', wechat: '', qq: '', legacy: '' };
}

function credentialStatusFromMap(map = {}) {
  return {
    tapnow: !!map.tapnow,
    jimeng: !!map.jimeng,
    wechat: !!map.wechat,
    qq: !!map.qq,
    legacy: !!map.legacy
  };
}

function anyCredential(status = {}) {
  return !!(status.tapnow || status.jimeng || status.wechat || status.qq || status.legacy);
}

function mapBaseRow(row) {
  if (!row) return null;
  return {
    accountSerial: String(row.account_serial || ''),
    account: String(row.account || ''),
    realName: String(row.real_name || ''),
    accountType: String(row.account_type || ''),
    legacyPasswordEncrypted: String(row.password_encrypted || ''),
    sourceSubscriptionId: row.source_subscription_id ? String(row.source_subscription_id) : '',
    createdAt: row.created_at ? String(row.created_at) : '',
    updatedAt: row.updated_at ? String(row.updated_at) : ''
  };
}

/** @param {any} env @param {string} account */
async function loadCredentialMap(env, account) {
  const map = emptyCredentialMap();
  const value = normalizeAccount(account);
  if (!value) return map;
  try {
    const result = await env.SUBSCRIPTIONS_DB.prepare(`
      SELECT credential_type, password_encrypted
      FROM account_credentials
      WHERE account = ?
    `).bind(value).all();
    for (const row of result.results || []) {
      const type = String(row.credential_type || '');
      if (ALL_CREDENTIAL_TYPES.includes(type)) map[type] = String(row.password_encrypted || '');
    }
  } catch (error) {
    console.error('[accounts] 读取账号凭据失败:', error);
  }
  return map;
}

/** @param {any} env @param {any} base */
async function hydrateRow(env, base) {
  const mapped = mapBaseRow(base);
  if (!mapped) return null;
  const credentialsEncrypted = await loadCredentialMap(env, mapped.account);
  if (!credentialsEncrypted.legacy && mapped.legacyPasswordEncrypted) {
    credentialsEncrypted.legacy = mapped.legacyPasswordEncrypted;
  }
  const credentialStatus = credentialStatusFromMap(credentialsEncrypted);
  return {
    ...mapped,
    credentialsEncrypted,
    credentialStatus,
    hasPassword: anyCredential(credentialStatus),
    hasLegacyPassword: credentialStatus.legacy,
    passwordEncrypted: credentialsEncrypted.legacy || mapped.legacyPasswordEncrypted || ''
  };
}

function safeRow(row) {
  if (!row) return null;
  const {
    credentialsEncrypted: _credentialsEncrypted,
    legacyPasswordEncrypted: _legacyPasswordEncrypted,
    passwordEncrypted: _passwordEncrypted,
    ...safe
  } = row;
  return safe;
}

/** @param {D1Database} db @param {string} action @param {any} row @param {any} [metadata] */
function buildHistoryStatement(db, action, row, metadata = {}) {
  const accountSerial = normalizeSerial(row?.accountSerial || row?.account_serial);
  const account = normalizeAccount(row?.account);
  const realName = normalizeText(row?.realName || row?.real_name);
  const accountType = normalizeText(row?.accountType || row?.account_type);
  const status = row?.credentialStatus || credentialStatusFromMap(row?.credentialsEncrypted || {
    legacy: row?.passwordEncrypted || row?.password_encrypted || ''
  });
  const enrichedMetadata = {
    ...metadata,
    realName,
    accountType,
    credentialStatus: status
  };
  return db.prepare(`
    INSERT INTO account_history (
      account_serial, action, changed_at, account, has_password, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    accountSerial,
    action || 'update',
    new Date().toISOString(),
    account,
    anyCredential(status) ? 1 : 0,
    JSON.stringify(enrichedMetadata)
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
      SELECT account_serial, account, real_name, account_type, password_encrypted,
             source_subscription_id, created_at, updated_at
      FROM accounts
      WHERE account_serial = ?
      ORDER BY updated_at DESC, account COLLATE NOCASE ASC
      LIMIT 1
    `).bind(value).first();
    return await hydrateRow(env, row);
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
      SELECT account_serial, account, real_name, account_type, password_encrypted,
             source_subscription_id, created_at, updated_at
      FROM accounts WHERE account = ?
    `).bind(value).first();
    return await hydrateRow(env, row);
  } catch (error) {
    console.error('[accounts] 按账号查询失败:', error);
    return null;
  }
}

/** 返回订阅编辑页双向联动所需映射，不包含任何密码密文。 */
export async function listOptions(env) {
  if (!hasAccountsDb(env)) return [];
  try {
    await ensureD1Schema(env);
    const result = await env.SUBSCRIPTIONS_DB.prepare(`
      SELECT a.account_serial, a.account, a.real_name, a.account_type, a.updated_at,
        EXISTS(SELECT 1 FROM account_credentials c WHERE c.account=a.account AND c.credential_type='tapnow' AND c.password_encrypted<>'') AS has_tapnow,
        EXISTS(SELECT 1 FROM account_credentials c WHERE c.account=a.account AND c.credential_type='jimeng' AND c.password_encrypted<>'') AS has_jimeng,
        EXISTS(SELECT 1 FROM account_credentials c WHERE c.account=a.account AND c.credential_type='wechat' AND c.password_encrypted<>'') AS has_wechat,
        EXISTS(SELECT 1 FROM account_credentials c WHERE c.account=a.account AND c.credential_type='qq' AND c.password_encrypted<>'') AS has_qq,
        (a.password_encrypted<>'' OR EXISTS(SELECT 1 FROM account_credentials c WHERE c.account=a.account AND c.credential_type='legacy' AND c.password_encrypted<>'')) AS has_legacy
      FROM accounts a
      ORDER BY a.account_serial COLLATE NOCASE ASC, a.account COLLATE NOCASE ASC
      LIMIT 5000
    `).all();
    return (result.results || []).map((row) => {
      const credentialStatus = {
        tapnow: Number(row.has_tapnow || 0) === 1,
        jimeng: Number(row.has_jimeng || 0) === 1,
        wechat: Number(row.has_wechat || 0) === 1,
        qq: Number(row.has_qq || 0) === 1,
        legacy: Number(row.has_legacy || 0) === 1
      };
      return {
        accountSerial: String(row.account_serial || ''),
        account: String(row.account || ''),
        realName: String(row.real_name || ''),
        accountType: String(row.account_type || ''),
        credentialStatus,
        hasPassword: anyCredential(credentialStatus),
        updatedAt: row.updated_at ? String(row.updated_at) : ''
      };
    });
  } catch (error) {
    console.error('[accounts] 读取账号选项失败:', error);
    return [];
  }
}

/** 分页查询账号库。 */
export async function listPaged(env, options = {}) {
  if (!hasAccountsDb(env)) return { items: [], total: 0, page: 1, pageSize: 20, totalPages: 0 };
  await ensureD1Schema(env);
  const pageSize = Math.min(100, Math.max(10, Number(options.pageSize) || 20));
  const page = Math.max(1, Number(options.page) || 1);
  const q = String(options.q || '').trim();
  const sortMap = {
    accountSerial: 'a.account_serial',
    account: 'a.account',
    realName: 'a.real_name',
    accountType: 'a.account_type',
    tapnow: 'has_tapnow',
    jimeng: 'has_jimeng',
    wechat: 'has_wechat',
    qq: 'has_qq',
    updatedAt: 'a.updated_at'
  };
  const sortKey = Object.prototype.hasOwnProperty.call(sortMap, options.sortKey) ? options.sortKey : 'updatedAt';
  const sortDir = String(options.sortDir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const numericSort = ['tapnow', 'jimeng', 'wechat', 'qq'].includes(sortKey);
  const sortSql = sortKey === 'updatedAt' || numericSort
    ? `${sortMap[sortKey]} ${sortDir}, a.account_serial COLLATE NOCASE ASC, a.account COLLATE NOCASE ASC`
    : `${sortMap[sortKey]} COLLATE NOCASE ${sortDir}, a.account_serial COLLATE NOCASE ASC, a.account COLLATE NOCASE ASC`;
  const where = q ? 'WHERE account_serial LIKE ? OR account LIKE ? OR real_name LIKE ? OR account_type LIKE ?' : '';
  const binds = q ? [`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`] : [];
  const countStmt = env.SUBSCRIPTIONS_DB.prepare(`SELECT COUNT(*) AS count FROM accounts ${where}`);
  const countRow = q ? await countStmt.bind(...binds).first() : await countStmt.first();
  const total = Number(countRow?.count || 0);
  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
  const safePage = totalPages > 0 ? Math.min(page, totalPages) : 1;
  const offset = (safePage - 1) * pageSize;
  const sql = `
    SELECT a.account_serial, a.account, a.real_name, a.account_type, a.source_subscription_id,
           a.created_at, a.updated_at,
      EXISTS(SELECT 1 FROM account_credentials c WHERE c.account=a.account AND c.credential_type='tapnow' AND c.password_encrypted<>'') AS has_tapnow,
      EXISTS(SELECT 1 FROM account_credentials c WHERE c.account=a.account AND c.credential_type='jimeng' AND c.password_encrypted<>'') AS has_jimeng,
      EXISTS(SELECT 1 FROM account_credentials c WHERE c.account=a.account AND c.credential_type='wechat' AND c.password_encrypted<>'') AS has_wechat,
      EXISTS(SELECT 1 FROM account_credentials c WHERE c.account=a.account AND c.credential_type='qq' AND c.password_encrypted<>'') AS has_qq,
      (a.password_encrypted<>'' OR EXISTS(SELECT 1 FROM account_credentials c WHERE c.account=a.account AND c.credential_type='legacy' AND c.password_encrypted<>'')) AS has_legacy
    FROM accounts a
    ${where}
    ORDER BY ${sortSql}
    LIMIT ? OFFSET ?
  `;
  const stmt = env.SUBSCRIPTIONS_DB.prepare(sql);
  const result = q ? await stmt.bind(...binds, pageSize, offset).all() : await stmt.bind(pageSize, offset).all();
  return {
    items: (result.results || []).map((row) => {
      const credentialStatus = {
        tapnow: Number(row.has_tapnow || 0) === 1,
        jimeng: Number(row.has_jimeng || 0) === 1,
        wechat: Number(row.has_wechat || 0) === 1,
        qq: Number(row.has_qq || 0) === 1,
        legacy: Number(row.has_legacy || 0) === 1
      };
      return {
        accountSerial: String(row.account_serial || ''),
        account: String(row.account || ''),
        realName: String(row.real_name || ''),
        accountType: String(row.account_type || ''),
        credentialStatus,
        hasPassword: anyCredential(credentialStatus),
        hasLegacyPassword: credentialStatus.legacy,
        sourceSubscriptionId: row.source_subscription_id ? String(row.source_subscription_id) : '',
        createdAt: row.created_at ? String(row.created_at) : '',
        updatedAt: row.updated_at ? String(row.updated_at) : ''
      };
    }),
    total,
    page: safePage,
    pageSize,
    totalPages
  };
}

/** 检查账号映射冲突：账号始终唯一；“配音供应商”允许账号序号重复。 */
export async function validatePair(env, serial, account, excludeAccount = '') {
  if (!hasAccountsDb(env)) return { ok: true, reason: 'd1_not_bound' };
  const normalizedSerial = normalizeSerial(serial);
  const normalizedAccount = normalizeAccount(account);
  const excluded = normalizeAccount(excludeAccount);
  if (!normalizedSerial && !normalizedAccount) return { ok: true, reason: 'empty' };
  if (!normalizedSerial || !normalizedAccount) return { ok: false, message: '账号序号和账号必须同时填写' };
  try {
    if (!isDuplicateSerialAllowed(normalizedSerial)) {
      const serialRow = await getBySerial(env, normalizedSerial);
      if (serialRow && serialRow.account !== normalizedAccount && serialRow.account !== excluded) {
        return { ok: false, message: `账号序号 ${normalizedSerial} 已绑定账号 ${serialRow.account}` };
      }
    }
    const accountRow = await getByAccount(env, normalizedAccount);
    if (accountRow && accountRow.account !== excluded && accountRow.accountSerial !== normalizedSerial) {
      return { ok: false, message: `账号 ${normalizedAccount} 已绑定账号序号 ${accountRow.accountSerial}` };
    }
    return { ok: true };
  } catch (error) {
    console.error('[accounts] 校验账号映射失败:', error);
    return { ok: true, reason: 'accounts_table_unavailable' };
  }
}

function mergeCredentials(existingMap, updates) {
  const next = { ...emptyCredentialMap(), ...(existingMap || {}) };
  if (updates && typeof updates === 'object') {
    for (const type of ALL_CREDENTIAL_TYPES) {
      if (Object.prototype.hasOwnProperty.call(updates, type)) next[type] = String(updates[type] || '');
    }
  }
  return next;
}

function credentialStatements(db, account, credentialsEncrypted, createdAt, updatedAt) {
  const statements = [];
  for (const type of ALL_CREDENTIAL_TYPES) {
    const encrypted = String(credentialsEncrypted?.[type] || '');
    if (encrypted) {
      statements.push(db.prepare(`
        INSERT INTO account_credentials (account, credential_type, password_encrypted, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(account, credential_type) DO UPDATE SET
          password_encrypted=excluded.password_encrypted,
          updated_at=excluded.updated_at
      `).bind(account, type, encrypted, createdAt, updatedAt));
    } else {
      statements.push(db.prepare('DELETE FROM account_credentials WHERE account=? AND credential_type=?').bind(account, type));
    }
  }
  return statements;
}

/** 新增/同步账号。账号(account)是唯一实体标识。 */
export async function upsert(env, data, options = {}) {
  if (!hasAccountsDb(env)) return { success: true, skipped: true, reason: 'd1_not_bound' };
  await ensureD1Schema(env);
  const accountSerial = normalizeSerial(data.accountSerial);
  const account = normalizeAccount(data.account);
  if (!accountSerial && !account) return { success: true, skipped: true, reason: 'empty' };
  if (!accountSerial || !account) return { success: false, message: '账号序号和账号必须同时填写' };
  const check = await validatePair(env, accountSerial, account, account);
  if (!check.ok) return { success: false, message: check.message };

  const existingByAccount = await getByAccount(env, account);
  const existingBySerial = isDuplicateSerialAllowed(accountSerial) ? null : await getBySerial(env, accountSerial);
  const existing = existingByAccount || existingBySerial;
  if (existingBySerial && existingBySerial.account !== account) {
    return { success: false, message: `账号序号 ${accountSerial} 已绑定账号 ${existingBySerial.account}` };
  }

  const now = new Date().toISOString();
  const createdAt = existing?.createdAt || now;
  const realName = data.realName !== undefined ? normalizeText(data.realName) : (existing?.realName || '');
  const accountType = data.accountType !== undefined ? normalizeText(data.accountType) : (existing?.accountType || '');
  const sourceSubscriptionId = String(data.sourceSubscriptionId || existing?.sourceSubscriptionId || '');
  const credentialUpdates = { ...(data.credentialsEncrypted || {}) };
  if (data.legacyPasswordEncrypted !== undefined) credentialUpdates.legacy = String(data.legacyPasswordEncrypted || '');
  if (data.passwordEncrypted !== undefined) credentialUpdates.legacy = String(data.passwordEncrypted || '');
  const credentialsEncrypted = mergeCredentials(existing?.credentialsEncrypted, credentialUpdates);
  const status = credentialStatusFromMap(credentialsEncrypted);
  const db = env.SUBSCRIPTIONS_DB;

  try {
    await db.prepare(`
      INSERT INTO accounts (
        account, account_serial, password_encrypted, source_subscription_id, created_at, updated_at, real_name, account_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account) DO UPDATE SET
        account_serial=excluded.account_serial,
        password_encrypted=excluded.password_encrypted,
        source_subscription_id=excluded.source_subscription_id,
        updated_at=excluded.updated_at,
        real_name=excluded.real_name,
        account_type=excluded.account_type
    `).bind(account, accountSerial, credentialsEncrypted.legacy || '', sourceSubscriptionId || null, createdAt, now, realName, accountType).run();

    await db.batch([
      ...credentialStatements(db, account, credentialsEncrypted, createdAt, now),
      buildHistoryStatement(db, options.action || (existing ? 'sync' : 'create'), {
        accountSerial, account, realName, accountType, credentialsEncrypted, credentialStatus: status
      }, options.metadata || {})
    ]);

    return {
      success: true,
      account: { accountSerial, account, realName, accountType, credentialStatus: status, hasPassword: anyCredential(status), createdAt, updatedAt: now }
    };
  } catch (error) {
    console.error('[accounts] 保存账号失败:', error);
    return { success: false, message: '保存账号失败: ' + (error?.message || String(error)) };
  }
}

/** 从订阅同步账号库；旧订阅单一密码只进入 legacy 槽位。 */
export async function syncFromSubscription(env, subscription, options = {}) {
  if (!subscription) return { success: true, skipped: true, reason: 'empty_subscription' };
  const payload = {
    accountSerial: subscription.accountSerial || '',
    account: subscription.account || '',
    sourceSubscriptionId: subscription.id || ''
  };
  if (options.syncPassword !== false && subscription.passwordEncrypted) {
    payload.legacyPasswordEncrypted = subscription.passwordEncrypted;
  }
  return upsert(env, payload, {
    action: options.action || 'subscription_sync',
    metadata: { source: 'subscription', ...(options.metadata || {}) }
  });
}

/** 修改账号资料，并把账号/序号同步到该账号关联订阅。 */
export async function updateAndPropagate(env, originalAccount, data) {
  if (!hasAccountsDb(env)) return { success: false, message: 'D1 数据库未绑定' };
  await ensureD1Schema(env);
  const originalKey = normalizeAccount(originalAccount);
  let current = await getByAccount(env, originalKey);
  if (!current) current = await getBySerial(env, originalKey); // 兼容旧调用
  if (!current) return { success: false, message: '账号记录不存在' };

  const oldSerial = current.accountSerial;
  const oldAccount = current.account;
  const newSerial = normalizeSerial(data.accountSerial);
  const newAccount = normalizeAccount(data.account);
  if (!newSerial || !newAccount) return { success: false, message: '账号序号和账号不能为空' };
  const check = await validatePair(env, newSerial, newAccount, oldAccount);
  if (!check.ok) return { success: false, message: check.message };

  const otherAccountRow = await getByAccount(env, newAccount);
  if (otherAccountRow && otherAccountRow.account !== oldAccount) {
    return { success: false, message: `账号 ${newAccount} 已存在` };
  }
  if (!isDuplicateSerialAllowed(newSerial)) {
    const serialRow = await getBySerial(env, newSerial);
    if (serialRow && serialRow.account !== oldAccount) {
      return { success: false, message: `账号序号 ${newSerial} 已存在` };
    }
  }

  const realName = data.realName !== undefined ? normalizeText(data.realName) : current.realName;
  const accountType = data.accountType !== undefined ? normalizeText(data.accountType) : current.accountType;
  const credentialUpdates = { ...(data.credentialsEncrypted || {}) };
  if (data.legacyPasswordEncrypted !== undefined) credentialUpdates.legacy = String(data.legacyPasswordEncrypted || '');
  if (data.passwordEncrypted !== undefined) credentialUpdates.legacy = String(data.passwordEncrypted || '');
  const credentialsEncrypted = mergeCredentials(current.credentialsEncrypted, credentialUpdates);
  const status = credentialStatusFromMap(credentialsEncrypted);
  const now = new Date().toISOString();
  const db = env.SUBSCRIPTIONS_DB;

  try {
    await db.prepare(`UPDATE accounts
      SET account_serial=?, account=?, password_encrypted=?, real_name=?, account_type=?, updated_at=?
      WHERE account=?`)
      .bind(newSerial, newAccount, credentialsEncrypted.legacy || '', realName, accountType, now, oldAccount).run();

    // 新结构使用 account 作为账号记录/凭据的唯一标识。D1 外键开启时会 ON UPDATE CASCADE；
    // 这里再做一次兼容性更新，覆盖旧环境或外键未开启的情况。
    if (newAccount !== oldAccount) {
      try {
        await db.prepare('UPDATE account_credentials SET account=? WHERE account=?')
          .bind(newAccount, oldAccount).run();
      } catch (credentialKeyError) {
        console.warn('[accounts] 凭据账号键兼容更新跳过:', credentialKeyError?.message || credentialKeyError);
      }
    }

    await db.batch([
      ...credentialStatements(db, newAccount, credentialsEncrypted, current.createdAt || now, now),
      buildHistoryStatement(db, 'update', {
        accountSerial: newSerial, account: newAccount, realName, accountType, credentialsEncrypted, credentialStatus: status
      }, { previousSerial: oldSerial, previousAccount: oldAccount })
    ]);

    const subscriptions = await subRepo.listAll(env);
    const affected = subscriptions.filter((sub) => {
      const serial = normalizeSerial(sub.accountSerial);
      const account = normalizeAccount(sub.account);
      if (account === oldAccount) return true;
      if (!isDuplicateSerialAllowed(oldSerial) && serial === oldSerial) return true;
      return serial === '' && account === oldAccount;
    });

    let syncedSubscriptions = 0;
    let syncFailures = 0;
    for (const sub of affected) {
      const { passwordEncrypted: _legacyPasswordEncrypted, password: _legacyPassword, ...subscriptionWithoutPassword } = sub;
      const updated = { ...subscriptionWithoutPassword, accountSerial: newSerial, account: newAccount, updatedAt: new Date().toISOString() };
      try {
        await subRepo.save(env, updated);
        await recordSubscriptionChange(env, 'account_database_sync', updated, {
          source: 'accounts_database', previousSerial: oldSerial, accountSerial: newSerial, previousAccount: oldAccount, account: newAccount
        });
        syncedSubscriptions += 1;
      } catch (syncError) {
        syncFailures += 1;
        console.error('[accounts] 同步关联订阅失败:', sub.id, syncError);
      }
    }

    return {
      success: true,
      account: { accountSerial: newSerial, account: newAccount, realName, accountType, credentialStatus: status, hasPassword: anyCredential(status), updatedAt: now },
      affectedSubscriptions: syncedSubscriptions,
      syncFailures
    };
  } catch (error) {
    console.error('[accounts] 更新并同步账号失败:', error);
    return { success: false, message: '更新账号失败: ' + (error?.message || String(error)) };
  }
}

export async function countLinkedSubscriptions(env, accountOrSerial) {
  const key = normalizeText(accountOrSerial);
  if (!key) return 0;
  const existing = await getByAccount(env, key) || await getBySerial(env, key);
  if (!existing) return 0;

  let d1Count = 0;
  if (hasAccountsDb(env)) {
    try {
      const row = await env.SUBSCRIPTIONS_DB.prepare(
        'SELECT COUNT(*) AS count FROM subscriptions_current WHERE account=? AND account_serial=?'
      ).bind(existing.account, existing.accountSerial).first();
      d1Count = Number(row?.count || 0);
    } catch { d1Count = 0; }
  }
  const subs = await subRepo.listAll(env);
  const kvCount = subs.filter((sub) =>
    normalizeAccount(sub.account) === existing.account &&
    normalizeSerial(sub.accountSerial) === existing.accountSerial
  ).length;
  return Math.max(d1Count, kvCount);
}

export async function deleteAccount(env, accountOrSerial) {
  if (!hasAccountsDb(env)) return { success: false, message: 'D1 数据库未绑定' };
  const key = normalizeText(accountOrSerial);
  const existing = await getByAccount(env, key) || await getBySerial(env, key);
  if (!existing) return { success: false, message: '账号记录不存在' };
  const linked = await countLinkedSubscriptions(env, existing.account);
  if (linked > 0) return { success: false, message: `该账号仍被 ${linked} 条订阅引用，请先调整关联订阅`, linkedSubscriptions: linked };
  try {
    const db = env.SUBSCRIPTIONS_DB;
    await db.batch([
      db.prepare('DELETE FROM account_credentials WHERE account=?').bind(existing.account),
      db.prepare('DELETE FROM accounts WHERE account=?').bind(existing.account),
      buildHistoryStatement(db, 'delete', existing)
    ]);
    return { success: true };
  } catch (error) {
    console.error('[accounts] 删除账号失败:', error);
    return { success: false, message: '删除账号失败' };
  }
}

/** 首次部署从旧订阅抽取账号；“配音供应商”可重复序号，账号仍唯一。 */
export async function ensureAccountsSeed(env, knownSubscriptions) {
  if (!hasAccountsDb(env)) return { seeded: false, reason: 'd1_not_bound' };
  try { await ensureD1Schema(env); } catch { return { seeded: false, reason: 'schema_init_failed' }; }
  if (accountsSeedReady) return { seeded: false, reason: 'cached' };
  const db = env.SUBSCRIPTIONS_DB;
  try {
    const marker = await db.prepare("SELECT value FROM schema_meta WHERE key='accounts_seed_v1'").first();
    if (marker) { accountsSeedReady = true; return { seeded: false, reason: 'already_seeded' }; }
    const subscriptions = Array.isArray(knownSubscriptions) ? knownSubscriptions : await subRepo.listAll(env);
    const rows = subscriptions.filter((sub) => normalizeSerial(sub?.accountSerial) && normalizeAccount(sub?.account)).slice().sort((a, b) => {
      const aTime = Date.parse(a.updatedAt || a.createdAt || '') || 0;
      const bTime = Date.parse(b.updatedAt || b.createdAt || '') || 0;
      return bTime - aTime;
    });
    let imported = 0; let skipped = 0;
    const seenSerials = new Set(); const seenAccounts = new Set();
    for (const sub of rows) {
      const serial = normalizeSerial(sub.accountSerial); const account = normalizeAccount(sub.account);
      if ((!isDuplicateSerialAllowed(serial) && seenSerials.has(serial)) || seenAccounts.has(account)) { skipped += 1; continue; }
      const result = await syncFromSubscription(env, sub, { action: 'initial_import', metadata: { seed: 'accounts_seed_v1' }, syncPassword: true });
      if (result.success && !result.skipped) {
        imported += 1;
        if (!isDuplicateSerialAllowed(serial)) seenSerials.add(serial);
        seenAccounts.add(account);
      } else skipped += 1;
    }
    await db.prepare(`INSERT INTO schema_meta (key,value,updated_at) VALUES ('accounts_seed_v1',?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
      .bind(JSON.stringify({ imported, skipped }), new Date().toISOString()).run();
    accountsSeedReady = true;
    return { seeded: true, imported, skipped };
  } catch (error) {
    console.error('[accounts] 初始化账号数据库失败:', error);
    return { seeded: false, reason: 'seed_failed' };
  }
}

/** 备份用：导出全部账号（含各工具密文，调用方决定是否解密）。 */
export async function listAllRaw(env) {
  if (!hasAccountsDb(env)) return [];
  try {
    await ensureD1Schema(env);
    const accountsResult = await env.SUBSCRIPTIONS_DB.prepare(`
      SELECT account_serial, account, real_name, account_type, password_encrypted,
             source_subscription_id, created_at, updated_at
      FROM accounts ORDER BY account_serial COLLATE NOCASE ASC, account COLLATE NOCASE ASC
    `).all();
    const credsResult = await env.SUBSCRIPTIONS_DB.prepare(`
      SELECT account, credential_type, password_encrypted FROM account_credentials
    `).all();
    const credMap = new Map();
    for (const row of credsResult.results || []) {
      const account = String(row.account || '');
      if (!credMap.has(account)) credMap.set(account, emptyCredentialMap());
      const type = String(row.credential_type || '');
      if (ALL_CREDENTIAL_TYPES.includes(type)) credMap.get(account)[type] = String(row.password_encrypted || '');
    }
    return (accountsResult.results || []).map((row) => {
      const base = mapBaseRow(row);
      if (!base) return null;
      const credentialsEncrypted = { ...emptyCredentialMap(), ...(credMap.get(base.account) || {}) };
      if (!credentialsEncrypted.legacy && base.legacyPasswordEncrypted) credentialsEncrypted.legacy = base.legacyPasswordEncrypted;
      const credentialStatus = credentialStatusFromMap(credentialsEncrypted);
      return { ...base, credentialsEncrypted, credentialStatus, hasPassword: anyCredential(credentialStatus), hasLegacyPassword: credentialStatus.legacy };
    }).filter(Boolean);
  } catch (error) {
    console.error('[accounts] 导出账号库失败:', error);
    return [];
  }
}

/** 恢复账号库。credentialsEncrypted 必须已经用目标环境密钥加密。 */
export async function restoreAccounts(env, accounts, options = {}) {
  if (!hasAccountsDb(env)) return { success: false, imported: 0, message: 'D1 数据库未绑定' };
  await ensureD1Schema(env);
  const db = env.SUBSCRIPTIONS_DB;
  try {
    if (options.replace) {
      await db.batch([db.prepare('DELETE FROM account_credentials'), db.prepare('DELETE FROM accounts')]);
    }
    let imported = 0;
    for (const item of Array.isArray(accounts) ? accounts : []) {
      const serial = normalizeSerial(item?.accountSerial); const account = normalizeAccount(item?.account);
      if (!serial || !account) continue;
      const credentialsEncrypted = item?.credentialsEncrypted && typeof item.credentialsEncrypted === 'object'
        ? item.credentialsEncrypted : {};
      const result = await upsert(env, {
        accountSerial: serial,
        account,
        realName: item.realName || '',
        accountType: item.accountType || '',
        credentialsEncrypted,
        legacyPasswordEncrypted: item.legacyPasswordEncrypted ?? item.passwordEncrypted ?? '',
        sourceSubscriptionId: String(item.sourceSubscriptionId || '')
      }, { action: 'restore' });
      if (result.success) imported += 1;
    }
    return { success: true, imported };
  } catch (error) {
    return { success: false, imported: 0, message: error?.message || String(error) };
  }
}
