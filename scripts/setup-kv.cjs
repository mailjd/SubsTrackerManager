#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const crypto = require('crypto');

const ROOT = process.cwd();
const WRANGLER_TOML = path.join(ROOT, 'wrangler.toml');
const MIGRATIONS_DIR = path.join(ROOT, 'migrations');
const PROD_TITLE = 'SUBSCRIPTIONS_KV';
const PREVIEW_TITLE_CANDIDATES = ['SUBSCRIPTIONS_KV_PREVIEW', 'SUBSCRIPTIONS_KV_preview'];
const D1_BINDING = 'SUBSCRIPTIONS_DB';
const D1_DATABASE_NAME = 'subscription-manager-db';


function hashSuperAdminPassword(password) {
  const iterations = 210000;
  const salt = crypto.randomBytes(16);
  const derived = crypto.pbkdf2Sync(String(password || ''), salt, iterations, 32, 'sha256');
  return `pbkdf2-sha256$${iterations}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

function wrangler(args, options = {}) {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  return execFileSync(npx, ['wrangler', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe']
  });
}

function listNamespaces() {
  const output = wrangler(['kv', 'namespace', 'list']);
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [];
}

function listD1Databases() {
  const output = wrangler(['d1', 'list', '--json']);
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [];
}

function readWorkerName() {
  const content = fs.readFileSync(WRANGLER_TOML, 'utf8');
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (/^\s*\[/.test(line)) break;
    const match = line.match(/^\s*name\s*=\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*(?:#.*)?$/);
    if (match) return match[1] || match[2] || match[3];
  }
  return null;
}

function namespaceTitlesFor(title) {
  const workerName = readWorkerName();
  return workerName ? [title, `${workerName}-${title}`] : [title];
}

function findNamespace(namespaces, title) {
  const expectedTitles = namespaceTitlesFor(title);
  return namespaces.find((ns) => expectedTitles.includes(ns.title));
}

function ensureNamespace(title) {
  let namespaces = listNamespaces();
  let found = findNamespace(namespaces, title);
  if (found && found.id) return found;

  console.log(`[setup] KV ${title} 不存在，开始创建...`);
  wrangler(['kv', 'namespace', 'create', title]);
  namespaces = listNamespaces();
  found = findNamespace(namespaces, title);
  if (!found || !found.id) throw new Error(`创建失败：未找到 KV namespace ${title}`);
  return found;
}

function findD1Database(databases) {
  return databases.find((db) => db && (db.name === D1_DATABASE_NAME || db.database_name === D1_DATABASE_NAME));
}

function ensureD1Database() {
  let databases = listD1Databases();
  let found = findD1Database(databases);
  if (found && (found.uuid || found.id)) return found;

  console.log(`[setup] D1 ${D1_DATABASE_NAME} 不存在，开始创建...`);
  wrangler(['d1', 'create', D1_DATABASE_NAME]);
  databases = listD1Databases();
  found = findD1Database(databases);
  if (!found || !(found.uuid || found.id)) throw new Error(`创建失败：未找到 D1 数据库 ${D1_DATABASE_NAME}`);
  return found;
}

function updateWranglerToml(prodId, previewId, d1Id) {
  let content = fs.readFileSync(WRANGLER_TOML, 'utf8');

  content = content.replace(/\n# KV 命名空间配置（自动生成）[\s\S]*?(?=\n# 环境变量|\n\[vars\]|\n# 定时任务配置|\n\[triggers\]|$)/m, '\n');
  content = content.replace(/\n# D1 数据库配置（自动生成）[\s\S]*?(?=\n# 环境变量|\n\[vars\]|\n# 定时任务配置|\n\[triggers\]|$)/m, '\n');
  content = content.replace(/\n\[\[kv_namespaces\]\][\s\S]*?(?=\n\[|\n#|$)/g, '\n');
  content = content.replace(/\n\[\[d1_databases\]\][\s\S]*?(?=\n\[|\n#|$)/g, '\n');

  const storageBlock = `\n# KV 命名空间配置（自动生成）\n[[kv_namespaces]]\nbinding = "SUBSCRIPTIONS_KV"\nid = "${prodId}"\npreview_id = "${previewId}"\n\n# D1 数据库配置（自动生成）\n[[d1_databases]]\nbinding = "${D1_BINDING}"\ndatabase_name = "${D1_DATABASE_NAME}"\ndatabase_id = "${d1Id}"\nmigrations_dir = "migrations"\n`;

  if (content.includes('\n[triggers]')) {
    content = content.replace('\n[triggers]', `${storageBlock}\n[triggers]`);
  } else {
    content = `${content.trimEnd()}\n${storageBlock}\n`;
  }

  fs.writeFileSync(WRANGLER_TOML, content, 'utf8');
}

