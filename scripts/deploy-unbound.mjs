#!/usr/bin/env node
/** v3.3.34: publish an authenticated waiting/init application, preserving live bindings.
 * Only Worker control-plane GETs are allowed here. No data API, resource creation,
 * backup, database migration, binding removal/restoration or credential reset is performed.
 * File/export names containing "unbound" are retained for internal compatibility only.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {isDeepStrictEqual} from 'node:util';
import {Cloudflare} from './upgrade/cloudflare.mjs';
import {webInitBindingIdentity,storageSummary,requiredBindings,preservedStorageConfig,assertPreservedStorage,assertWebInitLocalBindings} from './upgrade/web-init-bindings.mjs';
import {readWranglerConfig,assertSupportedDeploymentHost,assertNodeRuntime,validateDeploymentSecrets} from './upgrade/deploy-environment.mjs';
import {sourceFingerprint} from './upgrade/cloudflare-checkpoints.mjs';
import {verifyReleaseChecks} from './upgrade/release-checks.mjs';
import {localWrangler} from './upgrade/local-toolchain.mjs';
import {readActiveRelease} from './deploy-direct.mjs';
import {RELEASE_MARKER,deploymentMarker,assertMarkerAvailable,releaseEvidence,discoverReleaseURLs,verifyReleaseURL} from './upgrade/deployment-evidence.mjs';
import {VERSION} from '../src/version.js';
import {WEB_INIT_MODE} from '../src/data/web-init-protocol.js';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const UNBOUND_CONFIG='wrangler.unbound.json';
export const UNBOUND_PLAN='.upgrade/unbound-plan.json';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function fail(code,message){const e=new Error(code+'：'+message);e.code=code;throw e;}
function write(file,text){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,text,{mode:0o600});}
// Legacy export names: v3.3.34 uses the same web-init path for every storage shape.
const identity=webInitBindingIdentity;
export const assertUnboundSettings=webInitBindingIdentity;
export const assertWebInitSettings=webInitBindingIdentity;
async function readUnbound(cf,worker,options={}){
  const base='/workers/scripts/'+encodeURIComponent(worker);
  const settings=(await cf.request(base+'/settings',options)).result;
  identity(settings); // A missing binding array must never mean 'unbound'.
  const active=await readActiveRelease(cf,worker,options);
  const version=(await cf.request(base+'/versions/'+active.versionId,options)).result;
  if(version?.id!==active.versionId||!Array.isArray(version?.resources?.bindings))fail('ST_UNBOUND_VERSION','現行版本綁定資料不完整；不會把讀取失敗當成沒有綁定。');
  const bindings=identity(settings),deployed=identity({bindings:version.resources.bindings});
  if(!isDeepStrictEqual(bindings,deployed))fail('ST_UNBOUND_NOT_ACTIVE','Settings 與現行版本的綁定／變數不一致；不合併或猜測。'+JSON.stringify({worker,settings:storageSummary(bindings),activeVersion:storageSummary(deployed)}));
  const confirmed=await readActiveRelease(cf,worker,options);
  if(!isDeepStrictEqual(active,confirmed))fail('ST_UNBOUND_CHANGED','讀取期間現行部署改變；沒有合併不同版本的設定。');
  return {settings,bindings,active};
}
export function makeUnboundConfig(original,{settings,schedules,domain,accountId}){
  assertUnboundSettings(settings);
  assertWebInitLocalBindings(original);
  if(!Array.isArray(schedules)||schedules.some(s=>typeof s?.cron!=='string')||typeof domain?.enabled!=='boolean')fail('ST_UNBOUND_CONFIG','無法核對原 Cron 或 workers.dev 設定。');
  const config=structuredClone(original);
  config.account_id=accountId;config.main='src/index.js';config.keep_vars=true;
  config.build={command:'node scripts/require-safe-upgrade.mjs'};
  config.assets={...(config.assets||{}),directory:'./public',binding:'ASSETS'};
  // Rebuild storage ONLY from the agreed live identity, never from local hints.
  // Empty remote sets stay empty; populated sets keep exact names and resource IDs.
  Object.assign(config,preservedStorageConfig(identity(settings)));
  config.vars=Object.fromEntries(identity(settings).filter(b=>['plain_text','json'].includes(b.type)).map(b=>[b.name,b.type==='json'?b.json:b.text]));
  config.triggers={crons:schedules.map(s=>s.cron)};config.workers_dev=domain.enabled;
  if(typeof domain.previews_enabled==='boolean')config.preview_urls=domain.previews_enabled;
  delete config.route;delete config.routes;delete config.migrations;delete config.env;
  return config;
}
export function unboundRelease(plan){return '// Generated for a verified binding-preserving code release; runtime stays locked until authenticated web init.\nexport const UPGRADE_RUN=Object.freeze('+JSON.stringify({version:VERSION,id:plan.runId,mode:WEB_INIT_MODE,tokenHash:''})+');\n';}
export function assertUnboundGuard(root,env=process.env){
  const plan=JSON.parse(fs.readFileSync(path.join(root,UNBOUND_PLAN),'utf8'));
  if(plan.format!=='substracker-web-init-plan-v3'||plan.bindingPolicy!=='preserve-active'||plan.phase!=='ready'||plan.version!==VERSION||!uuid.test(plan.nonce||'')||plan.runId!==VERSION+'-web-init-'+plan.nonce||env.SUBSTRACKER_UNBOUND_DEPLOY_RUN!==plan.runId)fail('ST_UNBOUND_GUARD','缺少本次保留原綁定的發布計畫；單獨設定環境變數不能放行。');
  if(plan.accountId!==env.CLOUDFLARE_ACCOUNT_ID||plan.config.account_id!==plan.accountId||plan.config.name!==plan.worker||plan.checksPassed!==true)fail('ST_UNBOUND_GUARD','發布帳戶、Worker 或驗證紀錄不符。');
  assertUnboundSettings({bindings:plan.bindingIdentity});assertMarkerAvailable(plan.bindingIdentity);
  if(plan.config.vars?.[RELEASE_MARKER]!==deploymentMarker(plan))fail('ST_UNBOUND_GUARD','本次發布識別與來源雜湊不符。');
  const config=JSON.parse(fs.readFileSync(path.join(root,UNBOUND_CONFIG),'utf8'));
  if(!isDeepStrictEqual(config,plan.config)||config.build?.command!=='node scripts/require-safe-upgrade.mjs'||config.main!=='src/index.js'||config.keep_vars!==true)fail('ST_UNBOUND_GUARD','待發布設定已改變。');
  assertWebInitLocalBindings(config);
  assertPreservedStorage(config,plan.bindingIdentity);
  if(sourceFingerprint(root)!==plan.sourceHash||fs.readFileSync(path.join(root,'src/upgrade-release.js'),'utf8')!==unboundRelease(plan))fail('ST_UNBOUND_SOURCE','測試後的原始碼已改變；尚未放行。');
  return plan;
}
function publish(root,plan,env,timeout){
  const tool=localWrangler(root);
  console.log('[upgrade] ST_WEB_INIT_PUBLISH '+JSON.stringify({version:VERSION,worker:plan.worker,bindingPolicy:'preserve-active',storageBindings:storageSummary(plan.bindingIdentity).length}));
  const r=spawnSync(tool.command,[tool.entry,'deploy','--config',path.join(root,UNBOUND_CONFIG),'--keep-vars'],{cwd:root,stdio:'inherit',timeout,env:{...env,SUBSTRACKER_UNBOUND_DEPLOY_RUN:plan.runId,SUBSTRACKER_DIRECT_DEPLOY_RUN:'',SUBSTRACKER_SAFE_DEPLOY_RUN:''}});
  if(r.status!==0)fail('ST_UNBOUND_PUBLISH_FAILED','Wrangler 未正常返回；可能已上傳程式，請核對現行版本，不自動回滾資料。');
}
/** Test injection cannot be enabled through CLI arguments or environment variables. */
export async function runUnboundDeployment({root=ROOT,env=process.env,cf,checkRelease=verifyReleaseChecks,publisher=publish,fetchImpl=fetch,pause=sleep,now=Date.now,deadline=Date.now()+15*60*1000}={}){
  let stage='preflight',attempted=false,codeDeployed=false,plan,old;
  const file=path.join(root,'src/upgrade-release.js');
  // Do not allow an old local success report to survive a failed fresh attempt.
  fs.rmSync(path.join(root,'.upgrade/unbound-result.json'),{force:true});
  try{
    assertSupportedDeploymentHost(env,{allowWorkersBuilds:true});assertNodeRuntime();validateDeploymentSecrets(env,{requireBackup:false});
    // URL is not a configuration precondition for a binding-preserving code release.
    const config=readWranglerConfig(root,env,{validateURL:false});
    cf ||= new Cloudflare({accountId:env.CLOUDFLARE_ACCOUNT_ID,token:env.CLOUDFLARE_API_TOKEN});
    if(cf.accountId!==env.CLOUDFLARE_ACCOUNT_ID)fail('ST_UNBOUND_ACCOUNT','API 帳戶與本次 Build 帳戶不一致；未發布。');
    console.log('[upgrade] ST_DEPLOY_ENTRY '+JSON.stringify({version:VERSION,entry:'deploy:cloudflare',mode:WEB_INIT_MODE,intent:'preserve-bindings-then-web-init',bindingPolicy:'preserve-active',automaticFallback:false}));
    console.log('[upgrade] ST_DEPLOY_TARGET '+JSON.stringify({worker:config.name,environment:env.SUBSTRACKER_ENVIRONMENT||'top-level',accountId:cf.accountId,expectedStorageBindings:'preserve-active'}));
    const original=await readUnbound(cf,config.name);
    const stores=storageSummary(original.bindings),required=requiredBindings(original.bindings);
    console.log('[upgrade] ST_WEB_INIT_BINDINGS_PRESERVED '+JSON.stringify({worker:config.name,bindings:stores,requiredBindings:required,source:'settings-and-active-version',dataAPICalls:0}));
    const schedules=await cf.schedules(config.name),domain=await cf.scriptSubdomain(config.name);
    assertMarkerAvailable(original.bindings);
    // Validate ALL publication settings before the expensive release checks.
    const publicationConfig=makeUnboundConfig(config,{settings:original.settings,schedules,domain,accountId:cf.accountId});
    const urls=await discoverReleaseURLs(cf,{worker:config.name,domain,explicit:env.SUBSTRACKER_WORKER_URL});
    console.log('[upgrade] ST_WEB_INIT_PREFLIGHT '+JSON.stringify({worker:config.name,storageBindings:stores.length,workersDev:domain.enabled,urlRequiredForCodeDeploy:false,urlCandidates:urls.candidates,urlWarnings:urls.warnings,dataAPICalls:0}));
    const budget=()=>{if(now()+5000>=deadline)fail('ST_UNBOUND_BUDGET','發布時間保護上限；請依 codeDeployed / stage 判斷是否已發布，不自動重跑或回滾。');};
    console.log('[upgrade] ST_WEB_INIT_CONFIRMED '+JSON.stringify({version:VERSION,worker:config.name,storageBindings:stores.length,dataAPICalls:0,next:'/init'}));
    // Never query the old runtime: an unbound old release may return 500/503.
    stage='release-checks';budget();await checkRelease(root,deadline-90000);
    const sourceHash=sourceFingerprint(root);
    const confirm=async()=>{
      budget();const current=await readUnbound(cf,config.name);
      if(!isDeepStrictEqual(current.bindings,original.bindings)||!isDeepStrictEqual(current.active,original.active))fail('ST_UNBOUND_CHANGED','測試期間綁定或版本改變；不會覆蓋另一個發布。');
      if(!isDeepStrictEqual(await cf.schedules(config.name),schedules)||!isDeepStrictEqual(await cf.scriptSubdomain(config.name),domain))fail('ST_UNBOUND_CHANGED','測試期間 Cron 或網域設定改變，已停止以免覆蓋新設定。');
    };
    stage='pre-publish';await confirm();
    const nonce=crypto.randomUUID();
    plan={format:'substracker-web-init-plan-v3',bindingPolicy:'preserve-active',phase:'ready',version:VERSION,nonce,runId:VERSION+'-web-init-'+nonce,worker:config.name,accountId:cf.accountId,urlCandidates:urls.candidates,sourceHash,checksPassed:true,bindingIdentity:original.bindings,previousDeployment:original.active,config:publicationConfig};
    plan.config.vars[RELEASE_MARKER]=deploymentMarker(plan);
    old=fs.readFileSync(file);
    write(path.join(root,UNBOUND_PLAN),JSON.stringify(plan,null,2));write(path.join(root,UNBOUND_CONFIG),JSON.stringify(plan.config,null,2));write(file,unboundRelease(plan));
    assertUnboundGuard(root,{...env,SUBSTRACKER_UNBOUND_DEPLOY_RUN:plan.runId});await confirm();
    stage='publishing';attempted=true;codeDeployed=null;
    await publisher(root,plan,env,Math.max(1,Math.min(600000,deadline-now()-60000)));
    stage='control-verification';
    let verified,lastReason='active-version-not-this-release';
    // Observe only CURRENT deployments. Latest-uploaded-but-inactive is not proof.
    for(let n=0;n<15;n++){
      budget();
      try{
        const after=await readUnbound(cf,config.name,{timeoutMs:8000,maxAttempts:1});
        if(releaseEvidence(plan,after)){verified=after;break;}
      }catch(error){
        // Configuration drift is not treated as transient success.
        if(/ST_UNBOUND_(?:CHANGED|OTHER_BINDING)|ST_WEB_INIT_(?:KV_ID|D1_ID)|ST_BINDING_D1_ID/.test(error.message))throw error;
        lastReason=error.code||'control-plane-unavailable-or-not-active';
      }
      if(n<14)await pause(2000);
    }
    if(!verified)fail('ST_UNBOUND_CONTROL_VERIFY','Wrangler 已返回，但未核對到本次現行版本及發布識別（'+lastReason+'）；不報告程式部署成功。');
    // Re-check non-storage configuration after upload as well.
    if(!isDeepStrictEqual(await cf.schedules(config.name),schedules)||!isDeepStrictEqual(await cf.scriptSubdomain(config.name),domain))fail('ST_UNBOUND_CHANGED','發布後 Cron 或 workers.dev 設定不符；請核對，未回滾。');
    codeDeployed=true;
    const report={version:VERSION,mode:WEB_INIT_MODE,worker:config.name,runId:plan.runId,codeDeployed:true,controlPlaneVerified:true,...verified.active,applicationReady:false,dataInitComplete:false,phase:required.missing.length?'bindings_required':'init_required',preservedBindings:stores,missingBindings:required.missing,dataAPICalls:0,urlVerification:{status:'pending',verified:false},initURL:null};
    write(path.join(root,'.upgrade/unbound-result.json'),JSON.stringify(report,null,2));
    console.log('[upgrade] ST_CODE_RELEASE_VERIFIED '+JSON.stringify(report));
    stage='url-verification';
    report.urlVerification=await verifyReleaseURL(urls.candidates,plan,{fetchImpl,pause,now,deadline:Math.min(deadline-5000,now()+45000)});
    // Do not let a concurrently changed release count as the final result.
    const final=await readUnbound(cf,config.name,{timeoutMs:8000,maxAttempts:1});
    if(!isDeepStrictEqual(final.active,verified.active)||!releaseEvidence(plan,final)){codeDeployed=null;fail('ST_UNBOUND_CHANGED','網址檢查期間現行部署改變；本次歷史發布已確認，但目前狀態需重新核對。');}
    report.initURL=report.urlVerification.verified?report.urlVerification.url+'/init':null;
    report.suggestedInitURLs=urls.candidates.map(c=>c.url+'/init');
    write(path.join(root,'.upgrade/unbound-result.json'),JSON.stringify(report,null,2));
    console.log('[upgrade] '+(report.urlVerification.verified?'ST_URL_VERIFIED':'ST_URL_NOT_VERIFIED')+' '+JSON.stringify(report.urlVerification));
    console.log('[upgrade] '+(required.missing.length?'ST_CODE_DEPLOYED_AWAITING_BINDINGS':'ST_CODE_DEPLOYED_AWAITING_INIT')+' '+JSON.stringify(report));
    console.log('[upgrade] 程式發布與原綁定已由現行版本核對。已綁齊原資源時直接開啟 /init；缺項只補綁該原資源並部署設定，不需重推 Git。沒有自動备份或初始化資料；完成網頁驗證前業務仍鎖定。');
    return report;
  }catch(error){
    error.deploymentState={stage,publishAttempted:attempted,codeDeployed,applicationReady:false,dataInitComplete:false,dataAPICalls:0};
    console.error('[upgrade] ST_DEPLOY_FAILED '+JSON.stringify(error.deploymentState));
    fs.rmSync(path.join(root,'.upgrade/unbound-result.json'),{force:true});
    // Result of a prior checkpoint is not a claim that the whole operation finished.
    if(plan)write(path.join(root,'.upgrade/unbound-failure.json'),JSON.stringify({...error.deploymentState,runId:plan.runId,errorCode:error.code||'ST_DEPLOY_ERROR'},null,2));
    throw error;
  }finally{
    if(old!==undefined)write(file,old);
    fs.rmSync(path.join(root,UNBOUND_CONFIG),{force:true});
  }
}
/** Backwards-compatible export name ONLY. The default intent is now fixed.
 * All live storage combinations preserve bindings and keep deferred-web-init mode.
 */
export async function runAutoDeployment(options={}){return runUnboundDeployment(options);}

export const runWebInitDeployment=runUnboundDeployment;
export const makeWebInitConfig=makeUnboundConfig;
