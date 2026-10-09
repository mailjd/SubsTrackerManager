#!/usr/bin/env node
/** Default Cloudflare Builds release: backup -> one code publication -> runtime verification.
 * Existing KV-only and existing KV+D1 are both valid. No split lease, drain,
 * migration RPC, database creation or forced second build is used on this route.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {Cloudflare,protectBindings} from './upgrade/cloudflare.mjs';
import {assertSameBindingIdentity} from './upgrade/worker-bindings.mjs';
import {checkDeploymentEnvironment,readWranglerConfig} from './upgrade/deploy-environment.mjs';
import {sourceFingerprint,checkpointPrefixes} from './upgrade/cloudflare-checkpoints.mjs';
import {verifyReleaseChecks} from './upgrade/release-checks.mjs';
import {localWrangler} from './upgrade/local-toolchain.mjs';
import {VERSION} from '../src/version.js';
import {DIRECT_MODE,DIRECT_CONFIG,DIRECT_PLAN,directError,inspectDirectBundle,makeDirectConfig,saveDirectBackup,readDirectBackup,writeDirectPlan,assertDirectGuard,privateWrite} from './upgrade/direct-release.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export async function readActiveRelease(cf,worker){
  const data=(await cf.request('/workers/scripts/'+encodeURIComponent(worker)+'/deployments')).result;
  const current=data?.deployments?.[0];
  if(!UUID.test(current?.id||'')||current?.versions?.length!==1||current.versions[0].percentage!==100||!UUID.test(current.versions[0].version_id||''))
    throw directError('ST_DIRECT_ACTIVE','无法确认单一现行版本；不会覆盖不明目标或灰度发布。');
  return {deploymentId:current.id,versionId:current.versions[0].version_id};
}
export async function probeRuntime(url,{fetchImpl=fetch,allowLegacy=false}={}){
  const response=await fetchImpl(url+'/api/upgrade/status',{method:'GET',redirect:'manual',headers:{'Cache-Control':'no-store'},signal:AbortSignal.timeout(20000)});
  const text=await response.text();
  // Legacy app versions did not expose this endpoint. Do not treat server errors,
  // Cloudflare Access redirects, or failed JSON status as proof of a usable release.
  if(allowLegacy&&[401,403,404].includes(response.status))return null;
  if(!response.ok)throw directError('ST_DIRECT_STATUS','无法核验原网站状态（HTTP '+response.status+'）；不会推断升级已经完成。');
  let data;try{data=JSON.parse(text);}catch{if(allowLegacy&&/<!doctype\s+html|<html[\s>]/i.test(text))return null;throw directError('ST_DIRECT_STATUS','网站未返回升级状态 JSON。');}
  if(typeof data?.maintenance!=='boolean'||typeof data?.runId!=='string'||typeof data?.version!=='string'){
    if(allowLegacy&&data?.success!==false)return null;
    throw directError('ST_DIRECT_STATUS','升级状态字段不完整。');
  }
  return data;
}
function publish(root,plan,env,timeout){
  const tool=localWrangler(root);
  console.log('[upgrade] ST_DIRECT_PUBLISH '+JSON.stringify({version:VERSION,worker:plan.worker,wrangler:tool.version,mode:DIRECT_MODE,maintenanceStage:false}));
  const result=spawnSync(tool.command,[tool.entry,'deploy','--config',path.join(root,DIRECT_CONFIG),'--keep-vars'],{cwd:root,stdio:'inherit',timeout,env:{...env,SUBSTRACKER_DIRECT_DEPLOY_RUN:plan.runId,SUBSTRACKER_SAFE_DEPLOY_RUN:''}});
  if(result.status!==0)throw directError('ST_DIRECT_PUBLISH_FAILED','Wrangler 未正常返回（exit='+result.status+'）；可能已上传，必须核对线上状态。不会回滚资料或假报成功。');
}
/** Parameters are dependency injection for isolated tests, not CLI/env bypasses. */
export async function runDirectDeployment({root=ROOT,env=process.env,cf,checkRelease=verifyReleaseChecks,publisher=publish,fetchImpl=fetch,pause=sleep,now=Date.now,deadline=Date.now()+15*60*1000}={}){
  checkDeploymentEnvironment(root,env,{allowWorkersBuilds:true});
  const config=readWranglerConfig(root,env);
  cf ||= new Cloudflare({accountId:env.CLOUDFLARE_ACCOUNT_ID,token:env.CLOUDFLARE_API_TOKEN});
  const budget=()=>{if(now()+5000>=deadline)throw directError('ST_DIRECT_BUDGET','本次部署达到时间保护上限；未确认完成，详见最后发布阶段日志。');};
  console.log('[upgrade] ST_DEPLOY_ENTRY '+JSON.stringify({version:VERSION,entry:'deploy:cloudflare',mode:DIRECT_MODE,continuation:'single-build'}));
  const settings=await cf.settings(config.name,{requireD1:true});
  const bindings=protectBindings(config,settings);
  const active=await readActiveRelease(cf,config.name);
  console.log('[upgrade] ST_DIRECT_BINDINGS_OK '+JSON.stringify({worker:config.name,storage:bindings.dbId?'KV+D1':'KV-only',d1Required:false,originalBindings:true}));
  const schedules=await cf.schedules(config.name),domain=await cf.scriptSubdomain(config.name);
  let url=env.SUBSTRACKER_WORKER_URL;
  if(!url){
    if(!domain?.enabled)throw directError('ST_DIRECT_URL','原 Worker 未启用 workers.dev；请沿用 SUBSTRACKER_WORKER_URL 指定原有 HTTPS 域名。');
    const sub=await cf.accountSubdomain();if(!sub?.subdomain)throw directError('ST_DIRECT_URL','无法读取原 workers.dev 子域。');
    url='https://'+config.name+'.'+sub.subdomain+'.workers.dev';
  }
  url=new URL(url).origin;
  const oldStatus=await probeRuntime(url,{fetchImpl,allowLegacy:true});
  if(oldStatus?.maintenance)throw directError('ST_DIRECT_ACTIVE_MAINTENANCE','线上已有未完成的数据迁移；直接更新不会伪造该批次的验收标记或覆盖正在迁移的版本。');
  // Full original release regression list is retained. KV-only is accepted BEFORE
  // running it; no environment switch disables the checks.
  checkRelease(root,deadline-90000);
  const sourceHash=sourceFingerprint(root);
  const confirm=async()=>{
    budget();
    assertSameBindingIdentity(bindings,protectBindings(config,await cf.settings(config.name,{requireD1:true})));
    const current=await readActiveRelease(cf,config.name);
    if(JSON.stringify(current)!==JSON.stringify(active))throw directError('ST_DIRECT_CONCURRENT','预检后出现其他发布；停止覆盖。此检查不是分布式原子锁，请勿并行部署同一 Worker。');
  };
  await confirm();
  const database=bindings.dbId?await cf.database(bindings.dbId):null;
  await cf.namespace(bindings.kvId);
  const backupId=crypto.randomUUID(),runId=VERSION+'-direct-'+backupId;
  const deploymentConfig=makeDirectConfig(config,{bindings,database,schedules,domain,accountId:cf.accountId});
  console.log('[upgrade] ST_DIRECT_BACKUP_START：在线只读快照；原站继续运行，不宣称获得停机事务快照。');
  const kv=await cf.snapshotKV(bindings.kvId,{excludePrefix:checkpointPrefixes(cf.accountId,config.name).artifact});
  const d1Sql=bindings.dbId?await cf.exportSQL(bindings.dbId):null;
  const payload={format:'substracker-full-storage',version:1,appVersion:VERSION,backupId,runId,accountId:cf.accountId,worker:config.name,bindings,
    capturedAt:new Date(now()).toISOString(),snapshotConsistency:'live-non-transactional',kv,d1Sql,
    workerSettings:settings,previousDeployment:active,originalWrangler:fs.readFileSync(path.join(root,'wrangler.toml'),'utf8'),
    workerContentBase64:(await cf.request('/workers/scripts/'+encodeURIComponent(config.name),{raw:true})).toString('base64'),secretValuesExported:false};
  const compatibility=inspectDirectBundle(payload);
  const backup=await saveDirectBackup(cf,{root,worker:config.name,bindings,backupId,password:env.SUBSTRACKER_BACKUP_PASSWORD,payload,beforeWrite:confirm,pause});
  console.log('[upgrade] ST_DIRECT_BACKUP_OK '+JSON.stringify({backupId,remoteVerified:true,kvKeys:compatibility.kvKeys,snapshotConsistency:compatibility.snapshotConsistency}));
  const plan={format:'substracker-direct-plan-v1',mode:DIRECT_MODE,version:VERSION,runId,backupId,accountId:cf.accountId,worker:config.name,url,bindings,sourceHash,config:deploymentConfig,backup,compatibility,previousDeployment:active,phase:'ready'};
  const releaseFile=path.join(root,'src/upgrade-release.js'),originalRelease=fs.readFileSync(releaseFile);
  let publishAttempted=false;
  try{
    writeDirectPlan(root,plan);
    assertDirectGuard(root,{...env,SUBSTRACKER_DIRECT_DEPLOY_RUN:runId});
    await confirm();
    // Do not rely on a snapshot of the original status after minutes of tests/backup.
    const latestStatus=await probeRuntime(url,{fetchImpl,allowLegacy:true});
    if(latestStatus?.maintenance)throw directError('ST_DIRECT_ACTIVE_MAINTENANCE','预检后原站进入维护模式，停止本次发布。');
    publishAttempted=true;
    await publisher(root,plan,env,Math.max(1,Math.min(600000,deadline-now()-30000)));
    let status,lastError;
    for(let i=0;i<40;i++){
      budget();
      try{status=await probeRuntime(url,{fetchImpl});if(status.success===true&&status.version===VERSION&&status.runId===runId&&status.mode===DIRECT_MODE&&status.maintenance===false)break;}
      catch(e){lastError=e;}
      if(i<39)await pause(3000);
    }
    if(status?.success!==true||status.version!==VERSION||status.runId!==runId||status.mode!==DIRECT_MODE||status.maintenance!==false)
      throw directError('ST_DIRECT_VERIFY','已执行发布，但未确认新版正常启站；不报告完成。'+(lastError?' '+lastError.message:''));
    assertSameBindingIdentity(bindings,protectBindings(config,await cf.settings(config.name,{requireD1:true})));
    plan.phase='complete';privateWrite(path.join(root,DIRECT_PLAN),JSON.stringify(plan,null,2));
    const report={version:VERSION,mode:DIRECT_MODE,worker:config.name,runId,maintenance:false,bindingsVerified:true,backupId,backupSha256:backup.sha256,historicalBackfill:'not-run',completedAt:new Date(now()).toISOString()};
    privateWrite(path.join(root,'upgrade-backups',backupId+'-deployment.json'),JSON.stringify(report,null,2));
    console.log('[upgrade] ST_UPGRADE_COMPLETE '+JSON.stringify(report));
    console.log('[upgrade] 直接升级完成；无需等待16分钟或再次运行。下载备份：npm run upgrade:download -- '+backupId);
    return report;
  }catch(error){
    console.error('[upgrade] ST_DIRECT_NOT_COMPLETE '+JSON.stringify({publishAttempted,backupId,maintenanceStage:false}));throw error;
  }finally{
    // Never leave a generated release mode in the developer checkout, and never
    // modify the user's original wrangler.toml. Diagnostics/backups remain local.
    privateWrite(releaseFile,originalRelease);
    fs.rmSync(path.join(root,DIRECT_CONFIG),{force:true});
  }
}
export async function downloadDirectBackup(backupId,{root=ROOT,env=process.env}={}){
  checkDeploymentEnvironment(root,env,{allowWorkersBuilds:true});
  const config=readWranglerConfig(root,env),cf=new Cloudflare({accountId:env.CLOUDFLARE_ACCOUNT_ID,token:env.CLOUDFLARE_API_TOKEN});
  const bindings=protectBindings(config,await cf.settings(config.name,{requireD1:true}));
  const {bytes}=await readDirectBackup(cf,{worker:config.name,kvId:bindings.kvId,backupId,password:env.SUBSTRACKER_BACKUP_PASSWORD});
  const file=path.join(root,'upgrade-backups',backupId+'.stbackup');privateWrite(file,bytes);
  console.log('[upgrade] ST_DIRECT_BACKUP_DOWNLOADED '+JSON.stringify({backupId,file,remoteWrites:false,uploaded:false}));
}
