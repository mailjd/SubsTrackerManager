import { getConfig } from '../../data/config.js';
import { decryptCredential, encryptCredential } from '../../core/credentials.js';
import { generateJWT, verifyJWT } from '../../core/auth.js';
import { hasSuperAdminPassword, verifySuperAdminPassword } from '../../core/superadmin.js';
import { getCookieValue } from '../utils.js';
import {
  ACCOUNT_IMPORT_TEMPLATE_BASE64,
  ACCOUNT_IMPORT_TEMPLATE_FILENAME,
  ACCOUNT_IMPORT_TEMPLATE_MIME
} from '../../data/account-import-template.js';
import {
  hasAccountsDb,
  listPaged,
  listOptions,
  getBySerial,
  getByAccount,
  upsert,
  updateAndPropagate,
  deleteAccount
} from '../../data/accounts.repo.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}


function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodePathPart(value) {
  try { return decodeURIComponent(value || ''); } catch { return value || ''; }
}


const SUPERADMIN_COOKIE = 'superadmin_token';
const SUPERADMIN_TTL_SECONDS = 30 * 60;
const SUPERADMIN_MAX_ATTEMPTS = 5;
const SUPERADMIN_LOCKOUT_SECONDS = 300;

function getClientIp(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
}

async function isSuperAdminUnlocked(request, config) {
  const token = getCookieValue(request.headers.get('Cookie'), SUPERADMIN_COOKIE);
  if (!token) return false;
  const payload = await verifyJWT(token, `${config.JWT_SECRET}:superadmin`);
  return !!(payload && payload.role === 'superadmin');
}

async function getSuperAdminAttempts(env, ip) {
  const raw = await env.SUBSCRIPTIONS_KV.get(`superadmin_attempts:${ip}`);
  return raw ? Number(raw) || 0 : 0;
}

async function recordSuperAdminFailure(env, ip) {
  const key = `superadmin_attempts:${ip}`;
  const attempts = (await getSuperAdminAttempts(env, ip)) + 1;
  await env.SUBSCRIPTIONS_KV.put(key, String(attempts), { expirationTtl: SUPERADMIN_LOCKOUT_SECONDS });
  return attempts;
}

async function clearSuperAdminFailures(env, ip) {
  await env.SUBSCRIPTIONS_KV.delete(`superadmin_attempts:${ip}`);
}

/**
 * /api/accounts*
 * @param {Request} request
 * @param {any} env
 * @param {string} path 去掉 /api 后的路径
 */
