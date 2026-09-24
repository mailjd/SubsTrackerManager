// @ts-check
/**
 * Database 全覆盖导入备份。
 * 每次 destructive replace 前保存 accounts + account_credentials 的完整加密快照，
 * 并仅保留最近 2 个版本。备份中的密码仍然是 AES-GCM 密文，不保存明文。
 */

import { ensureD1Schema } from './d1-schema.js';

const KEEP_BACKUPS = 2;

function nowIso() { return new Date().toISOString(); }

/** @param {any} env */
export async function createAccountDatabaseBackup(env, options = {}) {
  await ensureD1Schema(env);
  const db = env.SUBSCRIPTIONS_DB;
  const [accountsResult, credentialsResult] = await Promise.all([
    db.prepare(`SELECT account_serial, account, password_encrypted, source_subscription_id,
      created_at, updated_at, real_name, account_type
      FROM accounts ORDER BY account_serial COLLATE NOCASE ASC, account COLLATE NOCASE ASC`).all(),
    db.prepare(`SELECT c.account, a.account_serial, c.credential_type, c.password_encrypted, c.created_at, c.updated_at
      FROM account_credentials c
      JOIN accounts a ON a.account = c.account
      ORDER BY a.account_serial COLLATE NOCASE ASC, c.account COLLATE NOCASE ASC, c.credential_type ASC`).all()
  ]);
  const accounts = accountsResult.results || [];
  const credentials = credentialsResult.results || [];
  const createdAt = nowIso();
  const snapshot = {
    format: 'substracker-account-database-backup',
    version: 2,
    createdAt,
    accounts,
    credentials
  };
  const inserted = await db.prepare(`
    INSERT INTO account_database_backups (created_at, reason, account_count, source_filename, snapshot_json)
    VALUES (?, ?, ?, ?, ?)
  `).bind(
    createdAt,
    String(options.reason || 'full_overwrite_import'),
    accounts.length,
    String(options.sourceFilename || ''),
    JSON.stringify(snapshot)
  ).run();

  await db.prepare(`
    DELETE FROM account_database_backups
    WHERE backup_id NOT IN (
      SELECT backup_id FROM account_database_backups
      ORDER BY created_at DESC, backup_id DESC
      LIMIT ${KEEP_BACKUPS}
    )
  `).run();

  return {
    backupId: Number(inserted.meta?.last_row_id || 0),
    createdAt,
    accountCount: accounts.length,
    sourceFilename: String(options.sourceFilename || '')
  };
}

/** @param {any} env */
export async function listAccountDatabaseBackups(env) {
  await ensureD1Schema(env);
  const result = await env.SUBSCRIPTIONS_DB.prepare(`
    SELECT backup_id, created_at, reason, account_count, source_filename
    FROM account_database_backups
    ORDER BY created_at DESC, backup_id DESC
    LIMIT ${KEEP_BACKUPS}
  `).all();
  return (result.results || []).map((row) => ({
    backupId: Number(row.backup_id || 0),
    createdAt: String(row.created_at || ''),
    reason: String(row.reason || ''),
    accountCount: Number(row.account_count || 0),
    sourceFilename: String(row.source_filename || '')
  }));
}

/** @param {any} env @param {number} backupId */
export async function getAccountDatabaseBackup(env, backupId) {
  await ensureD1Schema(env);
  const row = await env.SUBSCRIPTIONS_DB.prepare(`
    SELECT backup_id, created_at, reason, account_count, source_filename, snapshot_json
    FROM account_database_backups WHERE backup_id = ?
  `).bind(Number(backupId)).first();
  if (!row) return null;
  let snapshot = null;
  try { snapshot = JSON.parse(String(row.snapshot_json || '{}')); } catch { snapshot = null; }
  if (!snapshot || !Array.isArray(snapshot.accounts) || !Array.isArray(snapshot.credentials)) return null;
  return {
    backupId: Number(row.backup_id || 0),
    createdAt: String(row.created_at || ''),
    reason: String(row.reason || ''),
    accountCount: Number(row.account_count || 0),
    sourceFilename: String(row.source_filename || ''),
    snapshot
  };
}

/**
 * 恢复已读取的快照对象。
 * @param {any} env
 * @param {any} snapshot
 */
export async function restoreAccountDatabaseSnapshot(env, snapshot) {
  if (!snapshot || !Array.isArray(snapshot.accounts) || !Array.isArray(snapshot.credentials)) {
    return { success: false, message: '备份快照无效或已损坏' };
  }
  const db = env.SUBSCRIPTIONS_DB;
  const accounts = snapshot.accounts;
  const credentials = snapshot.credentials;

  try {
    await db.batch([
      db.prepare('DELETE FROM account_credentials'),
      db.prepare('DELETE FROM accounts')
    ]);

    for (const row of accounts) {
      await db.prepare(`
        INSERT INTO accounts (
          account, account_serial, password_encrypted, source_subscription_id,
          created_at, updated_at, real_name, account_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        String(row.account || ''), String(row.account_serial || ''), String(row.password_encrypted || ''),
        row.source_subscription_id ? String(row.source_subscription_id) : null,
        String(row.created_at || nowIso()), String(row.updated_at || nowIso()),
        String(row.real_name || ''), String(row.account_type || '')
      ).run();
    }

    for (const row of credentials) {
      let account = String(row.account || '');
      // 兼容 v1 备份：旧凭据只记录 account_serial，当时序号必然唯一。
      if (!account && row.account_serial) {
        const owner = accounts.find((item) => String(item.account_serial || '') === String(row.account_serial || ''));
        account = owner ? String(owner.account || '') : '';
      }
      if (!account) continue;
      await db.prepare(`
        INSERT INTO account_credentials (account, credential_type, password_encrypted, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        account, String(row.credential_type || ''), String(row.password_encrypted || ''),
        String(row.created_at || nowIso()), String(row.updated_at || nowIso())
      ).run();
    }
    return { success: true, restored: accounts.length };
  } catch (error) {
    console.error('[account-backup] 恢复失败:', error);
    return { success: false, message: error?.message || String(error) };
  }
}

/**
 * 恢复指定备份 ID。
 * @param {any} env
 * @param {number} backupId
 */
export async function restoreAccountDatabaseBackup(env, backupId, preloadedBackup = null) {
  const backup = preloadedBackup || await getAccountDatabaseBackup(env, backupId);
  if (!backup) return { success: false, message: '备份不存在或已损坏' };
  const result = await restoreAccountDatabaseSnapshot(env, backup.snapshot);
  return result.success ? { ...result, backup } : result;
}
