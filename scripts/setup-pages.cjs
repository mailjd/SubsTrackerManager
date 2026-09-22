#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const crypto = require('crypto');

const ROOT = process.cwd();
const CONFIG = path.join(ROOT, 'wrangler.toml');
const MIGRATIONS_DIR = path.join(ROOT, 'migrations');
const PROD_KV_TITLE = 'SUBSCRIPTIONS_KV';
const PREVIEW_KV_TITLE = 'SUBSCRIPTIONS_KV_PREVIEW';
const PROD_D1_NAME = 'subscription-manager-db';
const PREVIEW_D1_NAME = 'subscription-manager-preview-db';
const D1_BINDING = 'SUBSCRIPTIONS_DB';

function npxWrangler(args, options = {}) {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  return execFileSync(npx, ['wrangler', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    input: options.input,
    env: process.env
  });
}

function readProjectName() {
  const content = fs.readFileSync(CONFIG, 'utf8');
  const match = content.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
  if (!match) throw new Error('wrangler.toml 缺少 name');
  return String(process.env.SUBSTRACKER_PAGES_PROJECT_NAME || match[1]).trim();
}

function listNamespaces() {
  const parsed = JSON.parse(npxWrangler(['kv', 'namespace', 'list']));
  return Array.isArray(parsed) ? parsed : [];
}

function findNamespace(list, title, projectName) {
  const names = new Set([
    title,
    `subscription-manager-${title}`, // 兼容 v3.1.x Worker 自动前缀命名
    `${projectName}-${title}`
  ]);
  if (title === PREVIEW_KV_TITLE) {
    names.add('SUBSCRIPTIONS_KV_preview');
    names.add('subscription-manager-SUBSCRIPTIONS_KV_preview');
    names.add(`${projectName}-SUBSCRIPTIONS_KV_preview`);
  }
  return list.find((x) => x && names.has(x.title));
}

function ensureNamespace(title, projectName) {
  let list = listNamespaces();
  let found = findNamespace(list, title, projectName);
  if (found?.id) {
    console.log(`[setup:pages] 复用 KV：${found.title}`);
    return found;
  }
  console.log(`[setup:pages] 创建 KV：${title}`);
  npxWrangler(['kv', 'namespace', 'create', title]);
  list = listNamespaces();
  found = findNamespace(list, title, projectName);
  if (!found?.id) throw new Error(`无法创建 KV：${title}`);
  return found;
}

function listD1() {
  const parsed = JSON.parse(npxWrangler(['d1', 'list', '--json']));
  return Array.isArray(parsed) ? parsed : [];
}

function ensureD1(name) {
  let list = listD1();
  let found = list.find((x) => x && (x.name === name || x.database_name === name));
  if (found && (found.uuid || found.id)) return found;
  console.log(`[setup:pages] 创建 D1：${name}`);
  npxWrangler(['d1', 'create', name]);
  list = listD1();
  found = list.find((x) => x && (x.name === name || x.database_name === name));
  if (!found || !(found.uuid || found.id)) throw new Error(`无法创建 D1：${name}`);
  return found;
}

function pagesProjectExists(projectName) {
  try {
    const raw = npxWrangler(['pages', 'project', 'list', '--json']);
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.some((x) => x && (x.name === projectName || x.project_name === projectName));
    }
  } catch {
    // 兼容较旧 Wrangler：没有 --json 时回退到文本列表。
  }
  try {
    const text = npxWrangler(['pages', 'project', 'list']);
    return String(text).includes(projectName);
  } catch {
    return false;
  }
}

function ensurePagesProject(projectName) {
  if (pagesProjectExists(projectName)) return;
  const productionBranch = String(process.env.CF_PAGES_PRODUCTION_BRANCH || process.env.GITHUB_REF_NAME || 'main').trim() || 'main';
  console.log(`[setup:pages] 创建 Pages 项目：${projectName}（production branch: ${productionBranch}）`);
  npxWrangler([
    'pages', 'project', 'create', projectName,
    '--production-branch', productionBranch,
    '--compatibility-date', '2026-09-22',
    '--compatibility-flags', 'nodejs_compat'
  ], { inherit: true });
}

