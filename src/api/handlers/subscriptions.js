import {
  getAllSubscriptions,
  getSubscription,
  createSubscription,
  updateSubscription,
  deleteSubscription,
  manualRenewSubscription,
  deletePaymentRecord,
  updatePaymentRecord,
  toggleSubscriptionStatus,
  patchSubscriptionFields,
  syncLegacyReminderFields
} from '../../data/subscriptions.js';
import { getConfig } from '../../data/config.js';
import { sendNotificationToAllChannels } from '../../services/notify/index.js';
import { lunarCalendar } from '../../core/lunar.js';
import { formatTimeInTimezone, formatTimezoneDisplay, getTimezoneDateParts } from '../../core/time.js';
import { formatAmount } from '../../core/currency-format.js';
import { extractTagsFromSubscriptions } from '../utils.js';
import { hasD1, listSubscriptionHistory, syncCurrentSubscriptions, getCurrentSubscriptionSnapshot } from '../../data/subscription-history.repo.js';
import {
  SUBSCRIPTION_IMPORT_TEMPLATE_BASE64,
  SUBSCRIPTION_IMPORT_TEMPLATE_FILENAME,
  SUBSCRIPTION_IMPORT_TEMPLATE_MIME
} from '../../data/subscription-import-template.js';
import {
  getBySerial as getAccountBySerial,
  getByAccount as getAccountByAccount,
  isDuplicateSerialAllowed as isAccountDuplicateSerialAllowed,
  upsert as upsertAccount
} from '../../data/accounts.repo.js';


function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function persistCreatedReminderRules(env, subscriptionId, incomingRules, options = {}) {
  try {
    const remindersRepo = await import('../../data/reminders.repo.js');
    const incoming = Array.isArray(incomingRules) ? incomingRules : null;
    const rules = incoming && incoming.length > 0
      ? incoming.map(remindersRepo.normalizeRule)
      : remindersRepo.defaultPresetRules();
    await remindersRepo.replaceForSubscription(env, subscriptionId, rules);
    if (options.syncLegacy !== false) {
      const { syncLegacyReminderFields } = await import('../../data/subscriptions.js');
      await syncLegacyReminderFields(env, subscriptionId, rules);
    }
    return true;
  } catch (err) {
    console.error('[subscriptions] 写入提醒规则失败（订阅本身已创建）:', err);
    return false;
  }
}


function sanitizeSubscription(subscription) {
  if (!subscription || typeof subscription !== 'object') return subscription;
  const { passwordEncrypted: _passwordEncrypted, password: _password, ...safe } = subscription;
  return safe;
}

