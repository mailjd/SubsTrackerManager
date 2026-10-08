/** Dependency-free deployment routing/preflight helpers. Never touches Cloudflare or storage. */
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {VERSION} from '../../src/version.js';
import {assertD1KVConfig} from './storage-policy.mjs';

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
    `当前入口：${where}。禁止直接 wrangler deploy 绕过备份。`,
    `v${VERSION} 支持保留 Cloudflare Git 直连；不必 Disconnect。`,
    '必须在原 Worker → Settings → Build(s) → Deploy command 设置 npm run deploy:cloudflare；不是 Build command。Build command 可留空或用 npm run build。',
    'STOP：若日志仍显示 Executing user deploy command: npx wrangler deploy，控制台设置尚未生效；不要反复 Retry 同一错误命令。',
    'ZIP/package.json 无法自动覆盖控制台保存的 Deploy command；保存设置后才执行新 Build。',
    '在 Builds 的变量/机密配置原 CLOUDFLARE_ACCOUNT_ID、CLOUDFLARE_API_TOKEN、SUBSTRACKER_BACKUP_PASSWORD（至少16字符）、SUBSTRACKER_WORKER_NAME。',
    '第一次运行：加密备份并部署维护版本；日志 ST_UPGRADE_WAIT 会给出再次运行时间。',
    '等待至少16分钟后，Retry 同一提交：恢复加密检查点、补迁移、逐项验收后才开站。',
    '构建成功不等于升级完成；只有 ST_UPGRADE_COMPLETE 且 maintenance:false 才完成。',
    '本机/GitHub Actions → Safe upgrade 仍可运行完整流程；Cloudflare Pages 仍不支持。',
    '不要删除 build guard、不要伪造 runId、不要重建 Worker / KV / D1。',
    `详细操作：DEPLOY_REPAIR_${VERSION}.md。`,
  ].join('\n');
}

export function assertSupportedDeploymentHost(env = process.env, {allowWorkersBuilds = false} = {}) {
  const host = detectDeploymentHost(env);
  if ((host === 'cloudflare-workers-builds' && !allowWorkersBuilds) || host === 'cloudflare-pages') {
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
  if (missing.length) fail('ST_DEPLOY_CONFIG', '缺少或格式不符：' + missing.join('、') + '。配置位置：Cloudflare 的 Settings → Builds → Build variables and secrets，或 GitHub Actions Secrets；运行时 Secrets 不等于构建 Secrets。值不会写入日志。');
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
  assertD1KVConfig(config);
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

export function checkDeploymentEnvironment(root, env = process.env, options = {}) {
  const host = assertSupportedDeploymentHost(env, options);
  assertNodeRuntime();
  validateDeploymentSecrets(env);
  const config = readWranglerConfig(root, env);
  // Only return non-secret metadata. This is local preflight, NOT proof of online token permissions.
  return {host, node: process.versions.node, worker: config.name,
    workerSource: env.SUBSTRACKER_WORKER_NAME ? 'SUBSTRACKER_WORKER_NAME' : 'wrangler.toml',
    urlSource: env.SUBSTRACKER_WORKER_URL ? 'explicit-original-origin' : 'discover-existing-workers.dev',
    storagePolicy: 'D1_KV_ONLY', d1Backup: 'query-only', objectStorageRequired: false,
    secretsPresent: true, remoteAccessChecked: false};
}
