// @ts-check
/**
 * 配置与数据备份 / 恢复
 *
 * GET  /api/backup?includeSecrets=0|1
 * POST /api/restore  body: { backup, mode: 'merge'|'replace', includeSecrets?: boolean }
 *
 * 设计约束：
 * - 默认导出不含密钥/密码，避免备份文件泄露
 * - JWT_SECRET 永不导出、导入时也不覆盖（避免会话被意外作废；换环境请重新登录）
 * - 订阅 + reminder_rules 一并导出，保证多规则提醒可无损迁移
 */
import { getConfig, setConfig } from '../../data/config.js';
import * as subRepo from '../../data/subscriptions.repo.js';
import * as remindersRepo from '../../data/reminders.repo.js';
import { getCategories } from '../../data/categories.js';
import { getMenuOptions, setMenuOptions } from '../../data/menu-options.js';
import { putKVJson } from '../../data/kv.js';
import { SECRET_FIELDS } from './config.js';
import { VERSION } from './extras.js';
import { decryptCredential, encryptCredential } from '../../core/credentials.js';
import { syncCurrentSubscriptions } from '../../data/subscription-history.repo.js';
import { listAllRaw as listAllAccountsRaw, restoreAccounts, syncFromSubscription } from '../../data/accounts.repo.js';

const BACKUP_FORMAT = 'substracker-backup';
const BACKUP_VERSION = 5;

/** 永不导出/覆盖的字段 */
const NEVER_EXPORT_FIELDS = ['JWT_SECRET', 'ADMIN_PASSWORD', 'CREDENTIALS_ENCRYPTION_KEY', 'SUPERADMIN_PASSWORD_HASH'];

/**
 * @param {any} data
 * @param {number} [status]
 */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * @param {any} config
 * @param {boolean} includeSecrets
 */
function buildExportConfig(config, includeSecrets) {
  /** @type {Record<string, any>} */
  const out = { ...config };
  delete out.JWT_SECRET;
  delete out.CREDENTIALS_ENCRYPTION_KEY;
  delete out.SUPERADMIN_PASSWORD_HASH;

  if (!includeSecrets) {
    delete out.ADMIN_PASSWORD;
    for (const key of SECRET_FIELDS) {
      if (key in out) out[key] = '';
    }
  } else {
    // 即使含密钥，也不导出 JWT_SECRET
    delete out.JWT_SECRET;
  }

  return out;
}

/**
 * GET /api/backup
 *
 * @param {Request} request
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 */
export async function handleExportBackup(request, env) {
  try {
    const url = new URL(request.url);
    const includeSecrets =
      url.searchParams.get('includeSecrets') === '1' ||
      url.searchParams.get('includeSecrets') === 'true';

    const config = await getConfig(env);
    const categories = await getCategories(env);
    const menuOptions = await getMenuOptions(env);
    const subscriptions = await subRepo.listAll(env);

    /** @type {Record<string, any[]>} */
    const reminderRules = {};
    for (const sub of subscriptions) {
      if (!sub || !sub.id) continue;
      let rules = await remindersRepo.listForSubscription(env, sub.id);
      if (rules.length === 0) {
        rules = [remindersRepo.legacyFieldToRule(sub)];
      }
      reminderRules[sub.id] = rules;
    }

    // 导出体不附带运行时附加字段；订阅密码默认不导出。
    // 仅在 includeSecrets=true 时，以明文放入受用户明确确认的敏感备份，
    // 恢复时再用目标环境自己的密钥重新加密。
    const cleanSubs = await Promise.all(subscriptions.map(async (sub) => {
      const {
        reminderRules: _rr,
        reminderRulesSummary: _rs,
        passwordEncrypted,
        password: _password,
        ...rest
      } = sub || {};

      if (includeSecrets && passwordEncrypted) {
        rest.password = await decryptCredential(
          passwordEncrypted,
          config.CREDENTIALS_ENCRYPTION_KEY
        );
      }
      return rest;
    }));

    const rawAccounts = await listAllAccountsRaw(env);
    const cleanAccounts = await Promise.all(rawAccounts.map(async (item) => {
      const { credentialsEncrypted, legacyPasswordEncrypted, passwordEncrypted: _legacyAlias, ...rest } = item || {};
      if (includeSecrets && credentialsEncrypted && typeof credentialsEncrypted === 'object') {
        rest.passwords = {};
        for (const type of ['tapnow', 'jimeng', 'wechat', 'qq']) {
          const encrypted = credentialsEncrypted[type] || '';
          if (encrypted) {
            rest.passwords[type] = await decryptCredential(encrypted, config.CREDENTIALS_ENCRYPTION_KEY);
          }
        }
        const legacyEncrypted = credentialsEncrypted.legacy || legacyPasswordEncrypted || '';
        if (legacyEncrypted) {
          rest.legacyPassword = await decryptCredential(legacyEncrypted, config.CREDENTIALS_ENCRYPTION_KEY);
        }
      }
      return rest;
    }));

    const backup = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      appVersion: VERSION,
      exportedAt: new Date().toISOString(),
      includeSecrets,
      config: buildExportConfig(config, includeSecrets),
      categories,
      menuOptions,
      subscriptions: cleanSubs,
      accounts: cleanAccounts,
      reminderRules
    };

    return new Response(JSON.stringify(backup, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="substracker-backup-${new Date()
          .toISOString()
          .slice(0, 10)}.json"`
      }
    });
  } catch (error) {
    console.error('[backup] 导出失败:', error);
    return json(
      { success: false, message: '导出失败: ' + (error && error.message ? error.message : String(error)) },
      500
    );
  }
}