function normalizeImportText(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

async function importMissingAccountFromSubscription(env, subscription, metadata = {}) {
  const accountSerial = String(subscription?.accountSerial || '').trim();
  const account = String(subscription?.account || '').trim();
  if (!accountSerial || !account) {
    return { success: true, created: false, skipped: true, status: 'incomplete', message: '账号或账号序号为空，未写入账号数据库' };
  }
  try {
    const existingAccount = await getAccountByAccount(env, account);
    if (existingAccount) {
      if (String(existingAccount.accountSerial || '') === accountSerial) {
        return { success: true, created: false, skipped: true, status: 'exists', message: '账号数据库已存在对应账号信息' };
      }
      return { success: false, created: false, skipped: true, status: 'conflict', message: `账号 ${account} 已绑定账号序号 ${existingAccount.accountSerial}` };
    }
    if (!isAccountDuplicateSerialAllowed(accountSerial)) {
      const existingSerial = await getAccountBySerial(env, accountSerial);
      if (existingSerial) {
        return { success: false, created: false, skipped: true, status: 'conflict', message: `账号序号 ${accountSerial} 已绑定账号 ${existingSerial.account}` };
      }
    }
    const result = await upsertAccount(env, {
      accountSerial,
      account,
      realName: '',
      accountType: '',
      sourceSubscriptionId: String(subscription?.id || '')
    }, {
      action: 'subscription_opt_in_import',
      metadata: { source: 'subscription_opt_in', ...metadata }
    });
    if (!result.success) return { success: false, created: false, skipped: false, status: 'failed', message: result.message || '账号数据库写入失败' };
    if (result.skipped) return { success: true, created: false, skipped: true, status: result.reason || 'skipped', message: result.reason === 'd1_not_bound' ? 'D1 未绑定，账号数据库未写入' : '账号数据库未写入' };
    return { success: true, created: true, skipped: false, status: 'created', message: '账号信息已新增到账号数据库' };
  } catch (error) {
    console.error('[subscriptions] 同步账号数据库失败:', error);
    return { success: false, created: false, skipped: false, status: 'failed', message: error?.message || '账号数据库写入失败' };
  }
}

function makeSubscriptionImportFingerprint(subscription) {
  const name = normalizeImportText(subscription && subscription.name);
  const account = normalizeImportText(subscription && subscription.account);
  const serial = normalizeImportText(subscription && subscription.accountSerial);
  const customType = normalizeImportText(subscription && subscription.customType);
  const expiry = normalizeImportText(subscription && subscription.expiryDate).slice(0, 10);
  const amount = subscription && subscription.amount !== undefined && subscription.amount !== null
    ? String(Number(subscription.amount))
    : '';
  const currency = normalizeImportText(subscription && subscription.currency || 'CNY');

  if (name && account) return `account|${name}|${account}`;
  if (name && serial && serial !== '配音供应商') return `serial|${name}|${serial}`;
  return `fallback|${name}|${customType}|${expiry}|${amount}|${currency}`;
}


const IMPORT_ROWS_PER_REQUEST = 6;

async function loadExistingImportFingerprints(env) {
  const subRepo = await import('../../data/subscriptions.repo.js');

  if (hasD1(env)) {
    try {
      const result = await env.SUBSCRIPTIONS_DB.prepare(`
        SELECT name, account, account_serial, custom_type, expiry_date, amount, currency
        FROM subscriptions_current
      `).all();
      const d1Rows = result.results || [];
      const fingerprints = new Set(d1Rows.map((row) => makeSubscriptionImportFingerprint({
        name: row.name,
        account: row.account,
        accountSerial: row.account_serial,
        customType: row.custom_type,
        expiryDate: row.expiry_date,
        amount: row.amount,
        currency: row.currency
      })));

      // 只读一次 KV 索引做一致性检查。若旧版批量导入曾在“KV 已写入、
      // D1 镜像尚未写入”时触发子请求上限，则两边数量会不同。
      // 这种情况下读取一次 KV 当前记录并顺手修复 D1，避免重新导入产生重复。
      const ids = await subRepo.listIds(env);
      if (ids.length === d1Rows.length) return fingerprints;

      console.warn(`[subscription-import] 检测到 KV/D1 数量不一致（KV=${ids.length}, D1=${d1Rows.length}），执行轻量修复`);
      const kvRows = await subRepo.listAll(env);
      for (const row of kvRows) fingerprints.add(makeSubscriptionImportFingerprint(row));
      await syncCurrentSubscriptions(env, kvRows, { replace: false, recordHistory: false });
      return fingerprints;
    } catch (error) {
      console.warn('[subscription-import] D1 指纹查询失败，回退 KV 轻量读取:', error?.message || error);
    }
  }

  try {
    const rows = await subRepo.listAll(env);
    return new Set(rows.map(makeSubscriptionImportFingerprint));
  } catch (error) {
    console.error('[subscription-import] 读取现有订阅指纹失败:', error);
    return new Set();
  }
}

async function applyImportReminderLegacy(subscription) {
  if (!Array.isArray(subscription?.reminderRules) || subscription.reminderRules.length === 0) return subscription;
  try {
    const remindersRepo = await import('../../data/reminders.repo.js');
    const rules = subscription.reminderRules.map(remindersRepo.normalizeRule);
    const legacy = remindersRepo.deriveLegacyFromRules(rules);
    return {
      ...subscription,
      reminderUnit: legacy.unit,
      reminderValue: legacy.value,
      reminderDays: legacy.unit === 'day' ? legacy.value : undefined,
      reminderHours: legacy.unit === 'hour' ? legacy.value : undefined,
      reminderRules: rules
    };
  } catch {
    return subscription;
  }
}

function changesObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function formatReminderRulesForExport(rules = []) {
  if (!Array.isArray(rules) || rules.length === 0) return '';
  return rules
    .filter((rule) => rule && rule.isEnabled !== false)
    .map((rule) => {
      if (rule.type === 'on_expiry') return '当天';
      if (rule.type === 'after_expiry') {
        const interval = Number(rule.repeatInterval || rule.value || 24) || 24;
        return `到期后每${interval}小时`;
      }
      const value = Number(rule.value || 0);
      const unit = rule.unit === 'hours' || rule.unit === 'hour' ? '小时' : '天';
      return `${value}${unit}`;
    })
    .filter(Boolean)
    .join(',');
}

async function buildEditableSubscription(subscription) {
  return sanitizeSubscription(subscription);
}

async function testSingleSubscriptionNotification(id, env) {
  try {
    const subscription = await getSubscription(id, env);
    if (!subscription) {
      return { success: false, message: '未找到该订阅' };
    }
    const config = await getConfig(env);

    const title = `手动测试通知: ${subscription.name}`;

    const showLunar = config.SHOW_LUNAR === true;
    let lunarExpiryText = '';

    if (showLunar) {
      const timezoneForLunar = config?.TIMEZONE || 'UTC';
      const expiryParts = getTimezoneDateParts(subscription.expiryDate, timezoneForLunar);
      const lunarExpiry = lunarCalendar.solar2lunar(expiryParts.year, expiryParts.month, expiryParts.day);
      lunarExpiryText = lunarExpiry ? ` (农历: ${lunarExpiry.fullStr})` : '';
    }

    const timezone = config?.TIMEZONE || 'UTC';
    const formattedExpiryDate = formatTimeInTimezone(new Date(subscription.expiryDate), timezone, 'date');
    const currentTime = formatTimeInTimezone(new Date(), timezone, 'datetime');

    const calendarType = subscription.useLunar ? '农历' : '公历';
    const autoRenewText = subscription.autoRenew ? '是' : '否';
    const formattedAmount = formatAmount(subscription.amount, subscription.currency || 'CNY');
    const amountText = formattedAmount ? `\n金额: ${formattedAmount}/周期` : '';

    const categoryText = subscription.category ? subscription.category : '未分类';

    const commonContent = `**订阅详情**
类型: ${subscription.customType || '其他'}${amountText}
分类: ${categoryText}
日历类型: ${calendarType}
到期日期: ${formattedExpiryDate}${lunarExpiryText}
自动续期: ${autoRenewText}
备注: ${subscription.notes || '无'}
发送时间: ${currentTime}
当前时区: ${formatTimezoneDisplay(timezone)}`;

    const tags = extractTagsFromSubscriptions([subscription]);
    const notifyResult = await sendNotificationToAllChannels(title, commonContent, config, '[手动测试]', {
      env, subId: id, ruleId: 'manual-test',
      metadata: { tags }
    });

    const attempted = notifyResult?.attempted || 0;
    const successCount = notifyResult?.successCount || 0;
    const failedCount = notifyResult?.failedCount || 0;

    if (attempted === 0) {
      return { success: false, message: '未启用任何通知渠道，请先在系统配置中开启至少一种通知方式' };
    }

    if (successCount === 0) {
      return { success: false, message: `测试通知发送失败（已尝试 ${attempted} 个渠道）` };
    }

    if (failedCount > 0) {
      return { success: true, message: `测试通知已发送：成功 ${successCount} 个，失败 ${failedCount} 个渠道` };
    }

    return { success: true, message: `测试通知发送成功（共 ${successCount} 个渠道）` };
  } catch (error) {
    console.error('[手动测试] 发送失败:', error);
    return { success: false, message: '发送时发生错误: ' + error.message };
  }
}

function persistenceComparable(value) {
  if (value === undefined) return '__undefined__';
  if (value === null) return '__null__';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '__nan__';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value) || (value && typeof value === 'object')) {
    try { return JSON.stringify(value); } catch (_) { return String(value); }
  }
  return String(value);
}

