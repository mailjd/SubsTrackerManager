// @ts-check
/**
 * D1 独立账号数据库。
 *
 * 数据模型：
 * - accounts：账号序号、账号、实名人、账号类型等账号资料。
 * - account_credentials：按工具独立保存 AES-GCM 密文。
 *   当前工具：Tapnow / 即梦 / 微信 / QQ；另保留 legacy 槽位兼容旧版单一密码。
 *
 * 订阅记录仍保留 account/accountSerial 快照以兼容旧版本和 KV 主数据，
 * 但账号映射与凭据以本 Database 为统一来源；修改账号库时会同步关联订阅。
 */

import * as subRepo from './subscriptions.repo.js';
import { recordSubscriptionChange } from './subscription-history.repo.js';
import { ensureD1Schema } from './d1-schema.js';

export const ACCOUNT_CREDENTIAL_TYPES = ['tapnow', 'jimeng', 'wechat', 'qq'];
const ALL_CREDENTIAL_TYPES = [...ACCOUNT_CREDENTIAL_TYPES, 'legacy'];

let accountsSeedReady = false;

/** @param {any} env */
export function hasAccountsDb(env) {
  return !!(env && env.SUBSCRIPTIONS_DB && typeof env.SUBSCRIPTIONS_DB.prepare === 'function');
}

function normalizeSerial(value) { return String(value || '').trim(); }
function normalizeAccount(value) { return String(value || '').trim(); }
function normalizeText(value) { return String(value || '').trim(); }

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

