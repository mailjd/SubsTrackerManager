#!/usr/bin/env node
/** Default: one-build compatible code release. Split migration is explicit legacy recovery only. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runDirectDeployment,downloadDirectBackup} from './deploy-direct.mjs';
import {runAutoDeployment} from './deploy-unbound.mjs';
export {runAutoDeployment};
export {runDirectDeployment};
export {runSplitDeployment,verifyReleaseChecks} from './deploy-cloudflare-split.mjs';
export async function main(args=process.argv.slice(2)){
  if(args[0]==='--help'&&args.length===1){console.log('npm run deploy:cloudflare：無 D1/KV 綁定時先部署 /init 等待頁；綁回原資源後由網頁升級。仍有綁定時沿用直接升級。npm run upgrade:download -- <backup UUID>：下载直接升级加密备份。split / download（不带 UUID）仅供旧分段流程恢复。');return;}
  if(args.length>2||args.length&&(!['split','download'].includes(args[0])||args[0]==='split'&&args.length!==1))throw new Error('未知参数；支持无参数直接升级、split、download [backup UUID]。');
  const timer=setTimeout(()=>{console.error('[upgrade] ST_DEPLOY_TIMEOUT：命令达到15分钟保护上限，尚未确认完成；没有自动删除/回滚业务资料。');process.exit(75);},15*60*1000);timer.unref();
  try{
    if(args[0]==='split'||args[0]==='download'&&!args[1]){const {runSplitDeployment}=await import('./deploy-cloudflare-split.mjs');return await runSplitDeployment({downloadOnly:args[0]==='download'});}
    if(args[0]==='download')return await downloadDirectBackup(args[1]);
    return await runAutoDeployment();
  }finally{clearTimeout(timer);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error('[upgrade] '+error.message);console.error('[upgrade] 没有清空或重建原存储；发布后验收失败不等于代码没有上传，请按本次日志核对线上状态。');process.exitCode=1;});