function verifyFields(snapshot, expected, fields) {
  if (!snapshot) return false;
  return fields.every((field) => persistenceComparable(snapshot[field]) === persistenceComparable(expected[field]));
}

async function handleSubscriptions(request, env, path) {
  const method = request.method;

  if (path === '/subscriptions/import-template' && method === 'GET') {
    const bytes = base64ToBytes(SUBSCRIPTION_IMPORT_TEMPLATE_BASE64);
    const encodedFilename = encodeURIComponent(SUBSCRIPTION_IMPORT_TEMPLATE_FILENAME);
    return new Response(bytes, {
      headers: {
        'Content-Type': SUBSCRIPTION_IMPORT_TEMPLATE_MIME,
        'Content-Disposition': `attachment; filename="SubsTracker_Subscription_Import_Template.xlsx"; filename*=UTF-8''${encodedFilename}`,
        'Cache-Control': 'no-store'
      }
    });
  }

  if (path === '/subscriptions/import' && method === 'POST') {
    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ success: false, message: '请求体不是合法 JSON' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const rows = Array.isArray(payload) ? payload : payload && Array.isArray(payload.rows) ? payload.rows : null;
    const importAccountsToDatabase = !Array.isArray(payload) && payload?.importAccountsToDatabase === true;
    if (!rows || rows.length === 0) {
      return new Response(
        JSON.stringify({ success: false, message: '没有可导入的数据' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (rows.length > IMPORT_ROWS_PER_REQUEST) {
      return new Response(
        JSON.stringify({
          success: false,
          message: `单次最多导入 ${IMPORT_ROWS_PER_REQUEST} 条。系统会自动分批，请使用订阅记录页的 Excel 批量导入。`
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const results = [];
    let imported = 0;
    let failed = 0;
    let skipped = 0;
    let accountDbCreated = 0;
    let accountDbExisting = 0;
    let accountDbSkipped = 0;
    let accountDbFailed = 0;
    const accountDbResults = [];
    const existingFingerprints = await loadExistingImportFingerprints(env);

    async function collectAccountDatabaseResult(subscription, sourceRow, sourceStatus) {
      if (!importAccountsToDatabase) return null;
      const sync = await importMissingAccountFromSubscription(env, subscription, { sourceRow, sourceStatus });
      accountDbResults.push({ row: sourceRow, account: subscription?.account || '', accountSerial: subscription?.accountSerial || '', ...sync });
      if (sync.created) accountDbCreated += 1;
      else if (sync.status === 'exists') accountDbExisting += 1;
      else if (sync.success) accountDbSkipped += 1;
      else accountDbFailed += 1;
      return sync;
    }

    for (let index = 0; index < rows.length; index++) {
      const raw = rows[index];
      const sourceRow = raw && Number(raw.__sourceRow) > 0 ? Number(raw.__sourceRow) : index + 2;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        failed += 1;
        results.push({ row: sourceRow, success: false, message: '该行数据格式无效' });
        continue;
      }

      const { __sourceRow: _sourceRow, ...rawSubscription } = raw;
      const subscription = await applyImportReminderLegacy(rawSubscription);
      const fingerprint = makeSubscriptionImportFingerprint(subscription);
      if (existingFingerprints.has(fingerprint)) {
        skipped += 1;
        const accountDatabase = await collectAccountDatabaseResult(subscription, sourceRow, 'subscription_exists');
        results.push({
          row: sourceRow,
          success: false,
          skipped: true,
          name: subscription.name || '',
          message: '检测到原有订阅记录，按“只新增、不覆盖”规则跳过',
          ...(accountDatabase ? { accountDatabase } : {})
        });
        continue;
      }

      const result = await createSubscription(subscription, env, {
        historyAction: 'import',
        historyMetadata: { source: 'excel_paste', sourceRow }
      });

      if (result.success && result.subscription) {
        await persistCreatedReminderRules(env, result.subscription.id, subscription.reminderRules, { syncLegacy: false });
        imported += 1;
        existingFingerprints.add(fingerprint);
        const accountDatabase = await collectAccountDatabaseResult(result.subscription, sourceRow, 'subscription_created');
        results.push({
          row: sourceRow,
          success: true,
          id: result.subscription.id,
          name: result.subscription.name,
          ...(accountDatabase ? { accountDatabase } : {})
        });
      } else {
        failed += 1;
        results.push({
          row: sourceRow,
          success: false,
          name: subscription.name || '',
          message: result.message || '导入失败'
        });
      }
    }

    return new Response(JSON.stringify({
      success: failed === 0,
      partial: imported > 0 && (failed > 0 || skipped > 0),
      imported,
      failed,
      skipped,
      total: rows.length,
      results,
      accountDatabase: {
        enabled: importAccountsToDatabase,
        created: accountDbCreated,
        existing: accountDbExisting,
        skipped: accountDbSkipped,
        failed: accountDbFailed,
        results: accountDbResults
      }
    }), {
      status: imported > 0 || (failed === 0 && skipped > 0) ? 200 : 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (path === '/subscriptions/export-data' && method === 'POST') {
    let payload = {};
    try {
      payload = await request.json();
    } catch {
      payload = {};
    }
    const requestedIds = Array.isArray(payload.ids) ? payload.ids.map(String) : [];
    const all = await getAllSubscriptions(env);
    const selected = requestedIds.length > 0
      ? all.filter((item) => requestedIds.includes(String(item.id)))
      : all;
    const remindersRepo = await import('../../data/reminders.repo.js');
    const items = [];
    for (const subscription of selected) {
      let rules = [];
      try {
        rules = await remindersRepo.listForSubscription(env, subscription.id);
      } catch {
        rules = [];
      }
      items.push({
        ...sanitizeSubscription(subscription),
        reminderRulesText: formatReminderRulesForExport(rules)
      });
    }
    return new Response(JSON.stringify({ success: true, items }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (path === '/subscriptions/bulk-delete' && method === 'POST') {
    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response(JSON.stringify({ success: false, message: '请求体不是合法 JSON' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const ids = Array.isArray(payload && payload.ids) ? [...new Set(payload.ids.map(String).filter(Boolean))] : [];
    if (ids.length === 0) {
      return new Response(JSON.stringify({ success: false, message: '请选择要删除的订阅' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    // 每个删除动作会同时更新 KV、D1 历史和提醒规则。
    // 限制单次小批量，避免触发 Cloudflare Worker 子请求上限；前端会自动分批。
    if (ids.length > 6) {
      return new Response(JSON.stringify({ success: false, message: '单次最多批量删除 6 条订阅，请使用前端自动分批删除' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const results = [];
    let deleted = 0;
    let failed = 0;
    for (const id of ids) {
      const result = await deleteSubscription(id, env);
      if (result.success) {
        deleted += 1;
        results.push({ id, success: true });
      } else {
        failed += 1;
        results.push({ id, success: false, message: result.message || '删除失败' });
      }
    }

    return new Response(JSON.stringify({
      success: failed === 0,
      partial: deleted > 0 && failed > 0,
      deleted,
      failed,
      total: ids.length,
      results
    }), {
      status: deleted > 0 ? 200 : 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (path === '/subscriptions/bulk-update' && method === 'POST') {
    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response(JSON.stringify({ success: false, message: '请求体不是合法 JSON' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const ids = Array.isArray(payload && payload.ids) ? [...new Set(payload.ids.map(String).filter(Boolean))] : [];
    const changes = payload && changesObject(payload.changes) ? payload.changes : null;
    if (ids.length === 0 || !changes) {
      return new Response(JSON.stringify({ success: false, message: '请选择要修改的订阅，并至少勾选一个修改字段' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (ids.length > 200) {
      return new Response(JSON.stringify({ success: false, message: '单次最多批量修改 200 条订阅' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const allowedFields = new Set([
      'customType', 'category', 'memberLevel', 'users', 'points', 'amount', 'currency',
      'subscriptionMode', 'isActive', 'autoRenew', 'notes'
    ]);
    const patch = {};
    for (const [key, value] of Object.entries(changes)) {
      if (allowedFields.has(key)) patch[key] = value;
    }
    const hasReminderRulesPatch = Object.prototype.hasOwnProperty.call(changes, 'reminderRules');
    const reminderRulesPatch = hasReminderRulesPatch && Array.isArray(changes.reminderRules) ? changes.reminderRules : [];
    if (Object.keys(patch).length === 0 && !hasReminderRulesPatch) {
      return new Response(JSON.stringify({ success: false, message: '没有允许批量修改的字段' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const appendNotes = payload.appendNotes === true;
    const results = [];
    let updated = 0;
    let failed = 0;
    for (const id of ids) {
      const existing = await getSubscription(id, env);
      if (!existing) {
        failed += 1;
        results.push({ id, success: false, message: '订阅不存在' });
        continue;
      }
      const mergedPatch = { ...patch };
      if (Object.prototype.hasOwnProperty.call(mergedPatch, 'notes') && appendNotes) {
        const oldNotes = String(existing.notes || '').trim();
        const newNotes = String(mergedPatch.notes || '').trim();
        mergedPatch.notes = [oldNotes, newNotes].filter(Boolean).join('\n');
      }
      let result = { success: true };
      if (Object.keys(mergedPatch).length > 0) {
        result = await patchSubscriptionFields(id, mergedPatch, env);
      }
      if (result.success && hasReminderRulesPatch) {
        try {
          const remindersRepo = await import('../../data/reminders.repo.js');
          const normalizedRules = reminderRulesPatch.map(remindersRepo.normalizeRule);
          await remindersRepo.replaceForSubscription(env, id, normalizedRules);
          const { syncLegacyReminderFields } = await import('../../data/subscriptions.js');
          await syncLegacyReminderFields(env, id, normalizedRules);
        } catch (error) {
          result = { success: false, message: '提醒规则保存失败：' + (error && error.message ? error.message : '未知错误') };
        }
      }
      if (result.success) {
        updated += 1;
        results.push({ id, success: true });
      } else {
        failed += 1;
        results.push({ id, success: false, message: result.message || '修改失败' });
      }
    }

    return new Response(JSON.stringify({
      success: failed === 0,
      partial: updated > 0 && failed > 0,
      updated,
      failed,
      total: ids.length,
      results
    }), {
      status: updated > 0 ? 200 : 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (path === '/subscriptions') {
    if (method === 'GET') {
      const subscriptions = await getAllSubscriptions(env);
      const safeSubscriptions = subscriptions.map(sanitizeSubscription);
      return new Response(JSON.stringify(safeSubscriptions), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }

    if (method === 'POST') {
      let subscription;
      try {
        subscription = await request.json();
      } catch {
        return new Response(
          JSON.stringify({ success: false, message: '请求体不是合法 JSON' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      const importAccountToDatabase = subscription?.importAccountToDatabase === true;
      const { importAccountToDatabase: _importAccountToDatabase, ...subscriptionData } = subscription || {};
      const result = await createSubscription(subscriptionData, env);
      // 创建成功后写入提醒规则，并同步 legacy 提醒字段（列表展示依赖）
      let accountDatabase = null;
      if (result.success && result.subscription) {
        await persistCreatedReminderRules(env, result.subscription.id, subscriptionData.reminderRules, { syncLegacy: false });
        if (importAccountToDatabase) {
          accountDatabase = await importMissingAccountFromSubscription(env, result.subscription, { sourceStatus: 'manual_create' });
        }
      }
      const responseResult = result.success && result.subscription
        ? { ...result, subscription: sanitizeSubscription(result.subscription), ...(accountDatabase ? { accountDatabase } : {}) }
        : result;
      return new Response(JSON.stringify(responseResult), {
        status: result.success ? 201 : 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  if (path.startsWith('/subscriptions/')) {
    const parts = path.split('/');
    const id = parts[2];

    // 表格模式专用字段级保存。
    // 旧实现由前端拼出整条 subscription 后 PUT；在提醒规则与 Cloudflare KV 最终一致性同时存在时，
    // 同一请求后续重新读取旧对象可能覆盖刚写入的单格修改。这里改为服务端读取最新对象、只合并本次修改字段，
    // 并在同一请求中完成提醒规则同步，成功响应代表写入流程已经 await 完成。
    if (parts[3] === 'table-edit' && method === 'PATCH') {
      let payload;
      try {
        payload = await request.json();
      } catch {
        return new Response(JSON.stringify({ success: false, message: '请求体不是合法 JSON' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
        });
      }

      const changes = payload && changesObject(payload.changes) ? payload.changes : null;
      if (!changes) {
        return new Response(JSON.stringify({ success: false, message: '没有待保存的表格修改' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
        });
      }

      const existing = await getSubscription(id, env);
      if (!existing) {
        return new Response(JSON.stringify({ success: false, message: '订阅不存在' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
        });
      }

      const allowedFields = new Set([
        'name', 'account', 'accountSerial', 'memberLevel', 'points', 'users', 'customType', 'category',
        'amount', 'currency', 'subscriptionMode', 'startDate', 'periodValue', 'periodUnit', 'expiryDate',
        'useLunar', 'endOfMonth', 'isActive', 'autoRenew', 'notes',
        'reminderUnit', 'reminderValue', 'reminderDays', 'reminderHours'
      ]);
      const businessChanges = {};
      for (const [key, value] of Object.entries(changes)) {
        if (allowedFields.has(key)) businessChanges[key] = value;
      }

      const hasReminderRules = Object.prototype.hasOwnProperty.call(changes, 'reminderRules');
      const incomingReminderRules = hasReminderRules && Array.isArray(changes.reminderRules)
        ? changes.reminderRules
        : [];

      if (Object.keys(businessChanges).length === 0 && !hasReminderRules) {
        return new Response(JSON.stringify({ success: false, message: '没有允许保存的表格字段' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
        });
      }

      let savedSubscription = existing;
      if (Object.keys(businessChanges).length > 0) {
        // 用服务端刚读取的现有记录合并，而不是相信浏览器里可能已经过期的整条对象。
        const mergedInput = { ...existing, ...businessChanges };
        const result = await updateSubscription(id, mergedInput, env);
        if (!result.success || !result.subscription) {
          return new Response(JSON.stringify({ success: false, message: result.message || '表格修改保存失败' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
          });
        }
        savedSubscription = result.subscription;
      }

      if (hasReminderRules) {
        try {
          const remindersRepo = await import('../../data/reminders.repo.js');
          const normalizedRules = incomingReminderRules.map(remindersRepo.normalizeRule);
          await remindersRepo.replaceForSubscription(env, id, normalizedRules);
          // 直接把本请求刚保存的对象传入，禁止立即从 KV 回读旧快照再覆盖业务字段。
          const synced = await syncLegacyReminderFields(env, id, normalizedRules, savedSubscription);
          if (!synced) throw new Error('提醒规则 legacy 字段同步失败');
          // 响应里带回本次刚保存的完整提醒规则，避免 KV 边缘缓存短暂读到旧 reminder_rules 时，
          // 前端又把刚编辑的提醒显示回旧值。recent-write overlay 也会保留这份确认快照。
          savedSubscription = {
            ...synced,
            reminderRules: normalizedRules,
            reminderRulesSummary: remindersRepo.formatRulesSummary(normalizedRules)
          };
        } catch (error) {
          return new Response(JSON.stringify({
            success: false,
            message: '提醒规则保存失败：' + (error && error.message ? error.message : '未知错误')
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
          });
        }
      }

      // 严格持久化校验：不能仅因为 put()/D1 batch 没抛异常就向前端报告“保存成功”。
      // KV 在跨边缘节点场景可能短暂读到旧缓存，因此：
      // - KV 命中本次字段 => 已验证；
      // - 若绑定 D1，则 D1 current 快照命中本次字段也视为强持久化验证通过。
      // GET 列表会以 updatedAt 较新的 D1 快照覆盖 KV 的旧边缘快照。
      const verifyFieldsList = Object.keys(businessChanges);
      let kvSnapshot = null;
      let d1Snapshot = null;
      try {
        const subRepo = await import('../../data/subscriptions.repo.js');
        kvSnapshot = await subRepo.getById(env, id);
      } catch (error) {
        console.warn('[table-edit] KV 回读校验失败:', error?.message || error);
      }
      if (hasD1(env)) {
        try { d1Snapshot = await getCurrentSubscriptionSnapshot(env, id); }
        catch (error) { console.warn('[table-edit] D1 回读校验失败:', error?.message || error); }
      }
      const kvVerified = verifyFields(kvSnapshot, savedSubscription, verifyFieldsList);
      const d1Verified = hasD1(env) ? verifyFields(d1Snapshot, savedSubscription, verifyFieldsList) : false;
      const storageVerified = verifyFieldsList.length === 0 ? !!(d1Verified || kvVerified || hasReminderRules) : !!(kvVerified || d1Verified);

      if (!storageVerified) {
        console.error('[table-edit] 保存流程返回成功但持久化回读不一致', { id, fields: verifyFieldsList, kvVerified, d1Verified });
        return new Response(JSON.stringify({
          success: false,
          saved: false,
          storageVerified: false,
          message: '服务器未能确认修改已持久化，请重试；本次暂存修改不会被清除',
          verification: { kv: kvVerified, d1: d1Verified }
        }), {
          status: 503,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
        });
      }

      return new Response(JSON.stringify({
        success: true,
        saved: true,
        storageVerified: true,
        verification: { kv: kvVerified, d1: d1Verified },
        savedFields: [
          ...Object.keys(businessChanges),
          ...(hasReminderRules ? ['reminderRules'] : [])
        ],
        subscription: sanitizeSubscription(savedSubscription)
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      });
    }

    if (parts[3] === 'toggle-status' && method === 'POST') {
      const body = await request.json();
      const result = await toggleSubscriptionStatus(id, body.isActive, env);
      return new Response(JSON.stringify(result), {
        status: result.success ? 200 : 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (parts[3] === 'test-notify' && method === 'POST') {
      const result = await testSingleSubscriptionNotification(id, env);
      return new Response(JSON.stringify(result), { status: result.success ? 200 : 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (parts[3] === 'renew' && method === 'POST') {
      let options = {};
      try {
        const body = await request.json();
        options = body || {};
      } catch (e) {
        // empty
      }
      const result = await manualRenewSubscription(id, env, options);
      return new Response(JSON.stringify(result), { status: result.success ? 200 : 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (parts[3] === 'history' && method === 'GET') {
      if (!hasD1(env)) {
        return new Response(
          JSON.stringify({ success: false, message: 'D1 数据库未绑定，请先运行 npm run setup' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
      }
      const url = new URL(request.url);
      const limit = Number(url.searchParams.get('limit')) || 100;
      const history = await listSubscriptionHistory(env, id, limit);
      return new Response(JSON.stringify({ success: true, history }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (parts[3] === 'payments' && method === 'GET') {
      const subscription = await getSubscription(id, env);
      if (!subscription) {
        return new Response(JSON.stringify({ success: false, message: '订阅不存在' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ success: true, payments: subscription.paymentHistory || [] }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (parts[3] === 'payments' && parts[4] && method === 'DELETE') {
      const paymentId = parts[4];
      const result = await deletePaymentRecord(id, paymentId, env);
      return new Response(JSON.stringify(result), { status: result.success ? 200 : 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (parts[3] === 'payments' && parts[4] && method === 'PUT') {
      const paymentId = parts[4];
      const paymentData = await request.json();
      const result = await updatePaymentRecord(id, paymentId, paymentData, env);
      return new Response(JSON.stringify(result), { status: result.success ? 200 : 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (method === 'GET') {
      const subscription = await getSubscription(id, env);
      if (!subscription) {
        return new Response(
          JSON.stringify({ success: false, message: '订阅不存在' }),
          { status: 404, headers: { 'Content-Type': 'application/json' } }
        );
      }
      const editableSubscription = await buildEditableSubscription(subscription, env);
      return new Response(JSON.stringify(editableSubscription), { headers: { 'Content-Type': 'application/json' } });
    }

    if (method === 'PUT') {
      let subscription;
      try {
        subscription = await request.json();
      } catch {
        return new Response(
          JSON.stringify({ success: false, message: '请求体不是合法 JSON' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      const result = await updateSubscription(id, subscription, env);
      // 与创建路径对称：若 body 带 reminderRules 则整体替换并同步 legacy
      if (result.success && Array.isArray(subscription.reminderRules)) {
        try {
          const remindersRepo = await import('../../data/reminders.repo.js');
          const { syncLegacyReminderFields } = await import('../../data/subscriptions.js');
          const rules = subscription.reminderRules.map(remindersRepo.normalizeRule);
          await remindersRepo.replaceForSubscription(env, id, rules);
          // 使用本请求刚写入的订阅对象，避免 KV 最终一致性导致立即回读旧值并覆盖本次更新。
          const synced = await syncLegacyReminderFields(env, id, rules, result.subscription);
          if (synced) result.subscription = synced;
        } catch (err) {
          console.error('[subscriptions] 更新提醒规则失败（订阅本体已更新）:', err);
        }
      }
      const responseResult = result.success && result.subscription
        ? { ...result, subscription: sanitizeSubscription(result.subscription) }
        : result;
      return new Response(JSON.stringify(responseResult), { status: result.success ? 200 : 400, headers: { 'Content-Type': 'application/json' } });
    }

    if (method === 'DELETE') {
      const result = await deleteSubscription(id, env);
      return new Response(JSON.stringify(result), { status: result.success ? 200 : 400, headers: { 'Content-Type': 'application/json' } });
    }
  }

  return null;
}

export { handleSubscriptions };
