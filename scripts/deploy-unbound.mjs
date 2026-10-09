#!/usr/bin/env node
/** v3.3.32: deploy an authenticated waiting/init application without data bindings.
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
import {readActiveRelease,runDirectDeployment} from './deploy-direct.mjs';
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
async function readUnbound(cf,worker){
  const settings=(await cf.request('/workers/scripts/'+encodeURIComponent(worker)+'/settings')).result;
  const bindings=assertUnboundSettings(settings),active=await readActiveRelease(cf,worker);
  const version=(await cf.request('/workers/scripts/'+encodeURIComponent(worker)+'/versions/'+active.versionId)).result;
  if(version?.id!==active.versionId||!Array.isArray(version?.resources?.bindings))fail('ST_UNBOUND_VERSION','現行版本綁定資料不完整；不會把讀取失敗當成沒有綁定。');
  const deployed=assertUnboundSettings({bindings:version.resources.bindings});
  if(!isDeepStrictEqual(bindings,deployed))fail('ST_UNBOUND_NOT_ACTIVE','Dashboard 設定與現行版本不同；請先儲存並部署解綁變更，再執行程式升級。');
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
  if(plan.format!=='substracker-unbound-plan-v1'||plan.phase!=='ready'||plan.version!==VERSION||!uuid.test(plan.nonce||'')||plan.runId!==VERSION+'-web-init-'+plan.nonce||env.SUBSTRACKER_UNBOUND_DEPLOY_RUN!==plan.runId)fail('ST_UNBOUND_GUARD','缺少本次無綁定發布計畫；單獨設定環境變數不能放行。');
  if(plan.accountId!==env.CLOUDFLARE_ACCOUNT_ID||plan.config.account_id!==plan.accountId||plan.config.name!==plan.worker||plan.checksPassed!==true)fail('ST_UNBOUND_GUARD','發布帳戶、Worker 或驗證紀錄不符。');
  assertUnboundSettings({bindings:plan.bindingIdentity});
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
  assertSupportedDeploymentHost(env,{allowWorkersBuilds:true});assertNodeRuntime();validateDeploymentSecrets(env,{requireBackup:false});
  const config=readWranglerConfig(root,env);cf ||= new Cloudflare({accountId:env.CLOUDFLARE_ACCOUNT_ID,token:env.CLOUDFLARE_API_TOKEN});
  const original=await readUnbound(cf,config.name),schedules=await cf.schedules(config.name),domain=await cf.scriptSubdomain(config.name);
  const budget=()=>{if(now()+5000>=deadline)fail('ST_UNBOUND_BUDGET','發布時間保護上限；尚未驗證成功。');};
  let url=env.SUBSTRACKER_WORKER_URL;
  if(!url){if(!domain?.enabled)fail('ST_UNBOUND_URL','請以 SUBSTRACKER_WORKER_URL 保留原 HTTPS 網址。');const sub=await cf.accountSubdomain();if(!sub?.subdomain)fail('ST_UNBOUND_URL','無法讀取原 workers.dev 子網域。');url='https://'+config.name+'.'+sub.subdomain+'.workers.dev';}
  url=new URL(url).origin;
  console.log('[upgrade] ST_UNBOUND_CONFIRMED '+JSON.stringify({version:VERSION,worker:config.name,storageBindings:0,dataAPICalls:0,next:'/init'}));
  // No old-runtime probe: an unbound old release may correctly return HTTP 500/503.
  checkRelease(root,deadline-90000);const sourceHash=sourceFingerprint(root);
  const confirm=async()=>{
    budget();const current=await readUnbound(cf,config.name);
    if(!isDeepStrictEqual(current.bindings,original.bindings)||!isDeepStrictEqual(current.active,original.active))fail('ST_UNBOUND_CHANGED','測試期間綁定或版本改變；不會覆蓋另一個發布。');
    if(!isDeepStrictEqual(await cf.schedules(config.name),schedules)||!isDeepStrictEqual(await cf.scriptSubdomain(config.name),domain))fail('ST_UNBOUND_CHANGED','測試期間 Cron 或網域設定改變，已停止以免覆蓋新設定。');
  };
  await confirm();
  const nonce=crypto.randomUUID(),plan={format:'substracker-unbound-plan-v1',phase:'ready',version:VERSION,nonce,runId:VERSION+'-web-init-'+nonce,worker:config.name,accountId:cf.accountId,url,sourceHash,checksPassed:true,bindingIdentity:original.bindings,previousDeployment:original.active,config:makeUnboundConfig(config,{settings:original.settings,schedules,domain,accountId:cf.accountId})};
  const file=path.join(root,'src/upgrade-release.js'),old=fs.readFileSync(file);let attempted=false;
  try{
    write(path.join(root,UNBOUND_PLAN),JSON.stringify(plan,null,2));write(path.join(root,UNBOUND_CONFIG),JSON.stringify(plan.config,null,2));write(file,unboundRelease(plan));
    assertUnboundGuard(root,{...env,SUBSTRACKER_UNBOUND_DEPLOY_RUN:plan.runId});await confirm();attempted=true;
    await publisher(root,plan,env,Math.max(1,Math.min(600000,deadline-now()-30000)));
    let status;
    for(let n=0;n<35;n++){
      budget();try{const r=await fetchImpl(url+'/api/upgrade/status',{redirect:'manual',headers:{'Cache-Control':'no-store'},signal:AbortSignal.timeout(15000)});if(r.ok){const value=await r.json();if(value.version===VERSION&&value.runId===plan.runId&&value.mode===WEB_INIT_MODE&&value.codeDeployed===true&&value.phase==='bindings_required'&&value.applicationReady===false){status=value;break;}}}catch{/* propagate only after bounded verification */}
      if(n<34)await pause(3000);
    }
    if(!status)fail('ST_UNBOUND_VERIFY','程式已提交發布，但尚未核對到本次等待綁定頁；不報告成功。');
    const after=await readUnbound(cf,config.name);
    // ASSETS may be added by the first deployment using native static assets.
    const withoutAssets=x=>x.filter(b=>b.type!=='assets');
    if(!isDeepStrictEqual(withoutAssets(original.bindings),withoutAssets(after.bindings)))fail('ST_UNBOUND_CHANGED','發布後變數或機密名稱發生變化；請核对線上設定。');
    const report={version:VERSION,mode:WEB_INIT_MODE,worker:config.name,runId:plan.runId,codeDeployed:true,applicationReady:false,phase:'bindings_required',dataAPICalls:0,initURL:url+'/init'};
    write(path.join(root,'.upgrade/unbound-result.json'),JSON.stringify(report,null,2));
    console.log('[upgrade] ST_CODE_DEPLOYED_AWAITING_BINDINGS '+JSON.stringify(report));
    console.log('[upgrade] 程式部署成功。請手動綁回原 SUBSCRIPTIONS_KV / SUBSCRIPTIONS_DB，儲存並部署綁定，然後開啟 /init；資料升級尚未執行。');return report;
  }catch(error){console.error('[upgrade] ST_UNBOUND_NOT_CONFIRMED '+JSON.stringify({publishAttempted:attempted,dataAPICalls:0}));throw error;}
  finally{write(file,old);fs.rmSync(path.join(root,UNBOUND_CONFIG),{force:true});}
}
/** Preserve v3.3.31 behaviour on still-bound installations; auto-select only on
 * an explicit, successful response containing ZERO storage bindings. */
export async function runAutoDeployment(options={}){
  const {root=ROOT,env=process.env}=options;
  assertSupportedDeploymentHost(env,{allowWorkersBuilds:true});assertNodeRuntime();validateDeploymentSecrets(env,{requireBackup:false});
  const config=readWranglerConfig(root,env),cf=options.cf||new Cloudflare({accountId:env.CLOUDFLARE_ACCOUNT_ID,token:env.CLOUDFLARE_API_TOKEN});
  const settings=(await cf.request('/workers/scripts/'+encodeURIComponent(config.name)+'/settings')).result;
  const stores=checkedBindingList(settings?.bindings).filter(b=>['d1','kv_namespace'].includes(b.type));
  if(!stores.length)return runUnboundDeployment({...options,cf});
  if(!stores.some(b=>b.type==='kv_namespace'))fail('ST_UNBOUND_PARTIAL','只解綁了 KV，D1 仍在；請完成手動解綁，或恢復原綁定。工具不代替你解除綁定。');
  return runDirectDeployment({...options,cf});
}
