/** Dependency-free deployment routing/preflight helpers. Never touches Cloudflare or storage. */
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

export class DeploymentError extends Error {
  constructor(code, message) { super(message); this.name = 'DeploymentError'; this.code = code; }
}
const fail = (code, message) => { throw new DeploymentError(code, message); };
const enabled = value => value != null && !['', '0', 'false'].includes(String(value).trim().toLowerCase());

export function detectDeploymentHost(env = process.env) {
  // Workers Builds can set CI=true as well. Test the specific host before generic CI.
  if (enabled(env.WORKERS_CI) || Boolean(env.WORKERS_CI_BUILD_UUID)) return 'cloudflare-workers-builds';
  if (enabled(env.CF_PAGES)) return 'cloudflare-pages';
  if (enabled(env.GITHUB_ACTIONS)) return 'github-actions';
  return 'local-or-external-ci';
}

export function deploymentRouteHelp(host = detectDeploymentHost()) {
  const where = host === 'cloudflare-workers-builds' ? 'Cloudflare Workers Builds / Git 直连'
    : host === 'cloudflare-pages' ? 'Cloudflare Pages（本项目是 Worker）' : '未受保护的 Wrangler 部署入口';
  return [
    `当前入口：${where}。本版本禁止直接 wrangler deploy。`,
    '此检查失败不代表数据库损坏；本检查未发布 Worker、未改写任何远端记录。',
    '正确入口：原 GitHub 仓库 → Actions → Safe upgrade → Run workflow。',
    '先到 Cloudflare → 原 Worker → Settings → Builds → Disconnect，断开 Git 直连；不要删除 Worker / KV / D1。',
    '在原 GitHub 仓库 Settings → Secrets and variables → Actions 配置：',
    '  Secrets: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, SUBSTRACKER_BACKUP_PASSWORD（至少16字符）。',
    '  Variables: SUBSTRACKER_WORKER_NAME（原 Worker 名称）；自定义域名另设 SUBSTRACKER_WORKER_URL。',
    '本机也可运行 npm run deploy:check 后再 npm run deploy:safe（需要 Node 22.13+ / Python 3.11+）。',
    '不要只把 Workers Builds 的 deploy command 换成 npm run deploy:safe：平台总时限20分钟，本流程仅安全等待就16分钟，另需备份、迁移和验收。',
    '不要删除 [build]、不要伪造 SUBSTRACKER_SAFE_DEPLOY_RUN、不要缩短维护等待、不要跳过测试或备份。',
    '详细操作：CLOUDFLARE_DEPLOY_FIX_3.3.21.md。',
  ].join('\n');
}

export function assertSupportedDeploymentHost(env = process.env) {
  const host = detectDeploymentHost(env);
  if (host === 'cloudflare-workers-builds' || host === 'cloudflare-pages') {
    fail('ST_DEPLOY_ROUTE', deploymentRouteHelp(host));
  }
  return host;
}

export function assertNodeRuntime(version = process.versions.node) {
  const [major, minor] = String(version).split('.').map(Number);
  if (!Number.isInteger(major) || major < 22 || (major === 22 && minor < 13) || (major === 23 && minor < 4)) {
    fail('ST_DEPLOY_NODE', '安全备份需要 Node 22.13+（建议使用 Node 22 最新维护版）；请更新 Actions / 本机 Node，而不是关闭备份检查。');
  }
}

export function validateDeploymentSecrets(env = process.env) {
  const missing = [];
  if (!/^[a-fA-F0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID || '')) missing.push('CLOUDFLARE_ACCOUNT_ID（32位 Account ID，不是 Zone ID）');
  if (!String(env.CLOUDFLARE_API_TOKEN || '').trim()) missing.push('CLOUDFLARE_API_TOKEN');
  if (String(env.SUBSTRACKER_BACKUP_PASSWORD || '').length < 16) missing.push('SUBSTRACKER_BACKUP_PASSWORD（至少16字符）');
  if (missing.length) fail('ST_DEPLOY_CONFIG', '缺少或格式不符：' + missing.join('、') + '。配置位置：GitHub 仓库 Settings → Secrets and variables → Actions → Secrets；Cloudflare 的运行时 Secrets 不会自动复制到 GitHub。值不会写入日志。');
}

export function readWranglerConfig(root, env = process.env) {
  const python = env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const file = path.join(root, 'wrangler.toml');
  if (!fs.existsSync(file)) fail('ST_DEPLOY_ROOT', '项目根目录缺少 wrangler.toml；应解压项目内容到仓库根目录，而不是只上传 ZIP。');
  const result = spawnSync(python, ['-c',
    'import sys,tomllib,json;assert sys.version_info >= (3,11);print(json.dumps(tomllib.load(open(sys.argv[1],"rb"))))', file],
    {encoding:'utf8',timeout:10000});
  if (result.status !== 0) fail('ST_DEPLOY_PYTHON', '需要 Python 3.11+，且 wrangler.toml 必须是有效 TOML；不会猜测或重写原配置。');
  let config = JSON.parse(result.stdout);
  const selected = env.SUBSTRACKER_ENVIRONMENT;
  if (selected) {
    if (!Object.hasOwn(config.env || {}, selected)) fail('ST_DEPLOY_ENV', '找不到 SUBSTRACKER_ENVIRONMENT 对应的 Wrangler 环境。');
    config = {...config, ...config.env[selected]};
  }
  delete config.env;
  if (env.SUBSTRACKER_WORKER_NAME) config.name = env.SUBSTRACKER_WORKER_NAME;
  if (!/^[a-zA-Z0-9_-]+$/.test(config.name || '')) fail('ST_DEPLOY_WORKER', '缺少有效的原 Worker 名称，请设置 SUBSTRACKER_WORKER_NAME。');
  if (config.account_id && config.account_id !== env.CLOUDFLARE_ACCOUNT_ID) fail('ST_DEPLOY_ACCOUNT', 'wrangler.toml 的 account_id 与 GitHub CLOUDFLARE_ACCOUNT_ID 不一致；停止，不能改绑数据。');
  if (env.SUBSTRACKER_WORKER_URL) {
    let url;
    try { url = new URL(env.SUBSTRACKER_WORKER_URL); } catch { fail('ST_DEPLOY_URL', 'SUBSTRACKER_WORKER_URL 必须是原网站的 HTTPS 源地址。'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      fail('ST_DEPLOY_URL', 'SUBSTRACKER_WORKER_URL 只填原 HTTPS 源地址，不含 /admin、查询参数或凭证。');
    }
  }
  return config;
}

export function checkDeploymentEnvironment(root, env = process.env) {
  const host = assertSupportedDeploymentHost(env);
  assertNodeRuntime();
  validateDeploymentSecrets(env);
  const config = readWranglerConfig(root, env);
  // Only return non-secret metadata. This is local preflight, NOT proof of online token permissions.
  return {host, node: process.versions.node, worker: config.name,
    workerSource: env.SUBSTRACKER_WORKER_NAME ? 'SUBSTRACKER_WORKER_NAME' : 'wrangler.toml',
    urlSource: env.SUBSTRACKER_WORKER_URL ? 'explicit-original-origin' : 'discover-existing-workers.dev',
    secretsPresent: true, remoteAccessChecked: false};
}