/** @param {any} env @param {string} serial */
async function loadCredentialMap(env, serial) {
  const map = emptyCredentialMap();
  const value = normalizeSerial(serial);
  if (!value) return map;
  try {
    const result = await env.SUBSCRIPTIONS_DB.prepare(`
      SELECT credential_type, password_encrypted
      FROM account_credentials
      WHERE account_serial = ?
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
  const credentialsEncrypted = await loadCredentialMap(env, mapped.accountSerial);
  // 若漏跑 0004 migration，仍从旧字段兜底保留 legacy 密文。
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
    // 仅兼容旧调用；新代码应使用 legacyPasswordEncrypted / credentialsEncrypted。
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
      FROM accounts WHERE account_serial = ?
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
    const row = await env.SUBSCRIPTIONS_DB.prepare(`SELECT account_serial FROM accounts WHERE account = ?`).bind(value).first();
    return row ? await getBySerial(env, String(row.account_serial || '')) : null;
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
        EXISTS(SELECT 1 FROM account_credentials c WHERE c.account_serial=a.account_serial AND c.credential_type='tapnow' AND c.password_encrypted<>'') AS has_tapnow,
        EXISTS(SELECT 1 FROM account_credentials c WHERE c.account_serial=a.account_serial AND c.credential_type='jimeng' AND c.password_encrypted<>'') AS has_jimeng,
        EXISTS(SELECT 1 FROM account_credentials c WHERE c.account_serial=a.account_serial AND c.credential_type='wechat' AND c.password_encrypted<>'') AS has_wechat,
        EXISTS(SELECT 1 FROM account_credentials c WHERE c.account_serial=a.account_serial AND c.credential_type='qq' AND c.password_encrypted<>'') AS has_qq,
        (a.password_encrypted<>'' OR EXISTS(SELECT 1 FROM account_credentials c WHERE c.account_serial=a.account_serial AND c.credential_type='legacy' AND c.password_encrypted<>'')) AS has_legacy
      FROM accounts a
      ORDER BY a.account_serial COLLATE NOCASE ASC
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
      EXISTS(SELECT 1 FROM account_credentials c WHERE c.account_serial=a.account_serial AND c.credential_type='tapnow' AND c.password_encrypted<>'') AS has_tapnow,
      EXISTS(SELECT 1 FROM account_credentials c WHERE c.account_serial=a.account_serial AND c.credential_type='jimeng' AND c.password_encrypted<>'') AS has_jimeng,
      EXISTS(SELECT 1 FROM account_credentials c WHERE c.account_serial=a.account_serial AND c.credential_type='wechat' AND c.password_encrypted<>'') AS has_wechat,
      EXISTS(SELECT 1 FROM account_credentials c WHERE c.account_serial=a.account_serial AND c.credential_type='qq' AND c.password_encrypted<>'') AS has_qq,
      (a.password_encrypted<>'' OR EXISTS(SELECT 1 FROM account_credentials c WHERE c.account_serial=a.account_serial AND c.credential_type='legacy' AND c.password_encrypted<>'')) AS has_legacy
    FROM accounts a
    ${where}
    ORDER BY a.updated_at DESC, a.account_serial COLLATE NOCASE ASC
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

/** 检查一对一映射冲突。 */
export async function validatePair(env, serial, account, excludeSerial = '') {
  if (!hasAccountsDb(env)) return { ok: true, reason: 'd1_not_bound' };
  const normalizedSerial = normalizeSerial(serial);
  const normalizedAccount = normalizeAccount(account);
  if (!normalizedSerial && !normalizedAccount) return { ok: true, reason: 'empty' };
  if (!normalizedSerial || !normalizedAccount) return { ok: false, message: '账号序号和账号必须同时填写' };
  try {
    const serialRow = await getBySerial(env, normalizedSerial);
    if (serialRow && serialRow.account !== normalizedAccount && normalizedSerial !== excludeSerial) {
      return { ok: false, message: `账号序号 ${normalizedSerial} 已绑定账号 ${serialRow.account}` };
    }
    const accountRow = await getByAccount(env, normalizedAccount);
    if (accountRow && accountRow.accountSerial !== normalizedSerial && accountRow.accountSerial !== excludeSerial) {
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

function credentialStatements(db, accountSerial, credentialsEncrypted, createdAt, updatedAt) {
  const statements = [];
  for (const type of ALL_CREDENTIAL_TYPES) {
    const encrypted = String(credentialsEncrypted?.[type] || '');
    if (encrypted) {
      statements.push(db.prepare(`
        INSERT INTO account_credentials (account_serial, credential_type, password_encrypted, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(account_serial, credential_type) DO UPDATE SET
          password_encrypted=excluded.password_encrypted,
          updated_at=excluded.updated_at
      `).bind(accountSerial, type, encrypted, createdAt, updatedAt));
    } else {
      statements.push(db.prepare('DELETE FROM account_credentials WHERE account_serial=? AND credential_type=?').bind(accountSerial, type));
    }
  }
  return statements;
}

/** 新增/同步账号。 */
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
    const statements = [db.prepare(`
      INSERT INTO accounts (
        account_serial, account, password_encrypted, source_subscription_id, created_at, updated_at, real_name, account_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_serial) DO UPDATE SET
        account=excluded.account,
        password_encrypted=excluded.password_encrypted,
        source_subscription_id=excluded.source_subscription_id,
        updated_at=excluded.updated_at,
        real_name=excluded.real_name,
        account_type=excluded.account_type
    `).bind(accountSerial, account, credentialsEncrypted.legacy || '', sourceSubscriptionId || null, createdAt, now, realName, accountType)];
    statements.push(...credentialStatements(db, accountSerial, credentialsEncrypted, createdAt, now));
    statements.push(buildHistoryStatement(db, options.action || (existing ? 'sync' : 'create'), {
      accountSerial, account, realName, accountType, credentialsEncrypted, credentialStatus: status
    }, options.metadata || {}));
    await db.batch(statements);
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

/** 修改账号资料，并把账号/序号同步到关联订阅。 */
export async function updateAndPropagate(env, originalSerial, data) {
  if (!hasAccountsDb(env)) return { success: false, message: 'D1 数据库未绑定' };
  await ensureD1Schema(env);
  const oldSerial = normalizeSerial(originalSerial);
  const current = await getBySerial(env, oldSerial);
  if (!current) return { success: false, message: '账号记录不存在' };
  const newSerial = normalizeSerial(data.accountSerial);
  const newAccount = normalizeAccount(data.account);
  if (!newSerial || !newAccount) return { success: false, message: '账号序号和账号不能为空' };
  const check = await validatePair(env, newSerial, newAccount, oldSerial);
  if (!check.ok) return { success: false, message: check.message };
  if (newSerial !== oldSerial && await getBySerial(env, newSerial)) return { success: false, message: `账号序号 ${newSerial} 已存在` };

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
    const statements = [
      db.prepare(`UPDATE accounts
        SET account_serial=?, account=?, password_encrypted=?, real_name=?, account_type=?, updated_at=?
        WHERE account_serial=?`)
        .bind(newSerial, newAccount, credentialsEncrypted.legacy || '', realName, accountType, now, oldSerial)
    ];
    if (newSerial !== oldSerial) {
      statements.push(db.prepare('UPDATE account_credentials SET account_serial=? WHERE account_serial=?').bind(newSerial, oldSerial));
    }
    statements.push(...credentialStatements(db, newSerial, credentialsEncrypted, current.createdAt || now, now));
    statements.push(buildHistoryStatement(db, 'update', {
      accountSerial: newSerial, account: newAccount, realName, accountType, credentialsEncrypted, credentialStatus: status
    }, { previousSerial: oldSerial, previousAccount: current.account }));
    await db.batch(statements);

    const subscriptions = await subRepo.listAll(env);
    const affected = subscriptions.filter((sub) => {
      const serial = normalizeSerial(sub.accountSerial);
      const account = normalizeAccount(sub.account);
      return serial === oldSerial || (serial === '' && account === current.account);
    });
    let syncedSubscriptions = 0;
    let syncFailures = 0;
    for (const sub of affected) {
      const { passwordEncrypted: _legacyPasswordEncrypted, password: _legacyPassword, ...subscriptionWithoutPassword } = sub;
      const updated = { ...subscriptionWithoutPassword, accountSerial: newSerial, account: newAccount, updatedAt: new Date().toISOString() };
      try {
        await subRepo.save(env, updated);
        await recordSubscriptionChange(env, 'account_database_sync', updated, {
          source: 'accounts_database', previousSerial: oldSerial, accountSerial: newSerial
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

export async function countLinkedSubscriptions(env, serial) {
  const value = normalizeSerial(serial);
  if (!value) return 0;
  let d1Count = 0;
  if (hasAccountsDb(env)) {
    try {
      const row = await env.SUBSCRIPTIONS_DB.prepare('SELECT COUNT(*) AS count FROM subscriptions_current WHERE account_serial=?').bind(value).first();
      d1Count = Number(row?.count || 0);
    } catch { d1Count = 0; }
  }
  const subs = await subRepo.listAll(env);
  const kvCount = subs.filter((sub) => normalizeSerial(sub.accountSerial) === value).length;
  return Math.max(d1Count, kvCount);
}

export async function deleteAccount(env, serial) {
  if (!hasAccountsDb(env)) return { success: false, message: 'D1 数据库未绑定' };
  const value = normalizeSerial(serial);
  const existing = await getBySerial(env, value);
  if (!existing) return { success: false, message: '账号记录不存在' };
  const linked = await countLinkedSubscriptions(env, value);
  if (linked > 0) return { success: false, message: `该账号仍被 ${linked} 条订阅引用，请先调整关联订阅`, linkedSubscriptions: linked };
  try {
    const db = env.SUBSCRIPTIONS_DB;
    await db.batch([
      db.prepare('DELETE FROM account_credentials WHERE account_serial=?').bind(value),
      db.prepare('DELETE FROM accounts WHERE account_serial=?').bind(value),
      buildHistoryStatement(db, 'delete', existing)
    ]);
    return { success: true };
  } catch (error) {
    console.error('[accounts] 删除账号失败:', error);
    return { success: false, message: '删除账号失败' };
  }
}

/** 首次部署从旧订阅抽取账号；旧单一密码保存在 legacy 槽位。 */
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
      if (seenSerials.has(serial) || seenAccounts.has(account)) { skipped += 1; continue; }
      const result = await syncFromSubscription(env, sub, { action: 'initial_import', metadata: { seed: 'accounts_seed_v1' }, syncPassword: true });
      if (result.success && !result.skipped) { imported += 1; seenSerials.add(serial); seenAccounts.add(account); } else skipped += 1;
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
      FROM accounts ORDER BY account_serial COLLATE NOCASE ASC
    `).all();
    const credsResult = await env.SUBSCRIPTIONS_DB.prepare(`
      SELECT account_serial, credential_type, password_encrypted FROM account_credentials
    `).all();
    const credMap = new Map();
    for (const row of credsResult.results || []) {
      const serial = String(row.account_serial || '');
      if (!credMap.has(serial)) credMap.set(serial, emptyCredentialMap());
      const type = String(row.credential_type || '');
      if (ALL_CREDENTIAL_TYPES.includes(type)) credMap.get(serial)[type] = String(row.password_encrypted || '');
    }
    return (accountsResult.results || []).map((row) => {
      const base = mapBaseRow(row);
      if (!base) return null;
      const credentialsEncrypted = { ...emptyCredentialMap(), ...(credMap.get(base.accountSerial) || {}) };
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