export async function handleAccounts(request, env, path) {
  if (!path.startsWith('/accounts')) return null;
  if (!hasAccountsDb(env)) {
    return json({ success: false, message: 'D1 数据库未绑定，请先运行 npm run setup' }, 503);
  }

  const method = request.method;
  const url = new URL(request.url);

  if (path === '/accounts/superadmin/status' && method === 'GET') {
    const config = await getConfig(env);
    return json({
      success: true,
      configured: hasSuperAdminPassword(env),
      unlocked: await isSuperAdminUnlocked(request, config),
      expiresInSeconds: SUPERADMIN_TTL_SECONDS
    });
  }

  if (path === '/accounts/superadmin/unlock' && method === 'POST') {
    const ip = getClientIp(request);
    const attempts = await getSuperAdminAttempts(env, ip);
    if (attempts >= SUPERADMIN_MAX_ATTEMPTS) {
      return json({ success: false, message: 'SuperAdmin 二级密码尝试过多，请 5 分钟后再试' }, 429);
    }
    let body;
    try { body = await request.json(); } catch { return json({ success: false, message: '请求体不是合法 JSON' }, 400); }
    const config = await getConfig(env);
    if (!hasSuperAdminPassword(env)) {
      return json({ success: false, message: '尚未配置 SuperAdmin 二级密码，请在 Cloudflare Worker 的 Variables and Secrets 中设置 SUBSTRACKER_SUPERADMIN_PASSWORD' }, 503);
    }
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!password || !(await verifySuperAdminPassword(password, env))) {
      const failedAttempts = await recordSuperAdminFailure(env, ip);
      const remaining = Math.max(0, SUPERADMIN_MAX_ATTEMPTS - failedAttempts);
      return json({ success: false, message: remaining > 0 ? `二级密码错误（还可尝试 ${remaining} 次）` : '尝试过多，请 5 分钟后再试' }, remaining > 0 ? 403 : 429);
    }
    await clearSuperAdminFailures(env, ip);
    const token = await generateJWT(config.ADMIN_USERNAME || 'admin', `${config.JWT_SECRET}:superadmin`, {
      ttlSeconds: SUPERADMIN_TTL_SECONDS,
      extra: { role: 'superadmin' }
    });
    return new Response(JSON.stringify({ success: true, unlocked: true, expiresInSeconds: SUPERADMIN_TTL_SECONDS }), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': `${SUPERADMIN_COOKIE}=${token}; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=${SUPERADMIN_TTL_SECONDS}`
      }
    });
  }

  if (path === '/accounts/superadmin/lock' && method === 'POST') {
    return new Response(JSON.stringify({ success: true, unlocked: false }), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': `${SUPERADMIN_COOKIE}=; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=0`
      }
    });
  }

  if (path === '/accounts/import-template' && method === 'GET') {
    const bytes = base64ToBytes(ACCOUNT_IMPORT_TEMPLATE_BASE64);
    const encodedFilename = encodeURIComponent(ACCOUNT_IMPORT_TEMPLATE_FILENAME);
    return new Response(bytes, {
      headers: {
        'Content-Type': ACCOUNT_IMPORT_TEMPLATE_MIME,
        'Content-Disposition': `attachment; filename="SubsTracker_Accounts_Import_Template.xlsx"; filename*=UTF-8''${encodedFilename}`,
        'Cache-Control': 'no-store'
      }
    });
  }

  if (path === '/accounts/import' && method === 'POST') {
    let payload;
    try { payload = await request.json(); } catch { return json({ success: false, message: '请求体不是合法 JSON' }, 400); }
    const rows = Array.isArray(payload) ? payload : payload && Array.isArray(payload.rows) ? payload.rows : null;
    if (!rows || rows.length === 0) return json({ success: false, message: '没有可导入的账号数据' }, 400);
    if (rows.length > 200) return json({ success: false, message: '单次最多导入 200 条账号，请分批提交' }, 400);

    const config = await getConfig(env);
    const results = [];
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let failed = 0;

    for (let index = 0; index < rows.length; index++) {
      const raw = rows[index];
      const sourceRow = raw && Number(raw.__sourceRow) > 0 ? Number(raw.__sourceRow) : index + 2;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        failed += 1;
        results.push({ row: sourceRow, success: false, message: '该行数据格式无效' });
        continue;
      }

      const accountSerial = String(raw.accountSerial || '').trim();
      const account = String(raw.account || '').trim();
      const password = typeof raw.password === 'string' ? raw.password : '';
      if (!accountSerial || !account) {
        failed += 1;
        results.push({ row: sourceRow, success: false, accountSerial, account, message: '账号序号和账号不能为空' });
        continue;
      }

      try {
        const serialRow = await getBySerial(env, accountSerial);
        const accountRow = await getByAccount(env, account);
        if (serialRow && serialRow.account !== account) {
          failed += 1;
          results.push({ row: sourceRow, success: false, accountSerial, account, message: `账号序号 ${accountSerial} 已绑定账号 ${serialRow.account}` });
          continue;
        }
        if (accountRow && accountRow.accountSerial !== accountSerial) {
          failed += 1;
          results.push({ row: sourceRow, success: false, accountSerial, account, message: `账号 ${account} 已绑定账号序号 ${accountRow.accountSerial}` });
          continue;
        }

        const existing = serialRow || accountRow;
        if (existing && password.length === 0) {
          unchanged += 1;
          results.push({ row: sourceRow, success: true, status: 'unchanged', accountSerial, account });
          continue;
        }

        const passwordEncrypted = password.length > 0
          ? await encryptCredential(password, config.CREDENTIALS_ENCRYPTION_KEY)
          : '';
        const result = await upsert(env, {
          accountSerial,
          account,
          passwordEncrypted
        }, {
          action: existing ? 'bulk_import_update' : 'bulk_import_create',
          metadata: { source: 'excel_paste', sourceRow }
        });
        if (!result.success) {
          failed += 1;
          results.push({ row: sourceRow, success: false, accountSerial, account, message: result.message || '导入失败' });
          continue;
        }
        if (existing) updated += 1; else created += 1;
        results.push({ row: sourceRow, success: true, status: existing ? 'updated' : 'created', accountSerial, account });
      } catch (error) {
        failed += 1;
        results.push({ row: sourceRow, success: false, accountSerial, account, message: error?.message || String(error) });
      }
    }

    const processed = created + updated + unchanged;
    return json({
      success: failed === 0,
      partial: processed > 0 && failed > 0,
      created,
      updated,
      unchanged,
      failed,
      total: rows.length,
      results
    }, processed > 0 ? 200 : 400);
  }

  if (path === '/accounts/options' && method === 'GET') {
    const items = await listOptions(env);
    return json({ success: true, items });
  }

  if (path === '/accounts' && method === 'GET') {
    const page = Number(url.searchParams.get('page')) || 1;
    const pageSize = Number(url.searchParams.get('pageSize')) || 20;
    const q = url.searchParams.get('q') || '';
    const result = await listPaged(env, { page, pageSize, q });
    return json({ success: true, ...result });
  }

  if (path === '/accounts' && method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ success: false, message: '请求体不是合法 JSON' }, 400); }
    const accountSerial = String(body?.accountSerial || '').trim();
    const account = String(body?.account || '').trim();
    if (!accountSerial || !account) return json({ success: false, message: '账号序号和账号不能为空' }, 400);

    const existingSerial = await getBySerial(env, accountSerial);
    const existingAccount = await getByAccount(env, account);
    if (existingSerial || existingAccount) {
      const existing = existingSerial || existingAccount;
      return json({ success: false, message: `账号记录已存在：${existing.accountSerial} / ${existing.account}` }, 409);
    }

    const config = await getConfig(env);
    const passwordEncrypted = typeof body.password === 'string' && body.password.length > 0
      ? await encryptCredential(body.password, config.CREDENTIALS_ENCRYPTION_KEY)
      : '';
    const result = await upsert(env, { accountSerial, account, passwordEncrypted }, { action: 'manual_create' });
    return json(result, result.success ? 201 : 400);
  }

  const parts = path.split('/');
  const serial = decodePathPart(parts[2]);
  if (!serial) return null;

  if (method === 'GET') {
    const row = await getBySerial(env, serial);
    if (!row) return json({ success: false, message: '账号记录不存在' }, 404);
    const config = await getConfig(env);
    const superAdminUnlocked = await isSuperAdminUnlocked(request, config);
    let password = '';
    let passwordDecryptFailed = false;
    if (superAdminUnlocked && row.passwordEncrypted) {
      try {
        password = await decryptCredential(row.passwordEncrypted, config.CREDENTIALS_ENCRYPTION_KEY);
      } catch (error) {
        console.error('[accounts] 解密账号密码失败:', error);
        passwordDecryptFailed = true;
      }
    }
    return json({
      success: true,
      superAdminUnlocked,
      account: {
        accountSerial: row.accountSerial,
        account: row.account,
        ...(superAdminUnlocked ? { password } : {}),
        hasPassword: !!row.passwordEncrypted,
        passwordDecryptFailed: superAdminUnlocked ? passwordDecryptFailed : false,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      }
    });
  }

  if (method === 'PUT') {
    let body;
    try { body = await request.json(); } catch { return json({ success: false, message: '请求体不是合法 JSON' }, 400); }
    const current = await getBySerial(env, serial);
    if (!current) return json({ success: false, message: '账号记录不存在' }, 404);

    const config = await getConfig(env);
    let passwordEncrypted = current.passwordEncrypted;
    if (Object.prototype.hasOwnProperty.call(body || {}, 'password')) {
      passwordEncrypted = typeof body.password === 'string' && body.password.length > 0
        ? await encryptCredential(body.password, config.CREDENTIALS_ENCRYPTION_KEY)
        : '';
    }

    const result = await updateAndPropagate(env, serial, {
      accountSerial: String(body?.accountSerial || serial).trim(),
      account: String(body?.account || '').trim(),
      passwordEncrypted
    });
    return json(result, result.success ? 200 : 400);
  }

  if (method === 'DELETE') {
    const result = await deleteAccount(env, serial);
    return json(result, result.success ? 200 : 400);
  }

  return json({ success: false, message: '不支持的请求方法' }, 405);
}