/**
 * 校验备份结构
 * @param {any} raw
 * @returns {{ ok: true, backup: any } | { ok: false, message: string }}
 */
/**
 * @param {any} sub
 * @param {number} index
 * @returns {string|null} 错误信息
 */
function validateSubscriptionEntry(sub, index) {
  if (!sub || typeof sub !== 'object') {
    return `subscriptions[${index}] 不是对象`;
  }
  if (typeof sub.id !== 'string' || !sub.id.trim()) {
    return `subscriptions[${index}] 缺少有效 id`;
  }
  if (typeof sub.name !== 'string' || !sub.name.trim()) {
    return `subscriptions[${index}] 缺少 name`;
  }
  if (!sub.expiryDate || Number.isNaN(new Date(sub.expiryDate).getTime())) {
    return `subscriptions[${index}] 缺少有效 expiryDate`;
  }
  return null;
}

function validateBackup(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, message: '备份内容不是有效 JSON 对象' };
  }
  if (raw.format && raw.format !== BACKUP_FORMAT) {
    return { ok: false, message: `不支持的备份格式: ${raw.format}` };
  }
  if (raw.version != null && Number(raw.version) > BACKUP_VERSION) {
    return { ok: false, message: `备份版本过高 (${raw.version})，请升级应用后再导入` };
  }
  if (!Array.isArray(raw.subscriptions)) {
    return { ok: false, message: '备份缺少 subscriptions 数组' };
  }
  for (let i = 0; i < raw.subscriptions.length; i++) {
    const err = validateSubscriptionEntry(raw.subscriptions[i], i);
    if (err) return { ok: false, message: err };
  }
  if (raw.menuOptions != null && (typeof raw.menuOptions !== 'object' || Array.isArray(raw.menuOptions))) {
    return { ok: false, message: 'menuOptions 必须是对象' };
  }
  if (raw.accounts != null && !Array.isArray(raw.accounts)) {
    return { ok: false, message: 'accounts 必须是数组' };
  }
  if (Array.isArray(raw.accounts)) {
    for (let i = 0; i < raw.accounts.length; i++) {
      const item = raw.accounts[i];
      if (!item || typeof item !== 'object') return { ok: false, message: `accounts[${i}] 不是对象` };
      if (!String(item.accountSerial || '').trim()) return { ok: false, message: `accounts[${i}] 缺少账号序号` };
      if (!String(item.account || '').trim()) return { ok: false, message: `accounts[${i}] 缺少账号` };
    }
  }
  if (raw.reminderRules != null && typeof raw.reminderRules !== 'object') {
    return { ok: false, message: 'reminderRules 必须是对象' };
  }
  return { ok: true, backup: raw };
}

/**
 * 合并配置：默认不覆盖密钥空值；includeSecrets 时才写入非空密钥
 *
 * @param {any} current
 * @param {any} incoming
 * @param {boolean} includeSecrets
 */
function mergeConfig(current, incoming, includeSecrets) {
  if (!incoming || typeof incoming !== 'object') return current;

  /** @type {Record<string, any>} */
  const next = { ...current };

  for (const [key, value] of Object.entries(incoming)) {
    if (NEVER_EXPORT_FIELDS.includes(key) || key === 'JWT_SECRET') continue;

    if (SECRET_FIELDS.includes(key) || key === 'ADMIN_PASSWORD') {
      if (!includeSecrets) continue;
      if (typeof value === 'string' && value.trim() !== '') {
        next[key] = value;
      }
      continue;
    }

    if (value !== undefined) {
      next[key] = value;
    }
  }

  // 始终保留现有 JWT
  next.JWT_SECRET = current.JWT_SECRET;
  return next;
}

