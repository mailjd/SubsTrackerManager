/** Two-phase upgrade gate, checked BEFORE normal migration/config/router/cron code.
 * Runtime credentials are a one-upgrade random capability, stored as a SHA-256 digest in the bundle.
 * No online application/admin password or encryption key is changed to perform an upgrade.
 */
import {UPGRADE_RUN} from '../upgrade-release.js';
import {hasTable,sha256,collectSubscriptionInventory,stableJSON} from './upgrade-reconcile.js';
import {runLedgerUpgrade,readRawLedgerEntries} from './subscription-ledger.js';
const readyBindings=new WeakMap();
const key=(run,stage)=>`upgrade:3320:${run.id}:${stage}`;
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});}
async function getMeta(env,k){
  if(env.SUBSCRIPTIONS_DB){if(!await hasTable(env,'schema_meta'))return null;const row=await env.SUBSCRIPTIONS_DB.prepare('SELECT value FROM schema_meta WHERE key=?').bind(k).first();return row?.value?JSON.parse(row.value):null;}
  const raw=await env.SUBSCRIPTIONS_KV.get(k);return raw?JSON.parse(raw):null;
}
async function putMeta(env,k,value){
  const raw=JSON.stringify(value);
  if(env.SUBSCRIPTIONS_DB){await env.SUBSCRIPTIONS_DB.prepare('INSERT INTO schema_meta(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(k,raw,new Date().toISOString()).run();}
  else await env.SUBSCRIPTIONS_KV.put(k,raw);
  if(stableJSON(await getMeta(env,k))!==stableJSON(value))throw new Error('升级状态未通过回读校验');
}
export async function upgradeReady(env,run=UPGRADE_RUN){
  const binding=env.SUBSCRIPTIONS_DB||env.SUBSCRIPTIONS_KV;
  if(readyBindings.get(binding)===run.id)return true;
  const complete=await getMeta(env,key(run,'complete'));
  if(complete?.verified===true && complete.runId===run.id && complete.version===run.version){readyBindings.set(binding,run.id);return true;}
  return false;
}
function constantEqual(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0;}
/** Only the safe runner can invoke these operations, including after the app unlocks. */
export async function handleUpgradeGate(request,env,run=UPGRADE_RUN){
  const path=new URL(request.url).pathname;
  const isUpgrade=path.startsWith('/api/upgrade/');
  const ready=await upgradeReady(env,run);
  if(!isUpgrade && ready)return null;
  if(path==='/api/upgrade/status'&&request.method==='GET')return json({success:true,version:run.version,runId:run.id,maintenance:!ready,phase:ready?'ready':(await getMeta(env,key(run,'applied'))?'applied':await getMeta(env,key(run,'started'))?'writing':'pending')});
  if(isUpgrade){
    const token=request.headers.get('X-Upgrade-Token')||'';
    if(!run.tokenHash||!token||!constantEqual(await sha256(token),run.tokenHash))return json({success:false,message:'升级凭证无效'},403);
    if(request.method!=='POST')return json({success:false,message:'不支持的升级请求'},405);
    const body=await request.json();
    if(ready)return json({success:true,ready:true,report:await getMeta(env,key(run,'complete'))});
    if(path==='/api/upgrade/progress'){return json({success:true,started:await getMeta(env,key(run,'started'))});}
    if(path==='/api/upgrade/report'){
      const applied=await getMeta(env,key(run,'applied'));
      if(!applied)return json({success:false,message:'尚无已提交的迁移报告'},409);
      return json({success:true,maintenance:true,report:applied,reportDigest:await sha256(applied)});
    }
    if(path==='/api/upgrade/apply'){
      const receipt=body.backupReceipt;
      if(receipt?.runId!==run.id||receipt?.verified!==true||!/^[a-f0-9]{64}$/.test(receipt?.archiveSha256||'')||!/^[a-f0-9]{64}$/.test(body.expectedSourceDigest||''))return json({success:false,message:'缺少维护期加密备份和回读校验凭证'},400);
      if(await env.SUBSCRIPTIONS_KV.get('schema_version')!=='v3')return json({success:false,message:'不支持的旧数据结构，保留原资料并停止'},409);
      // Very old destructive PK migrations are not silently attempted by this release.
      if(await hasTable(env,'accounts')){
        const columns=(await env.SUBSCRIPTIONS_DB.prepare('PRAGMA table_info(accounts)').all()).results||[];
        if(columns.some(c=>c.name==='account_serial'&&Number(c.pk)>0))return json({success:false,message:'检测到过旧的账号表结构；保留原表，需先在副本演练旧结构迁移'},409);
      }
      const prior=await getMeta(env,key(run,'applied'));
      if(prior){
        if(prior.sourceDigest!==body.expectedSourceDigest||stableJSON(prior.backupReceipt)!==stableJSON(receipt))return json({success:false,message:'重试凭证与原已应用批次不一致'},409);
        return json({success:true,maintenance:true,report:prior,reportDigest:await sha256(prior)});
      }
      const started=await getMeta(env,key(run,'started'));
      if(started && (started.sourceDigest!==body.expectedSourceDigest||stableJSON(started.backupReceipt)!==stableJSON(receipt)))return json({success:false,message:'分批重试凭证与初始批次不同'},409);
      if(!started)await putMeta(env,key(run,'started'),{sourceDigest:body.expectedSourceDigest,backupReceipt:receipt});
      const report=await runLedgerUpgrade(env,{expectedSourceDigest:body.expectedSourceDigest,maxWrites:8});
      if(report.pending)return json({success:true,maintenance:true,pending:true,progress:report});
      const applied={...report,addedThisBatch:report.added,added:Number.isInteger(receipt.ledgerCount)?report.ledgerCount-receipt.ledgerCount:report.added,retained:Number.isInteger(receipt.ledgerCount)?receipt.ledgerCount:report.retained,runId:run.id,backupReceipt:receipt};
      await putMeta(env,key(run,'applied'),applied);
      return json({success:true,maintenance:true,report:applied,reportDigest:await sha256(applied)});
    }
    if(path==='/api/upgrade/commit'){
      const applied=await getMeta(env,key(run,'applied'));
      if(!applied||body.reportDigest!==await sha256(applied)||body.originalsVerified!==true||body.restoreVerified!==true)return json({success:false,message:'尚未完成原始数据与备份还原核验，仍维持维护模式'},409);
      const current=await collectSubscriptionInventory(env);
      if(current.sourceDigest!==applied.sourceDigest || await sha256(await readRawLedgerEntries(env))!==applied.ledgerDigest)return json({success:false,message:'验收时来源或历史发生变化，未解除维护模式'},409);
      const completed={version:run.version,runId:run.id,verified:true,reportDigest:body.reportDigest,backupSha256:applied.backupReceipt.archiveSha256,completedAt:new Date().toISOString()};
      await putMeta(env,key(run,'complete'),completed);
      return json({success:true,ready:true,report:completed});
    }
    return json({success:false,message:'没有此升级操作'},404);
  }
  const message='升级保护模式：数据尚未完成备份/迁移/验收，业务写入和自动续订已暂停。Cloudflare 分段部署请在日志给出的等待时间之后 Retry 同一提交（Deploy command: npm run deploy:cloudflare）；也可继续原 GitHub Safe upgrade 流程。不要初始化或更换数据库。';
  if(path.startsWith('/api/'))return json({success:false,code:'UPGRADE_MAINTENANCE',version:run.version,message},503);
  return new Response(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>SubsTracker 升级保护</title><body style="background:#111827;color:#e5e7eb;font:18px/1.8 system-ui;max-width:780px;margin:80px auto;padding:24px"><h1>SubsTracker ${run.version} · 升级保护中</h1><p>${message}</p><p>检查 Cloudflare 的 ST_UPGRADE_WAIT / ST_UPGRADE_COMPLETE 日志，或 GitHub Actions 进度与加密备份附件。第一次构建成功只表示维护版本已发布，不等于升级完成。发生冲突时保留原记录，不会清库后继续。</p></body></html>`,{status:503,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Retry-After':'60'}});
}