function writePagesConfig(projectName, prodKvId, previewKvId, prodD1Id, previewD1Id) {
  const text = `# Cloudflare Pages（默认部署目标）\n` +
`name = "${projectName}"\n` +
`pages_build_output_dir = "./public"\n` +
`compatibility_date = "2026-09-22"\n` +
`compatibility_flags = ["nodejs_compat"]\n\n` +
`[[kv_namespaces]]\n` +
`binding = "SUBSCRIPTIONS_KV"\n` +
`id = "${prodKvId}"\n\n` +
`[[d1_databases]]\n` +
`binding = "${D1_BINDING}"\n` +
`database_name = "${PROD_D1_NAME}"\n` +
`database_id = "${prodD1Id}"\n` +
`migrations_dir = "migrations"\n\n` +
`[vars]\n` +
`ENVIRONMENT = "production"\n\n` +
`# Preview 使用独立 KV / D1，避免预览分支污染生产数据\n` +
`[[env.preview.kv_namespaces]]\n` +
`binding = "SUBSCRIPTIONS_KV"\n` +
`id = "${previewKvId}"\n\n` +
`[[env.preview.d1_databases]]\n` +
`binding = "${D1_BINDING}"\n` +
`database_name = "${PREVIEW_D1_NAME}"\n` +
`database_id = "${previewD1Id}"\n` +
`migrations_dir = "migrations"\n\n` +
`[env.preview.vars]\n` +
`ENVIRONMENT = "preview"\n`;
  fs.writeFileSync(CONFIG, text, 'utf8');
}

function applyMigrations(databaseName) {
  if (!fs.existsSync(MIGRATIONS_DIR)) return;
  console.log(`[setup:pages] 应用 D1 migrations：${databaseName}`);
  npxWrangler(['d1', 'migrations', 'apply', databaseName, '--remote'], { inherit: true });
}

function readKvJson(namespaceId, key) {
  try {
    const raw = npxWrangler(['kv', 'key', 'get', key, '--namespace-id', namespaceId]).trim();
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function putKvJson(namespaceId, key, value) {
  const temp = path.join(ROOT, `.substracker-${key}-${process.pid}.json`);
  try {
    fs.writeFileSync(temp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
    npxWrangler(['kv', 'key', 'put', key, '--namespace-id', namespaceId, '--path', temp], { inherit: true });
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}

function ensureInitialConfig(namespaceId, { preview = false } = {}) {
  const existing = readKvJson(namespaceId, 'config');
  const config = existing && typeof existing === 'object' ? { ...existing } : {};
  const isNew = !existing;

  if (isNew) {
    config.ADMIN_USERNAME = String(process.env.SUBSTRACKER_ADMIN_USERNAME || 'admin').trim() || 'admin';
    // 管理员密码由 Pages Secret/Variable SUBSTRACKER_ADMIN_PASSWORD 提供，不写入 KV。
    config.ADMIN_PASSWORD = '';
    config.JWT_SECRET = crypto.randomUUID();
    config.CREDENTIALS_ENCRYPTION_KEY = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  }

  if (isNew) {
    putKvJson(namespaceId, 'config', config);
    console.log(`[setup:pages] ${preview ? 'Preview' : 'Production'} KV config 已初始化`);
  }
}

function printRuntimeCredentialHints(projectName) {
  console.log('');
  console.log('[setup:pages] Cloudflare Pages / Worker Variables and Secrets：');
  console.log('  - SUBSTRACKER_ADMIN_PASSWORD：可选，首次部署/应急登录回退密码');
  console.log('  - SUBSTRACKER_SUPERADMIN_USERNAME：SuperAdmin 用户名');
  console.log('  - SUBSTRACKER_SUPERADMIN_PASSWORD：SuperAdmin 二级密码（建议 Secret）');
  console.log(`[setup:pages] Pages project: ${projectName}`);
  console.log('');
}

function main() {
  if (!fs.existsSync(CONFIG)) throw new Error('未找到 wrangler.toml');

  const projectName = readProjectName();
  ensurePagesProject(projectName);

  const prodKv = ensureNamespace(PROD_KV_TITLE, projectName);
  const previewKv = ensureNamespace(PREVIEW_KV_TITLE, projectName);
  const prodD1 = ensureD1(PROD_D1_NAME);
  const previewD1 = ensureD1(PREVIEW_D1_NAME);
  const prodD1Id = prodD1.uuid || prodD1.id;
  const previewD1Id = previewD1.uuid || previewD1.id;

  writePagesConfig(projectName, prodKv.id, previewKv.id, prodD1Id, previewD1Id);
  applyMigrations(PROD_D1_NAME);
  applyMigrations(PREVIEW_D1_NAME);
  ensureInitialConfig(prodKv.id, { preview: false });
  ensureInitialConfig(previewKv.id, { preview: true });
  printRuntimeCredentialHints(projectName);

  console.log('[setup:pages] 完成 ✅');
  console.log(`[setup:pages] Pages project: ${projectName}`);
  console.log(`[setup:pages] Production URL: https://${projectName}.pages.dev`);
  console.log(`[setup:pages] KV: ${prodKv.id}`);
  console.log(`[setup:pages] D1: ${prodD1Id}`);
}

try {
  main();
} catch (error) {
  console.error('[setup:pages] 失败:', error?.message || error);
  process.exit(1);
}