/**
 * POST /api/restore
 *
 * @param {Request} request
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 */
export async function handleImportBackup(request, env) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ success: false, message: '请求体不是合法 JSON' }, 400);
    }

    // 兼容：body 直接是备份，或 { backup, mode, includeSecrets }
    const rawBackup = body && body.backup ? body.backup : body;
    const mode = body && body.mode === 'replace' ? 'replace' : 'merge';
    const includeSecrets = !!(body && body.includeSecrets);

    const validated = validateBackup(rawBackup);
    if (!validated.ok) {
      return json({ success: false, message: /** @type {any} */ (validated).message }, 400);
    }
    const backup = /** @type {any} */ (validated).backup;

    // 先读取当前配置：订阅密码必须使用目标环境自己的密钥重新加密。
    const currentConfig = await getConfig(env);

    // 先写订阅/规则，再写配置：避免配置已改但数据半残
    const incomingSubs = [];
    for (const rawSub of backup.subscriptions.filter((s) => s && typeof s.id === 'string' && s.id)) {
      const sub = { ...rawSub };
      // 永不直接信任/导入其他环境的密文。
      delete sub.passwordEncrypted;

      if (includeSecrets && typeof sub.password === 'string' && sub.password.length > 0) {
        sub.passwordEncrypted = await encryptCredential(
          sub.password,
          currentConfig.CREDENTIALS_ENCRYPTION_KEY
        );
      } else if (!includeSecrets && mode === 'merge') {
        const existingSub = await subRepo.getById(env, sub.id);
        sub.passwordEncrypted = existingSub?.passwordEncrypted || '';
      } else {
        sub.passwordEncrypted = '';
      }
      delete sub.password;
      incomingSubs.push(sub);
    }

    const incomingAccounts = [];
    const existingAccountMap = new Map();
    if (!includeSecrets && mode === 'merge' && Array.isArray(backup.accounts)) {
      const existingAccounts = await listAllAccountsRaw(env);
      for (const item of existingAccounts) existingAccountMap.set(item.accountSerial, item);
    }
    if (Array.isArray(backup.accounts)) {
      for (const rawAccount of backup.accounts) {
        if (!rawAccount || typeof rawAccount !== 'object') continue;
        const accountSerial = String(rawAccount.accountSerial || '').trim();
        const account = String(rawAccount.account || '').trim();
        if (!accountSerial || !account) continue;

        const credentialsEncrypted = {};
        let legacyPasswordEncrypted = '';
        if (includeSecrets) {
          const plainPasswords = rawAccount.passwords && typeof rawAccount.passwords === 'object' ? rawAccount.passwords : {};
          for (const type of ['tapnow', 'jimeng', 'wechat', 'qq']) {
            if (typeof plainPasswords[type] === 'string' && plainPasswords[type].length > 0) {
              credentialsEncrypted[type] = await encryptCredential(plainPasswords[type], currentConfig.CREDENTIALS_ENCRYPTION_KEY);
            }
          }
          const legacyPlain = typeof rawAccount.legacyPassword === 'string' && rawAccount.legacyPassword.length > 0
            ? rawAccount.legacyPassword
            : (typeof rawAccount.password === 'string' ? rawAccount.password : '');
          if (legacyPlain) legacyPasswordEncrypted = await encryptCredential(legacyPlain, currentConfig.CREDENTIALS_ENCRYPTION_KEY);
        } else if (mode === 'merge') {
          const existing = existingAccountMap.get(accountSerial);
          if (existing?.credentialsEncrypted) Object.assign(credentialsEncrypted, existing.credentialsEncrypted);
          legacyPasswordEncrypted = existing?.legacyPasswordEncrypted || existing?.passwordEncrypted || '';
        }

        incomingAccounts.push({
          accountSerial,
          account,
          realName: String(rawAccount.realName || ''),
          accountType: String(rawAccount.accountType || ''),
          credentialsEncrypted,
          legacyPasswordEncrypted,
          sourceSubscriptionId: String(rawAccount.sourceSubscriptionId || '')
        });
      }
    }

    if (mode === 'replace' && incomingSubs.length === 0) {
      return json(
        { success: false, message: '覆盖模式拒绝空订阅列表（请确认备份完整或改用合并模式）' },
        400
      );
    }

    const rulesMap =
      backup.reminderRules && typeof backup.reminderRules === 'object' ? backup.reminderRules : {};

    let importedSubs = 0;
    let importedRules = 0;

    if (mode === 'replace') {
      const existing = await subRepo.listAll(env);
      for (const sub of existing) {
        if (sub && sub.id) {
          await remindersRepo.clearForSubscription(env, sub.id);
        }
      }
      await subRepo.replaceAll(env, incomingSubs);
      await syncCurrentSubscriptions(env, incomingSubs, {
        replace: true,
        recordHistory: true,
        action: 'restore_replace'
      });
      importedSubs = incomingSubs.length;
    } else {
      for (const sub of incomingSubs) {
        await subRepo.save(env, sub);
        importedSubs++;
      }
      await syncCurrentSubscriptions(env, incomingSubs, {
        replace: false,
        recordHistory: true,
        action: 'restore_merge'
      });
    }

    let importedAccounts = 0;
    if (incomingAccounts.length > 0) {
      const accountResult = await restoreAccounts(env, incomingAccounts, { replace: mode === 'replace' });
      importedAccounts = accountResult.imported || 0;
    } else {
      // 兼容 v1/v2 备份：没有独立 accounts 数组时，从订阅记录重建账号库。
      if (mode === 'replace') {
        await restoreAccounts(env, [], { replace: true });
      }
      for (const sub of incomingSubs) {
        const accountResult = await syncFromSubscription(env, sub, { action: 'restore_legacy', syncPassword: true });
        if (accountResult.success && !accountResult.skipped) importedAccounts += 1;
      }
    }

    for (const sub of incomingSubs) {
      let rules = Array.isArray(rulesMap[sub.id]) ? rulesMap[sub.id] : null;
      if (!rules && Array.isArray(sub.reminderRules)) rules = sub.reminderRules;
      if (rules && rules.length > 0) {
        const normalized = rules.map((r) => remindersRepo.normalizeRule(r));
        await remindersRepo.replaceForSubscription(env, sub.id, normalized);
        importedRules += normalized.length;
        try {
          const { syncLegacyReminderFields } = await import('../../data/subscriptions.js');
          await syncLegacyReminderFields(env, sub.id, normalized);
        } catch {
          /* ignore */
        }
      }
    }

    // 分类
    if (Array.isArray(backup.categories)) {
      const cats = backup.categories
        .filter((c) => typeof c === 'string' && c.trim())
        .map((c) => c.trim());
      if (mode === 'replace') {
        await putKVJson(env, 'categories', [...new Set(cats)].sort());
      } else {
        const existing = await getCategories(env);
        const set = new Set([...existing, ...cats]);
        await putKVJson(env, 'categories', [...set].sort());
      }
    }

    // 可配置菜单（v4+）。旧备份缺少该字段时保留当前菜单。
    if (backup.menuOptions && typeof backup.menuOptions === 'object') {
      if (mode === 'replace') {
        await setMenuOptions(env, backup.menuOptions);
      } else {
        const currentMenus = await getMenuOptions(env);
        const mergedMenus = {};
        for (const key of ['subscriptionNames', 'subscriptionTypes', 'categories']) {
          const currentList = Array.isArray(currentMenus[key]) ? currentMenus[key] : [];
          const incomingList = Array.isArray(backup.menuOptions[key]) ? backup.menuOptions[key] : [];
          mergedMenus[key] = [...new Set([...currentList, ...incomingList].map((item) => String(item || '').trim()).filter(Boolean))];
        }
        await setMenuOptions(env, mergedMenus);
      }
    }

    // 配置放最后
    if (backup.config && typeof backup.config === 'object') {
      const merged = mergeConfig(currentConfig, backup.config, includeSecrets);
      await setConfig(env, merged);
    }

    return json({
      success: true,
      message: `恢复完成（模式: ${mode === 'replace' ? '覆盖' : '合并'}）`,
      stats: {
        subscriptions: importedSubs,
        accounts: importedAccounts,
        reminderRules: importedRules,
        categories: Array.isArray(backup.categories) ? backup.categories.length : 0,
        menuOptions: backup.menuOptions ? Object.values(backup.menuOptions).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0) : 0,
        configRestored: !!backup.config,
        secretsApplied: includeSecrets
      }
    });
  } catch (error) {
    console.error('[backup] 导入失败:', error);
    return json(
      { success: false, message: '导入失败: ' + (error && error.message ? error.message : String(error)) },
      500
    );
  }
}
