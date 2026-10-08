#!/usr/bin/env node
/** Upgrade entry point. Production writes occur only at stage (deploy) and finish (additive migration).
 * Usage: node scripts/safe-upgrade.mjs prepare|stage|finish|all|resume [encrypted-state-file]
 * Required env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, SUBSTRACKER_BACKUP_PASSWORD.
 * Optional: SUBSTRACKER_WORKER_NAME, SUBSTRACKER_WORKER_URL, SUBSTRACKER_ENVIRONMENT, PYTHON.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {Cloudflare,protectBindings} from './upgrade/cloudflare.mjs';
import {encryptArchive,decryptArchive,inspectBundle,assertOriginalsPreserved} from './upgrade/archive.mjs';
import {sha256,stableJSON} from '../src/data/upgrade-reconcile.js';
import {VERSION} from '../src/version.js';
import {checkDeploymentEnvironment,assertSupportedDeploymentHost,readWranglerConfig} from './upgrade/deploy-environment.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const STATE_DIR=path.join(ROOT,'.upgrade');
const BACKUPS=path.join(ROOT,'upgrade-backups');
const STATE=path.join(STATE_DIR,'state.stbackup');
const CONFIG=path.join(ROOT,'wrangler.upgrade.json');
function password(){const v=process.env.SUBSTRACKER_BACKUP_PASSWORD||'';if(v.length<16)throw new Error('请先设置 SUBSTRACKER_BACKUP_PASSWORD（至少16字符），加密保护完整备份；尚未修改线上数据');return v;}
function savePrivate(file,bytes){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.tmp';fs.writeFileSync(tmp,bytes,{mode:0o600});fs.renameSync(tmp,file);}
export function saveState(state){const bytes=encryptArchive(state,password());savePrivate(STATE,bytes);savePrivate(path.join(BACKUPS,state.runId+'-resume.stbackup'),bytes);}
export function loadState(){if(!fs.existsSync(STATE))throw new Error('缺少升级状态，请先执行 prepare；若恢复中断流程，请使用 resume 加密状态文件');return decryptArchive(fs.readFileSync(STATE),password());}
function cfClient(){return new Cloudflare({accountId:process.env.CLOUDFLARE_ACCOUNT_ID,token:process.env.CLOUDFLARE_API_TOKEN});}
export function readConfig(){ return readWranglerConfig(ROOT); }
async function assertBindingIdentity(cf,state){
  if(cf.accountId!==state.accountId)throw new Error('Cloudflare 帐户与备份不一致，已停止');
  const settings=await cf.settings(state.worker);
  const bound=protectBindings(state.config,settings);
  if(bound.kvId!==state.bindings.kvId||bound.dbId!==state.bindings.dbId)throw new Error('线上存储绑定在升级中发生变化，已停止');
  if(stableJSON(bound.secretNames)!==stableJSON(state.bindings.secretNames))throw new Error('Worker Secret 名称发生变化，已停止');
  const normalize=vars=>vars.map(b=>({name:b.name,type:b.type,...(b.type==='json'?{json:typeof b.json==='string'?JSON.parse(b.json):b.json}:{text:b.text})})).sort((a,b)=>a.name.localeCompare(b.name));
  if(stableJSON(normalize(bound.variables))!==stableJSON(normalize(state.bindings.variables)))throw new Error('Worker Variables 内容发生变化，已停止');
  return settings;
}
async function snapshot(cf,state){
  const settings=await assertBindingIdentity(cf,state);
  const kv=await cf.snapshotKV(state.bindings.kvId,{excludePrefix:state.remoteArtifactsPrefix});
  const d1Sql=state.bindings.dbId?await cf.exportSQL(state.bindings.dbId):null;
  return {format:'substracker-full-storage',version:1,appVersion:VERSION,runId:state.runId,accountId:state.accountId,worker:state.worker,bindings:state.bindings,
    capturedAt:new Date().toISOString(),kv,d1Sql,workerSettings:settings,originalWrangler:state.originalWrangler,
    secretValuesExported:false,secretNotice:'Cloudflare Worker Secrets 的值不能通过读取 API 获取；升级保留同一 Worker 和 Secret 名称，不重置它们。'};
}
async function stableBackup(cf,state,phase){
  console.log(`[upgrade] ${phase}：读取完整 KV 和 D1，进行两次独立扫描与内存还原验证...`);
  const first=await snapshot(cf,state),a=await inspectBundle(first);
  await sleep(1000);
  const second=await snapshot(cf,state),b=await inspectBundle(second);
  if(a.summary.kvDigest!==b.summary.kvDigest||a.summary.sqlDigest!==b.summary.sqlDigest)throw new Error('两次存储扫描不一致（仍有写入/过期或镜像同步），未继续升级；请暂停外部写入后重试');
  // Include the exact prior Worker download in the encrypted backup for recovery reference.
  if(phase==='before-deploy')second.workerContentBase64=(await cf.request(`/workers/scripts/${encodeURIComponent(state.worker)}`,{raw:true})).toString('base64');
  const bytes=encryptArchive(second,password()),decoded=decryptArchive(bytes,password());
  if(stableJSON(decoded)!==stableJSON(second))throw new Error('加密备份回读校验失败');
  const restored=await inspectBundle(decoded);
  if(stableJSON(restored.summary)!==stableJSON(b.summary))throw new Error('加密备份还原后的数据校验不一致');
  const filename=state.runId+'-'+phase+'.stbackup';savePrivate(path.join(BACKUPS,filename),bytes);
  const manifest={phase,runId:state.runId,version:VERSION,archive:filename,archiveSha256:crypto.createHash('sha256').update(bytes).digest('hex'),restoreVerified:true,...b.summary};
  savePrivate(path.join(BACKUPS,state.runId+'-'+phase+'-manifest.json'),JSON.stringify(manifest,null,2));
  console.log(`[upgrade] 备份通过：KV ${b.summary.kvCount} keys；订阅 ${b.summary.counts.total}；待补历史 ${b.summary.newHistory}。`);
  return {filename,manifest};
}
export function writeGenerated(state){
  savePrivate(CONFIG,JSON.stringify(state.config,null,2));
  savePrivate(path.join(ROOT,'src/upgrade-release.js'),`// Generated for this one verified upgrade; contains only a capability hash.\nexport const UPGRADE_RUN=Object.freeze(${JSON.stringify({version:VERSION,id:state.runId,tokenHash:crypto.createHash('sha256').update(state.token).digest('hex')})});\n`);
}
export async function prepare(options={}){
  checkDeploymentEnvironment(ROOT,process.env,options);
  password();const cf=cfClient(),config=readConfig();
  const settings=await cf.settings(config.name); // 404/permission errors STOP. Never create a new worker/store.
  const bindings=protectBindings(config,settings);
  const namespace=await cf.namespace(bindings.kvId);
  const database=bindings.dbId?await cf.database(bindings.dbId):null;
  const schedules=await cf.schedules(config.name);
  const domain=await cf.scriptSubdomain(config.name);
  let workerUrl=process.env.SUBSTRACKER_WORKER_URL;
  if(!workerUrl){if(!domain?.enabled)throw new Error('此 Worker 未启用 workers.dev；请设置 SUBSTRACKER_WORKER_URL 为现有自定义域名');const sub=await cf.accountSubdomain();if(!sub?.subdomain)throw new Error('无法确定 workers.dev 地址');workerUrl=`https://${config.name}.${sub.subdomain}.workers.dev`;}
  const parsed=new URL(workerUrl);if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.search||parsed.hash)throw new Error('Worker URL 必须是有效 HTTPS 源地址');
  const originalWrangler=fs.readFileSync(path.join(ROOT,'wrangler.toml'),'utf8');
  config.main='src/index.js';config.keep_vars=true;config.build={...(config.build||{}),command:'node scripts/require-safe-upgrade.mjs'};config.assets={...(config.assets||{}),directory:'./public',binding:'ASSETS'};
  config.kv_namespaces=[{binding:'SUBSCRIPTIONS_KV',id:bindings.kvId,...(config.kv_namespaces?.[0]?.preview_id?{preview_id:config.kv_namespaces[0].preview_id}:{})}];
  config.d1_databases=database?[{binding:'SUBSCRIPTIONS_DB',database_id:bindings.dbId,database_name:database.name,migrations_dir:'migrations'}]:[];
  config.triggers={crons:schedules.map(s=>s.cron)};config.workers_dev=!!domain.enabled;
  // Preserve runtime values, not the template's defaults. Do not retrieve/change secrets.
  config.vars=Object.fromEntries(bindings.variables.map(b=>[b.name,b.type==='json'?(typeof b.json==='string'?JSON.parse(b.json):b.json):b.text]));
  // Avoid account drift if a developer's local TOML belongs to another account.
  if(config.account_id&&config.account_id!==cf.accountId)throw new Error('Wrangler account_id 与当前 Token 的账号不一致');
  config.account_id=cf.accountId;
  const state={format:'substracker-upgrade-state',version:VERSION,runId:VERSION+'-'+crypto.randomUUID(),token:crypto.randomBytes(32).toString('hex'),accountId:cf.accountId,worker:config.name,url:parsed.origin,
    bindings,resourceNames:{kv:namespace.title,d1:database?.name||null},config,originalWrangler,phase:'prepared',...(options.allowWorkersBuilds?{deploymentMode:'cloudflare-split',remoteArtifactsPrefix:options.remoteArtifactsPrefix,remoteControlPrefix:options.remoteControlPrefix,sourceHash:options.sourceHash}:{})};
  const backup=await stableBackup(cf,state,'before-deploy');state.preBackup=backup;
  writeGenerated(state);saveState(state);
  console.log('[upgrade] 升级前检查与加密备份完成；原 wrangler.toml、数据库及密码/密钥均未改写。');
  return state;
}
export async function workerCall(state,operation,body){
  const url=state.url+'/api/upgrade/'+operation;
  const res=await fetch(url,{method:body?'POST':'GET',redirect:'error',headers:{'Cache-Control':'no-store',...(body?{'Content-Type':'application/json','X-Upgrade-Token':state.token}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(120000)});
  let data;try{data=await res.json();}catch{throw new Error('Worker 返回非 JSON；请检查域名/Access 访问权限');}
  if(!res.ok||data.success===false){const error=new Error(data.message||`Worker HTTP ${res.status}`);error.httpStatus=res.status;throw error;}
  return data;
}
export async function stage(options={}){
  assertSupportedDeploymentHost(process.env,options);
  const state=loadState(),cf=cfClient();await assertBindingIdentity(cf,state);
  if(!state.preBackup)throw new Error('尚无升级前备份');
  if(state.applyIntent||state.applied)throw new Error('迁移已开始，禁止重建该批次基线；请执行 finish/resume，冲突核对后另开新批次');
  if(state.phase==='prepared' && options.allowWorkersBuilds){
    let online;
    try{online=await workerCall(state,'status');}catch(error){if(![401,403,404].includes(error.httpStatus)&&!/非 JSON/.test(error.message))throw error;}
    if(online?.runId===state.runId && online.maintenance){
      state.phase='staged';state.stagedAt=Date.now();saveState(state);
      await options.checkpoint?.(state); // Conservative 16-minute drain from first confirmed observation.
    }else if(online?.maintenance){throw new Error('线上另一个升级尚未完成，禁止覆盖维护版本；恢复原批次');}
  }
  if(state.phase==='prepared'){
    await options.beforeWrite?.();
    await options.checkpoint?.(state);
    writeGenerated(state);
    const npx=process.platform==='win32'?'npx.cmd':'npx';
    // --no-install prevents unexpectedly using a different CLI when dependencies are missing.
    const deployed=spawnSync(npx,['--no-install','wrangler','deploy','--config',CONFIG],{cwd:ROOT,stdio:'inherit',timeout:options.deployTimeoutMs?.()||600000,env:{...process.env,SUBSTRACKER_SAFE_DEPLOY_RUN:state.runId}});
    if(deployed.status!==0)throw new Error('部署命令失败；保留备份和原存储，请检查线上版本');
    state.phase='staged';state.stagedAt=Date.now();saveState(state);await options.checkpoint?.(state);
  }
  let status;
  for(let n=0;n<60;n++){
    try{status=await workerCall(state,'status');if(status.runId===state.runId&&status.version===VERSION&&status.maintenance)break;}catch{}
    await sleep(2000);
  }
  if(status?.runId!==state.runId||!status.maintenance)throw new Error('未确认新版处于维护模式，已停止');
  // Conservative drain for old in-flight Cron jobs. This is not a lock against external writers.
  const drainMs=16*60*1000;
  const remaining=Math.max(0,drainMs-(Date.now()-(state.stagedAt||Date.now())));
  if(remaining && options.pauseForDrain){state.readyAfter=state.stagedAt+drainMs;saveState(state);await options.checkpoint?.(state);return state;}
  if(remaining){console.log(`[upgrade] 维护模式已确认；等待旧请求/定时任务结束，约 ${Math.ceil(remaining/60000)} 分钟。请勿从其他脚本写入数据库。`);await sleep(remaining);}
  await options.beforeWrite?.();
  state.maintenanceBackup=await stableBackup(cf,state,'maintenance');state.phase='backed-up';saveState(state);await options.checkpoint?.(state);
  console.log('[upgrade] 维护期备份已验证。GitHub 工作流会先保留加密附件，再执行迁移。');
  return state;
}
export async function finish(options={}){
  assertSupportedDeploymentHost(process.env,options);
  const state=loadState(),cf=cfClient();await assertBindingIdentity(cf,state);
  if(!state.maintenanceBackup)throw new Error('缺少维护期备份，不能提交升级');
  const bytes=fs.readFileSync(path.join(BACKUPS,state.maintenanceBackup.filename));
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==state.maintenanceBackup.manifest.archiveSha256)throw new Error('维护期备份文件校验码不匹配');
  const before=decryptArchive(bytes,password()),original=await inspectBundle(before);
  const status=await workerCall(state,'status');
  if(status.runId!==state.runId)throw new Error('在线 Worker 不是本次升级版本，请勿混用另一次升级状态');
  if(!status.maintenance){
    const confirmation=await workerCall(state,'report',{});
    if(!confirmation.ready||confirmation.report?.runId!==state.runId||confirmation.report?.backupSha256!==state.maintenanceBackup.manifest.archiveSha256)throw new Error('线上完成凭证与本次备份不一致');
    if(state.preCommitVerification && state.preCommitVerification.reportDigest!==confirmation.report.reportDigest)throw new Error('线上完成摘要与本地验收不一致');
    savePrivate(path.join(BACKUPS,state.runId+'-acceptance.json'),JSON.stringify({version:VERSION,runId:state.runId,ready:true,recoveredAcknowledgement:true,serverVerification:confirmation.report,localVerification:state.preCommitVerification||null},null,2));
    state.phase='complete';saveState(state);await options.checkpoint?.(state);console.log('[upgrade] 本次升级已完成，已恢复完成凭证。');return state;
  }
  let applied=state.applied;
  if(!applied && status.phase==='applied'){
    applied=await workerCall(state,'report',{});
    if(applied.report?.backupReceipt?.archiveSha256!==state.maintenanceBackup.manifest.archiveSha256)throw new Error('服务器报告与恢复的维护备份不一致');
    state.applied=applied;state.phase='applied';saveState(state);await options.checkpoint?.(state);
  }
  if(!applied){
    if(!state.applyIntent && status.phase==='writing'){
      const progress=await workerCall(state,'progress',{});
      if(progress.started?.backupReceipt?.archiveSha256!==state.maintenanceBackup.manifest.archiveSha256||progress.started?.sourceDigest!==original.summary.sourceDigest)throw new Error('服务器分批进度与本次备份不一致');
      state.applyIntent={expectedSourceDigest:original.summary.sourceDigest,backupReceipt:progress.started.backupReceipt};saveState(state);
    }
    const actual=await snapshot(cf,state),pre=await inspectBundle(actual);
    if(state.applyIntent){assertOriginalsPreserved(before,actual,original.image,pre.image);if(pre.summary.sourceDigest!==original.summary.sourceDigest)throw new Error('分批恢复时原始订阅来源发生变化');}
    else {
      const {assertSameBaseline}=await import('./upgrade/split-baseline.mjs');
      assertSameBaseline(before,actual,original,pre,state.remoteControlPrefix);
      state.applyIntent={expectedSourceDigest:original.summary.sourceDigest,backupReceipt:{runId:state.runId,verified:true,archiveSha256:state.maintenanceBackup.manifest.archiveSha256,ledgerCount:original.summary.existingHistory}};state.phase='applying';saveState(state);
    }
    await options.checkpoint?.(state);
    let remaining=Infinity;
    for(let step=0;step<100000;step++){
      await options.beforeWrite?.();
      applied=await workerCall(state,'apply',state.applyIntent);
      if(!applied.pending)break;
      if(!(applied.progress?.remaining<remaining))throw new Error('分批迁移未前进，已停止而不是无限重试');
      remaining=applied.progress.remaining;console.log(`[upgrade] 本批 ${applied.progress.written} 条，待处理 ${remaining} 条。`);
    }
    if(applied.pending)throw new Error('迁移分批次数超过保护上限');
    state.applied=applied;state.phase='applied';saveState(state);await options.checkpoint?.(state);
  }
  const after=await snapshot(cf,state),post=await inspectBundle(after);
  assertOriginalsPreserved(before,after,original.image,post.image);
  // Post-migration encrypted snapshot provides an independent restore point before unlocking.
  const postBytes=encryptArchive(after,password());const postDecoded=decryptArchive(postBytes,password());await inspectBundle(postDecoded);
  savePrivate(path.join(BACKUPS,state.runId+'-after-migration.stbackup'),postBytes);
  state.preCommitVerification={reportDigest:applied.reportDigest,originalsVerified:true,restoreVerified:true,postArchiveSha256:crypto.createHash('sha256').update(postBytes).digest('hex')};state.phase='verified';saveState(state);await options.checkpoint?.(state);await options.beforeWrite?.();
  const committed=await workerCall(state,'commit',{reportDigest:applied.reportDigest,originalsVerified:true,restoreVerified:true});
  if(!committed.ready)throw new Error('服务器没有确认升级完成');
  const finalStatus=await workerCall(state,'status');if(finalStatus.maintenance||finalStatus.runId!==state.runId)throw new Error('验收后维护状态异常');
  const report={version:VERSION,runId:state.runId,ready:true,bindingsPreserved:true,originalsVerified:true,restoreVerified:true,backup:state.maintenanceBackup.manifest,
    migration:applied.report,completedAt:new Date().toISOString()};
  savePrivate(path.join(BACKUPS,state.runId+'-acceptance.json'),JSON.stringify(report,null,2));state.phase='complete';saveState(state);await options.checkpoint?.(state);
  console.log('[upgrade] 升级完成：原始记录逐项保留、历史补齐、加密备份还原与原绑定核验均通过。');
  console.log('[upgrade] 加密备份与验收报告目录：upgrade-backups/（请保留备份密码，勿提交备份文件到 Git）。');
  return state;
}
async function main(){
  const cmd=process.argv[2]||'all';
  if(cmd==='--help'||cmd==='help'){console.log('prepare → stage → finish；或 all。resume <加密恢复状态文件> 继续中断升级。先执行 npm run deploy:check；Cloudflare Git 直连请先阅读 CLOUDFLARE_SPLIT_DEPLOY_3.3.23.md。详见 SAFE_UPGRADE_3.3.23.md。');return;}
  assertSupportedDeploymentHost();
  if(cmd==='prepare')await prepare();
  else if(cmd==='stage')await stage();
  else if(cmd==='finish')await finish();
  else if(cmd==='all'){await prepare();await stage();await finish();}
  else if(cmd==='resume'){
    if(!process.argv[3])throw new Error('请提供加密 resume.stbackup 文件路径');
    const state=decryptArchive(fs.readFileSync(path.resolve(process.argv[3])),password());
    if(state.format!=='substracker-upgrade-state'||state.version!==VERSION)throw new Error('恢复状态版本不匹配');
    saveState(state);writeGenerated(state);
    if(['prepared','staged'].includes(state.phase))await stage();
    await finish();
  }else throw new Error('未知命令：'+cmd);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error('[upgrade] '+(e.code||'ST_UPGRADE_STOP')+' 已停止：'+e.message);console.error('没有清空/新建/改绑数据库；若已进入维护模式，请保留 upgrade-backups 加密附件并按文档继续或回滚代码。');process.exitCode=1;});
