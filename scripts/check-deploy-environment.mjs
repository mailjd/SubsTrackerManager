#!/usr/bin/env node
/** Local-only checks. Does not create backups, deploy, migrate, or contact any API. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkDeploymentEnvironment} from './upgrade/deploy-environment.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const result = checkDeploymentEnvironment(root);
  console.log('[deploy:check] 本地部署前检查通过：' + JSON.stringify(result));
  console.log('[deploy:check] 尚未连接 Cloudflare、尚未部署；Token 权限、原 KV/D1 ID 与备份仍须由 upgrade:prepare 验证。');
  if (result.workerSource === 'wrangler.toml') console.log('[deploy:check] 当前目标名称来自 TOML；必须与原 Worker 一致。自定义名称请设置 SUBSTRACKER_WORKER_NAME。');
} catch (error) {
  console.error(`[deploy:check] ${error.code || 'ST_DEPLOY_CHECK'}\n${error.message}`);
  process.exitCode = 1;
}
