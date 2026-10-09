#!/usr/bin/env node
/** v3.3.33: deploy an authenticated waiting/init application without data bindings.
 * Only Worker control-plane GETs are allowed here. No data API, resource creation,
 * backup, database migration, binding restoration or credential reset is performed.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {isDeepStrictEqual} from 'node:util';
import {Cloudflare} from './upgrade/cloudflare.mjs';
import {checkedBindingList} from './upgrade/worker-bindings.mjs';
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
function identity(settings){
  return checkedBindingList(settings?.bindings).map(b=>{
    if(b.type==='plain_text'){if(typeof b.text!=='string')fail('ST_UNBOUND_VARIABLE','原一般變數內容不完整，不會發布空值。');return {name:b.name,type:b.type,text:b.text};}
    if(b.type==='json'){if(b.json===undefined)fail('ST_UNBOUND_VARIABLE','原 JSON 變數內容不完整。');return {name:b.name,type:b.type,json:typeof b.json==='string'?JSON.parse(b.json):b.json};}
    if(b.type==='secret_text'||b.type==='assets')return {name:b.name,type:b.type};
    return {...b};
  }).sort((a,b)=>a.name.localeCompare(b.name));
}
export function assertUnboundSettings(settings){
  const rows=identity(settings);
  if(rows.some(b=>['d1','kv_namespace'].includes(b.type)))fail('ST_UNBOUND_STILL_BOUND','此流程要求先手動解綁 D1 和 KV；不會替你解除任何綁定。');
  if(rows.some(b=>!['plain_text','json','secret_text','assets'].includes(b.type)))fail('ST_UNBOUND_OTHER_BINDING','原 Worker 有其他類型的綁定；為避免發布時移除它們，已停止。');
  if(rows.some(b=>b.type==='assets'&&b.name!=='ASSETS'))fail('ST_UNBOUND_ASSETS','靜態資產綁定名稱不是 ASSETS，已停止以免改變原綁定。');
  return rows;
}
async function readUnbound(cf,worker,options={}){
  const base='/workers/scripts/'+encodeURIComponent(worker);
  const settings=(await cf.request(base+'/settings',options)).result;
  identity(settings); // A missing binding array must never mean 'unbound'.
  const active=await readActiveRelease(cf,worker,options);
  const version=(await cf.request(base+'/versions/'+active.versionId,options)).result;
  if(version?.id!==active.versionId||!Array.isArray(version?.resources?.bindings))fail('ST_UNBOUND_VERSION','現行版本綁定資料不完整；不會把讀取失敗當成沒有綁定。');
  const stores=rows=>checkedBindingList(rows).filter(b=>['d1','kv_namespace'].includes(b.type)).map(b=>({name:b.name,type:b.type,id:b.namespace_id||b.database_id||b.id||null}));
  const remaining={worker,settings:stores(settings.bindings),activeVersion:stores(version.resources.bindings)};
  if(remaining.settings.length||remaining.activeVersion.length)fail('ST_UNBOUND_STILL_BOUND','固定網頁 init 升級，不改走 direct/split。目標與殘留綁定：'+JSON.stringify(remaining)+'。請在此 Worker 完成解綁並部署設定；工具不會代為解除或刪除資源。');
  const bindings=assertUnboundSettings(settings),deployed=assertUnboundSettings({bindings:version.resources.bindings});
  if(!isDeepStrictEqual(bindings,deployed))fail('ST_UNBOUND_NOT_ACTIVE','Dashboard 設定與現行版本不同；請先儲存並部署解綁變更，再執行程式升級。');
  const confirmed=await readActiveRelease(cf,worker,options);
  if(!isDeepStrictEqual(active,confirmed))fail('ST_UNBOUND_CHANGED','讀取期間現行部署改變；沒有合併不同版本的設定。');
  return {settings,bindings,active};
}
export function makeUnboundConfig(original,{settings,schedules,domain,accountId}){
  assertUnboundSettings(settings);
  if(original.unsafe||original.site)fail('ST_UNBOUND_LOCAL_BINDINGS','本地 unsafe/site 可能隱式建立或注入綁定；不使用這份設定發布無綁定版本。');
  if(!Array.isArray(schedules)||schedules.some(s=>typeof s?.cron!=='string')||typeof domain?.enabled!=='boolean')fail('ST_UNBOUND_CONFIG','無法核對原 Cron 或 workers.dev 設定。');
  const config=structuredClone(original);
  config.account_id=accountId;config.main='src/index.js';config.keep_vars=true;
  config.build={command:'node scripts/require-safe-upgrade.mjs'};
  config.assets={...(config.assets||{}),directory:'./public',binding:'ASSETS'};
  // Explicit empty lists prevent stale local IDs AND implicit auto-provisioning.
  // We only reach here after BOTH remote sources prove the stores are detached.
  config.kv_namespaces=[];config.d1_databases=[];
  config.vars=Object.fromEntries(identity(settings).filter(b=>['plain_text','json'].includes(b.type)).map(b=>[b.name,b.type==='json'?b.json:b.text]));
  config.triggers={crons:schedules.map(s=>s.cron)};config.workers_dev=domain.enabled;
  if(typeof domain.previews_enabled==='boolean')config.preview_urls=domain.previews_enabled;
  delete config.route;delete config.routes;delete config.migrations;delete config.env;
  return config;
}
export function unboundRelease(plan){return '// Generated only for a verified no-storage release; runtime stays locked until authenticated web init.\nexport const UPGRADE_RUN=Object.freeze('+JSON.stringify({version:VERSION,id:plan.runId,mode:WEB_INIT_MODE,tokenHash:''})+');\n';}
export function assertUnboundGuard(root,env=process.env){
  const plan=JSON.parse(fs.readFileSync(path.join(root,UNBOUND_PLAN),'utf8'));
  if(plan.format!=='substracker-unbound-plan-v2'||plan.phase!=='ready'||plan.version!==VERSION||!uuid.test(plan.nonce||'')||plan.runId!==VERSION+'-web-init-'+plan.nonce||env.SUBSTRACKER_UNBOUND_DEPLOY_RUN!==plan.runId)fail('ST_UNBOUND_GUARD','缺少本次無綁定發布計畫；單獨設定環境變數不能放行。');
  if(plan.accountId!==env.CLOUDFLARE_ACCOUNT_ID||plan.config.account_id!==plan.accountId||plan.config.name!==plan.worker||plan.checksPassed!==true)fail('ST_UNBOUND_GUARD','發布帳戶、Worker 或驗證紀錄不符。');
  assertUnboundSettings({bindings:plan.bindingIdentity});assertMarkerAvailable(plan.bindingIdentity);
  if(plan.config.vars?.[RELEASE_MARKER]!==deploymentMarker(plan))fail('ST_UNBOUND_GUARD','本次發布識別與來源雜湊不符。');
  const config=JSON.parse(fs.readFileSync(path.join(root,UNBOUND_CONFIG),'utf8'));
  if(!isDeepStrictEqual(config,plan.config)||config.kv_namespaces?.length!==0||config.d1_databases?.length!==0||config.build?.command!=='node scripts/require-safe-upgrade.mjs'||config.main!=='src/index.js'||config.keep_vars!==true)fail('ST_UNBOUND_GUARD','待發布設定已改變或包含資料綁定。');
  if(sourceFingerprint(root)!==plan.sourceHash||fs.readFileSync(path.join(root,'src/upgrade-release.js'),'utf8')!==unboundRelease(plan))fail('ST_UNBOUND_SOURCE','測試後的原始碼已改變；尚未放行。');
  return plan;
}
function publish(root,plan,env,timeout){
  const tool=localWrangler(root);
  console.log('[upgrade] ST_UNBOUND_PUBLISH '+JSON.stringify({version:VERSION,worker:plan.worker,storageBindings:0}));
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
    // URL is not a configuration precondition for a no-storage code release.
    const config=readWranglerConfig(root,env,{validateURL:false});
    cf ||= new Cloudflare({accountId:env.CLOUDFLARE_ACCOUNT_ID,token:env.CLOUDFLARE_API_TOKEN});
    if(cf.accountId!==env.CLOUDFLARE_ACCOUNT_ID)fail('ST_UNBOUND_ACCOUNT','API 帳戶與本次 Build 帳戶不一致；未發布。');
    console.log('[upgrade] ST_DEPLOY_ENTRY '+JSON.stringify({version:VERSION,entry:'deploy:cloudflare',mode:WEB_INIT_MODE,intent:'unbound-then-web-init',automaticFallback:false}));
    console.log('[upgrade] ST_DEPLOY_TARGET '+JSON.stringify({worker:config.name,environment:env.SUBSTRACKER_ENVIRONMENT||'top-level',accountId:cf.accountId,expectedStorageBindings:0}));
    const original=await readUnbound(cf,config.name);
    const schedules=await cf.schedules(config.name),domain=await cf.scriptSubdomain(config.name);
    assertMarkerAvailable(original.bindings);
    // Validate ALL publication settings before the expensive release checks.
    const publicationConfig=makeUnboundConfig(config,{settings:original.settings,schedules,domain,accountId:cf.accountId});
    const urls=await discoverReleaseURLs(cf,{worker:config.name,domain,explicit:env.SUBSTRACKER_WORKER_URL});
    console.log('[upgrade] ST_UNBOUND_PREFLIGHT '+JSON.stringify({worker:config.name,storageBindings:0,workersDev:domain.enabled,urlRequiredForCodeDeploy:false,urlCandidates:urls.candidates,urlWarnings:urls.warnings,dataAPICalls:0}));
    const budget=()=>{if(now()+5000>=deadline)fail('ST_UNBOUND_BUDGET','發布時間保護上限；請依 codeDeployed / stage 判斷是否已發布，不自動重跑或回滾。');};
    console.log('[upgrade] ST_UNBOUND_CONFIRMED '+JSON.stringify({version:VERSION,worker:config.name,storageBindings:0,dataAPICalls:0,next:'/init'}));
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
    plan={format:'substracker-unbound-plan-v2',phase:'ready',version:VERSION,nonce,runId:VERSION+'-web-init-'+nonce,worker:config.name,accountId:cf.accountId,urlCandidates:urls.candidates,sourceHash,checksPassed:true,bindingIdentity:original.bindings,previousDeployment:original.active,config:publicationConfig};
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
        if(/ST_UNBOUND_(?:STILL_BOUND|CHANGED|OTHER_BINDING)/.test(error.message))throw error;
        lastReason=error.code||'control-plane-unavailable-or-not-active';
      }
      if(n<14)await pause(2000);
    }
    if(!verified)fail('ST_UNBOUND_CONTROL_VERIFY','Wrangler 已返回，但未核對到本次現行版本及發布識別（'+lastReason+'）；不報告程式部署成功。');
    // Re-check non-storage configuration after upload as well.
    if(!isDeepStrictEqual(await cf.schedules(config.name),schedules)||!isDeepStrictEqual(await cf.scriptSubdomain(config.name),domain))fail('ST_UNBOUND_CHANGED','發布後 Cron 或 workers.dev 設定不符；請核對，未回滾。');
    codeDeployed=true;
    const report={version:VERSION,mode:WEB_INIT_MODE,worker:config.name,runId:plan.runId,codeDeployed:true,controlPlaneVerified:true,...verified.active,applicationReady:false,dataInitComplete:false,phase:'bindings_required',dataAPICalls:0,urlVerification:{status:'pending',verified:false},initURL:null};
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
    console.log('[upgrade] ST_CODE_DEPLOYED_AWAITING_BINDINGS '+JSON.stringify(report));
    console.log('[upgrade] 程式發布已由 Cloudflare 現行版本核對。請手動綁回原 SUBSCRIPTIONS_KV / SUBSCRIPTIONS_DB 並部署綁定，然後開啟原站 /init。網址未驗證不代表尚未發布；資料 init 尚未完成，業務仍鎖定。');
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
 * A remaining KV binding can never silently select direct-compatible deployment.
 */
export async function runAutoDeployment(options={}){return runUnboundDeployment(options);}
