import {
  getAllSubscriptions,
  getSubscription,
  createSubscription,
  updateSubscription,
  deleteSubscription,
  manualRenewSubscription,
  deletePaymentRecord,
  updatePaymentRecord,
  toggleSubscriptionStatus
} from '../../data/subscriptions.js';
import { getConfig } from '../../data/config.js';
import { sendNotificationToAllChannels } from '../../services/notify/index.js';
import { lunarCalendar } from '../../core/lunar.js';
import { formatTimeInTimezone, formatTimezoneDisplay, getTimezoneDateParts } from '../../core/time.js';
import { formatAmount } from '../../core/currency-format.js';
import { extractTagsFromSubscriptions } from '../utils.js';
import { decryptCredential } from '../../core/credentials.js';
import { hasD1, listSubscriptionHistory } from '../../data/subscription-history.repo.js';
import { getBySerial as getAccountBySerial } from '../../data/accounts.repo.js';
import {
  SUBSCRIPTION_IMPORT_TEMPLATE_BASE64,
  SUBSCRIPTION_IMPORT_TEMPLATE_FILENAME,
  SUBSCRIPTION_IMPORT_TEMPLATE_MIME
} from '../../data/subscription-import-template.js';


function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function persistCreatedReminderRules(env, subscriptionId, incomingRules) {
  try {
    const remindersRepo = await import('../../data/reminders.repo.js');
    const { syncLegacyReminderFields } = await import('../../data/subscriptions.js');
    const incoming = Array.isArray(incomingRules) ? incomingRules : null;
    const rules = incoming && incoming.length > 0
      ? incoming.map(remindersRepo.normalizeRule)
      : remindersRepo.defaultPresetRules();
    await remindersRepo.replaceForSubscription(env, subscriptionId, rules);
    await syncLegacyReminderFields(env, subscriptionId, rules);
    return true;
  } catch (err) {
    console.error('[subscriptions] 写入提醒规则失败（订阅本身已创建）:', err);
    return false;
  }
}


function sanitizeSubscription(subscription) {
  if (!subscription || typeof subscription !== 'object') return subscription;
  const { passwordEncrypted: _passwordEncrypted, password: _password, ...safe } = subscription;
  return {
    ...safe,
    hasPassword: !!subscription.passwordEncrypted
  };
}

async function buildEditableSubscription(subscription, env) {
  const safe = sanitizeSubscription(subscription);
  if (!subscription) return { ...safe, password: '' };

  try {
    const config = await getConfig(env);
    let encrypted = subscription.passwordEncrypted || '';
    if (subscription.accountSerial) {
      try {
        const accountRecord = await getAccountBySerial(env, subscription.accountSerial);
        if (accountRecord && accountRecord.account === String(subscription.account || '').trim()) {
          encrypted = accountRecord.passwordEncrypted;
        }
      } catch (error) {
        console.warn('[subscriptions] 读取账号数据库失败，回退订阅凭据:', error);
      }
    }
    if (!encrypted) return { ...safe, password: '', hasPassword: false };
    const password = await decryptCredential(encrypted, config.CREDENTIALS_ENCRYPTION_KEY);
    return { ...safe, password, hasPassword: true };
  } catch (error) {
    console.error('[subscriptions] 解密账号密码失败:', error);
    return { ...safe, password: '', passwordDecryptFailed: true };
  }
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
    if (!rows || rows.length === 0) {
      return new Response(
        JSON.stringify({ success: false, message: '没有可导入的数据' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (rows.length > 100) {
      return new Response(
        JSON.stringify({ success: false, message: '单次最多导入 100 条，请分批提交' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const results = [];
    let imported = 0;
    let failed = 0;

    for (let index = 0; index < rows.length; index++) {
      const raw = rows[index];
      const sourceRow = raw && Number(raw.__sourceRow) > 0 ? Number(raw.__sourceRow) : index + 2;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        failed += 1;
        results.push({ row: sourceRow, success: false, message: '该行数据格式无效' });
        continue;
      }

      const { __sourceRow: _sourceRow, ...subscription } = raw;
      const result = await createSubscription(subscription, env, {
        historyAction: 'import',
        historyMetadata: { source: 'excel_paste', sourceRow }
      });

      if (result.success && result.subscription) {
        await persistCreatedReminderRules(env, result.subscription.id, subscription.reminderRules);
        imported += 1;
        results.push({
          row: sourceRow,
          success: true,
          id: result.subscription.id,
          name: result.subscription.name
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
      partial: imported > 0 && failed > 0,
      imported,
      failed,
      total: rows.length,
      results
    }), {
      status: imported > 0 ? 200 : 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (path === '/subscriptions') {
    if (method === 'GET') {
      const subscriptions = await getAllSubscriptions(env);
      const safeSubscriptions = subscriptions.map(sanitizeSubscription);
      return new Response(JSON.stringify(safeSubscriptions), { headers: { 'Content-Type': 'application/json' } });
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
      const result = await createSubscription(subscription, env);
      // 创建成功后写入提醒规则，并同步 legacy 提醒字段（列表展示依赖）
      if (result.success && result.subscription) {
        await persistCreatedReminderRules(env, result.subscription.id, subscription.reminderRules);
      }
      const responseResult = result.success && result.subscription
        ? { ...result, subscription: sanitizeSubscription(result.subscription) }
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
          await syncLegacyReminderFields(env, id, rules);
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
