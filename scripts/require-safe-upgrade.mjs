/** Wrangler build guard. Never turns raw deploy into an unverified production deployment. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {DeploymentError, assertSupportedDeploymentHost, deploymentRouteHelp, assertNodeRuntime, detectDeploymentHost} from './upgrade/deploy-environment.mjs';
import {assertD1KVConfig} from './upgrade/storage-policy.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  assertSupportedDeploymentHost(process.env,{allowWorkersBuilds:true});
  const host=detectDeploymentHost();
  const key = process.env.SUBSTRACKER_BACKUP_PASSWORD || '';
  const run = process.env.SUBSTRACKER_SAFE_DEPLOY_RUN || '';
  if (!run || key.length < 16) throw new DeploymentError(host==='cloudflare-workers-builds'?'ST_DEPLOY_COMMAND':'ST_DEPLOY_UNPREPARED', deploymentRouteHelp());
  assertNodeRuntime();
  if (!fs.existsSync(path.join(root, '.upgrade/state.stbackup'))) {
    throw new DeploymentError('ST_DEPLOY_BACKUP', '缺少本次加密升级状态；仅设置环境变量不能跳过备份。请使用 Safe upgrade 工作流。');
  }
  // Delay loading SQLite until prerequisites pass. Invalid raw builds show the actual routing
  // problem, not an unrelated ExperimentalWarning from the archive restore dependency.
  const {decryptArchive} = await import('./upgrade/archive.mjs');
  const state = decryptArchive(fs.readFileSync(path.join(root, '.upgrade/state.stbackup')), key);
  if (state.runId !== run || state.phase !== 'prepared' || !state.preBackup?.manifest?.restoreVerified) {
    throw new DeploymentError('ST_DEPLOY_BACKUP', '尚无本次已验证的升级前备份；保留恢复附件，使用 Safe upgrade 流程。');
  }
  if(host==='cloudflare-workers-builds' && (state.deploymentMode!=='cloudflare-split' || state.remotePreBackupVerified?.archiveSha256!==state.preBackup.manifest.archiveSha256 || state.remotePreBackupVerified?.namespaceId!==state.bindings.kvId)){
    throw new DeploymentError('ST_DEPLOY_CHECKPOINT','Cloudflare 分段部署缺少远端加密备份回读凭证；请执行 npm run deploy:cloudflare，不可手动设置 runId。');
  }
  const config = JSON.parse(fs.readFileSync(path.join(root, 'wrangler.upgrade.json'), 'utf8'));
  assertD1KVConfig(state.config);
  assertD1KVConfig(config);
  if (config.name !== state.worker || config.kv_namespaces?.[0]?.id !== state.bindings.kvId || (config.d1_databases?.[0]?.database_id || null) !== state.bindings.dbId) {
    throw new DeploymentError('ST_DEPLOY_BINDINGS', '生成的部署绑定与原 Worker 不同；已停止，不会改绑现有数据。');
  }
  const filename = state.preBackup.filename;
  if (!filename || path.basename(filename) !== filename) throw new DeploymentError('ST_DEPLOY_BACKUP', '备份文件名无效。');
  const backup = fs.readFileSync(path.join(root, 'upgrade-backups', filename));
  if (crypto.createHash('sha256').update(backup).digest('hex') !== state.preBackup.manifest.archiveSha256) {
    throw new DeploymentError('ST_DEPLOY_BACKUP', '升级前备份已变化；不能使用此备份放行。');
  }
  console.log('[upgrade] 构建保护检查通过；将以原存储绑定部署维护版本。');
} catch (error) {
  console.error(`[upgrade] ${error.code || 'ST_DEPLOY_GUARD'} 阻止未经保护的部署：\n${error.message}`);
  process.exitCode = 1;
}
