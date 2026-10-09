#!/usr/bin/env node
/** Native Workers Builds: bounded, resumable stages. This is not a raw-deploy bypass. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkDeploymentEnvironment} from './upgrade/deploy-environment.mjs';
import {Cloudflare,protectBindings} from './upgrade/cloudflare.mjs';
import {assertSameBindingIdentity} from './upgrade/worker-bindings.mjs';
import {CloudflareCheckpoints,sourceFingerprint,assertSplitBindingsReady} from './upgrade/cloudflare-checkpoints.mjs';
import {prepare,stage,finish,saveState,writeGenerated,readConfig,workerCall} from './safe-upgrade.mjs';
import {VERSION} from '../src/version.js';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const options={allowWorkersBuilds:true,pauseForDrain:true};
import {verifyReleaseChecks} from './upgrade/release-checks.mjs';
export {verifyReleaseChecks};
export async function runSplitDeployment({downloadOnly=false}={}) {
  const deadline=Date.now()+15*60*1000;
  const budget=()=>{if(Date.now()+5000>=deadline)throw new Error('ST_SPLIT_BUDGET：本次构建预算不足；保留检查点，重试同一提交');};
  checkDeploymentEnvironment(ROOT,process.env,options);
  console.log('[upgrade] ST_DEPLOY_ENTRY '+JSON.stringify({version:VERSION,entry:'deploy:cloudflare',storage:'D1_KV_ONLY',continuation:'manual-retry'}));
  // Read-only real Worker binding probe MUST run before expensive release tests.
  // It never creates a database or writes to KV/D1; a KV-only Worker cannot
  // acquire the atomic D1 lease required by Cloudflare split deployments.
  const config=readConfig(),cf=new Cloudflare({accountId:process.env.CLOUDFLARE_ACCOUNT_ID,token:process.env.CLOUDFLARE_API_TOKEN});
  console.log('[upgrade] ST_DEPLOY_TARGET '+JSON.stringify({worker:config.name,environment:process.env.SUBSTRACKER_ENVIRONMENT||'top-level',nameSource:process.env.SUBSTRACKER_WORKER_NAME?'SUBSTRACKER_WORKER_NAME':'resolved-wrangler-config'}));
  const remoteSettings=await cf.settings(config.name,{requireD1:true});
  const bindings=protectBindings(config,remoteSettings);
  assertSplitBindingsReady({worker:config.name,settings:remoteSettings,bindings});
  if(!downloadOnly)verifyReleaseChecks(ROOT,deadline);
  const store=new CloudflareCheckpoints(cf,{worker:config.name,bindings,password:process.env.SUBSTRACKER_BACKUP_PASSWORD});
  if(downloadOnly){
    const state=await store.load(ROOT,{write:true});
    if(!state)throw new Error('原 Worker 没有分段升级检查点');
    console.log('[upgrade:download] 已下载并验证加密附件到 upgrade-backups/；没有部署、迁移或解锁。');return {phase:state.phase,downloaded:true};
  }
  const sourceHash=sourceFingerprint(ROOT);
  const confirmBindings=async()=>assertSameBindingIdentity(bindings,protectBindings(config,await cf.settings(config.name,{requireD1:true})));
  await confirmBindings(); // Tests can take minutes: do not write through a stale binding probe.
  await store.acquire();
  const checkpoint=async state=>{budget();saveState(state);await store.publish(ROOT,state);};
  const activeOptions={...options,checkpoint,beforeWrite:async()=>{budget();await confirmBindings();return store.assertLease();},deployTimeoutMs:()=>Math.max(1,Math.min(600000,deadline-Date.now()-30000))};
  try {
    let state=await store.load(ROOT,{write:false});
    if(state && (state.version!==VERSION||state.sourceHash!==sourceHash)){
      if(state.phase!=='complete')throw new Error('ST_SPLIT_SOURCE：源码/版本与未完成的检查点不同；请 Retry 原提交，不覆盖维护版本');
      const online=await workerCall(state,'status');
      if(online.runId!==state.runId||online.maintenance)throw new Error('旧完成检查点与线上状态不符，停止新一轮部署');
      state=null; // Previous completed releases remain archived; a new release gets a new run.
    }
    if(state)await store.load(ROOT,{version:VERSION,sourceHash});
    if(!state) {
      // Detect an existing maintenance run before creating a new one. prepare itself is read-only.
      state=await prepare({...options,expectedBindings:bindings,sourceHash,remoteArtifactsPrefix:store.prefix.artifact,remoteControlPrefix:store.prefix.control});
      let prior;
      try {prior=await workerCall(state,'status');}catch(error){if(![401,403,404].includes(error.httpStatus)&&!/非 JSON/.test(error.message))throw error;}
      if(prior?.maintenance)throw new Error('ST_SPLIT_OLD_RUN：线上已有未完成的安全升级；请用该版原恢复附件续跑，不覆盖其维护版本');
      await checkpoint(state); // Backups must survive the ephemeral Build BEFORE any upload.
      state.remotePreBackupVerified={namespaceId:bindings.kvId,archiveSha256:state.preBackup.manifest.archiveSha256};
      await checkpoint(state);
    }
    if(state.phase==='complete') {
      const status=await workerCall(state,'status');
      if(status.runId!==state.runId||status.version!==VERSION||status.maintenance)throw new Error('本次完成记录与线上版本不符；不会重复部署覆盖');
      console.log('[upgrade] ST_UPGRADE_COMPLETE '+JSON.stringify({version:VERSION,maintenance:false,alreadyComplete:true}));return {phase:'complete',maintenance:false};
    }
    writeGenerated(state);
    if(state.phase==='prepared' && !state.remotePreBackupVerified){
      await checkpoint(state);state.remotePreBackupVerified={namespaceId:bindings.kvId,archiveSha256:state.preBackup.manifest.archiveSha256};await checkpoint(state);
    }
    if(['prepared','staged'].includes(state.phase))state=await stage(activeOptions);
    if(state.phase==='staged') {
      console.log('[upgrade] ST_UPGRADE_WAIT '+JSON.stringify({version:VERSION,maintenance:true,readyAfter:new Date(state.readyAfter).toISOString(),runId:state.runId}));
      console.log('[upgrade] 第一阶段完成，不是升级完成。请在上述 UTC 时间之后 Retry 同一提交；不必断开 Cloudflare Git，也不要改成 raw wrangler deploy。');
      return {phase:'waiting',maintenance:true,readyAfter:state.readyAfter};
    }
    await store.assertLease();
    state=await finish(activeOptions);
    console.log('[upgrade] ST_UPGRADE_COMPLETE '+JSON.stringify({version:VERSION,maintenance:false,runId:state.runId}));
    console.log('[upgrade] 加密恢复包存于原 KV 的专用 __substracker_upgrade_artifacts_v1__: 前缀；可在本机执行 npm run upgrade:download 下载保管。');
    return {phase:state.phase,maintenance:false};
  } finally {
    await store.release();
  }
}
async function main(){
  const cmd=process.argv[2];
  if(cmd==='--help'){console.log('npm run deploy:cloudflare：Cloudflare 两阶段安全部署；16分钟之后 Retry 同一提交完成。npm run upgrade:download：只下载加密附件。');return;}
  if(cmd && cmd!=='download')throw new Error('未知参数；仅支持 download 或无参数');
  // Bound each command to 15 minutes; never wait the 16-minute drain inside Workers Builds.
  // Hard termination may leave the 25-minute lease to expire; last published checkpoint remains.
  const watchdog=setTimeout(()=>{console.error('[upgrade] ST_SPLIT_BUDGET：本次命令达到15分钟保护上限，保留远端检查点；等待锁到期后 Retry 同一提交。');process.exit(75);},15*60*1000);
  watchdog.unref();
  try{await runSplitDeployment({downloadOnly:cmd==='download'});}finally{clearTimeout(watchdog);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{
  console.error('[upgrade] '+error.message);
  console.error('[upgrade] 未清空/重建任何原库。若已发布维护版本，请保留同一提交与同一备份密码后重试，不删除门禁。');process.exitCode=1;
});
