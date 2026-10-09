#!/usr/bin/env node
/** Default is fixed: unbound code publication, then authenticated web init. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runDirectDeployment,downloadDirectBackup} from './deploy-direct.mjs';
import {runAutoDeployment} from './deploy-unbound.mjs';
export {runAutoDeployment};
export {runDirectDeployment};
export {runSplitDeployment,verifyReleaseChecks} from './deploy-cloudflare-split.mjs';
export async function main(args=process.argv.slice(2)){
  if(args[0]==='--help'&&args.length===1){console.log('npm run deploy:cloudflare：無 D1/KV 綁定時先部署 /init 等待頁；綁回原資源後由網頁升級。仍有 D1 或 KV 時列出殘留綁定並停止，不自動轉換升級模式。網址不再是程式發布先決條件。npm run upgrade:download -- <backup UUID>：下载直接升级加密备份。direct 僅供明確選擇舊直接升級；split / download（不带 UUID）仅供旧分段流程恢复。');return;}
  if(args.length>2||args.length&&(!['split','direct','download'].includes(args[0])||['split','direct'].includes(args[0])&&args.length!==1))throw new Error('未知参数；支持無參數無綁定部署、舊 direct/split、download [backup UUID]。');
  const timer=setTimeout(()=>{console.error('[upgrade] ST_DEPLOY_TIMEOUT：命令达到15分钟保护上限，尚未确认完成；没有自动删除/回滚业务资料。');process.exit(75);},15*60*1000);timer.unref();
  try{
    if(args[0]==='split'||args[0]==='download'&&!args[1]){const {runSplitDeployment}=await import('./deploy-cloudflare-split.mjs');return await runSplitDeployment({downloadOnly:args[0]==='download'});}
    if(args[0]==='download')return await downloadDirectBackup(args[1]);
    if(args[0]==='direct')return await runDirectDeployment();
    return await runAutoDeployment();
  }finally{clearTimeout(timer);}
}
export function deploymentFailureMessage(error){
  const state=error.deploymentState;
  if(state?.publishAttempted===false)return '[upgrade] 本次停止在 '+state.stage+'；尚未呼叫發布器，沒有上傳新版，也沒有存取 D1/KV 資料。';
  if(state?.codeDeployed===true)return '[upgrade] 本次程式發布已有控制平面證據；後續檢查未完成。資料 init 尚未完成，請核對上述階段，不要盲目重新发布。';
  if(state?.publishAttempted)return '[upgrade] 已呼叫發布器，但目前尚未確認本次版本承接流量；請核對 deployment/version ID。没有自动回滚或改库。';
  return '[upgrade] 尚未取得本次發布階段證據；請依本次日誌判斷，不能僅憑此警語認定已上傳。';
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error('[upgrade] '+(error.code&&!error.message.includes(error.code)?error.code+'：':'')+error.message);console.error(deploymentFailureMessage(error));process.exitCode=1;});