function applyD1Migrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return;
  console.log('[setup] 应用 D1 migrations...');
  wrangler(['d1', 'migrations', 'apply', D1_DATABASE_NAME, '--remote'], { inherit: true });
}

function ensureInitialConfig(namespaceId) {
  let existingRaw = '';
  try {
    existingRaw = wrangler(['kv', 'key', 'get', 'config', '--namespace-id', namespaceId]).trim();
  } catch {
    existingRaw = '';
  }

  let config = {};
  let isNew = true;
  if (existingRaw) {
    try {
      config = JSON.parse(existingRaw);
      isNew = false;
    } catch {
      throw new Error('现有 KV config 不是合法 JSON，请先修复配置');
    }
  }

  if (isNew) {
    const username = String(process.env.SUBSTRACKER_ADMIN_USERNAME || 'admin').trim() || 'admin';
    config.ADMIN_USERNAME = username;
    // 管理员密码不再写入 KV。运行时由 Cloudflare Worker Variable/Secret
    // `SUBSTRACKER_ADMIN_PASSWORD` 提供；旧环境中的 ADMIN_PASSWORD 仅作为兼容回退。
    config.ADMIN_PASSWORD = '';
    config.JWT_SECRET = crypto.randomUUID();
    config.CREDENTIALS_ENCRYPTION_KEY = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  }

  const superAdminPassword = String(process.env.SUBSTRACKER_SUPERADMIN_PASSWORD || '').trim();
  if (superAdminPassword) {
    config.SUPERADMIN_PASSWORD_HASH = hashSuperAdminPassword(superAdminPassword);
  } else if (!config.SUPERADMIN_PASSWORD_HASH) {
    console.warn('[setup] 警告：未设置 SUBSTRACKER_SUPERADMIN_PASSWORD，Database 的 SuperAdmin 密码查看模式将不可用');
  }

  if (!isNew && !superAdminPassword) {
    console.log('[setup] KV config 已存在，保留现有兼容配置、SuperAdmin 配置与加密密钥；管理员登录优先使用 Worker SUBSTRACKER_ADMIN_PASSWORD');
    return;
  }

  const tempFile = path.join(ROOT, '.substracker-bootstrap-config.json');
  try {
    fs.writeFileSync(tempFile, JSON.stringify(config), { encoding: 'utf8', mode: 0o600 });
    wrangler(['kv', 'key', 'put', 'config', '--namespace-id', namespaceId, '--path', tempFile], { inherit: true });
    if (isNew) console.log(`[setup] 已初始化管理员账号：${config.ADMIN_USERNAME || 'admin'}；密码请在 Cloudflare Worker Variables and Secrets 中设置 SUBSTRACKER_ADMIN_PASSWORD`);
    if (superAdminPassword) console.log('[setup] 已写入/更新 SuperAdmin 二级密码哈希（明文未保存）');
  } finally {
    try { fs.unlinkSync(tempFile); } catch {}
  }
}

function main() {
  if (!fs.existsSync(WRANGLER_TOML)) throw new Error('未找到 wrangler.toml，请在项目根目录执行');

  const prod = ensureNamespace(PROD_TITLE);
  let preview = null;
  const namespaces = listNamespaces();
  for (const name of PREVIEW_TITLE_CANDIDATES) {
    preview = findNamespace(namespaces, name);
    if (preview && preview.id) break;
  }
  if (!preview || !preview.id) preview = ensureNamespace('SUBSCRIPTIONS_KV_PREVIEW');

  const d1 = ensureD1Database();
  const d1Id = d1.uuid || d1.id;
  updateWranglerToml(prod.id, preview.id, d1Id);
  applyD1Migrations();
  ensureInitialConfig(prod.id);

  console.log('[setup] 完成 ✅');
  console.log(`[setup] SUBSCRIPTIONS_KV: ${prod.id}`);
  console.log(`[setup] SUBSCRIPTIONS_KV_PREVIEW: ${preview.id}`);
  console.log(`[setup] ${D1_BINDING}: ${d1Id}`);
  console.log('[setup] 已更新 wrangler.toml 并初始化 D1 数据表');
}

try {
  main();
} catch (error) {
  console.error('[setup] 失败:', error.message || error);
  process.exit(1);
}
