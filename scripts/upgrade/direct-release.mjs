/** One-shot, schema-compatible code release. No maintenance deployment, migration,
 * D1 lease, store creation, or business-record writes. Backup chunks are immutable
 * and isolated in the ORIGINAL KV namespace; KV is never used as an atomic lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {encryptArchive,decryptArchive,restoreToMemory} from './archive.mjs';
import {sourceFingerprint,checkpointPrefixes} from './cloudflare-checkpoints.mjs';
import {stableJSON} from '../../src/data/upgrade-reconcile.js';
import {VERSION} from '../../src/version.js';
import {assertD1KVConfig} from './storage-policy.mjs';
export const DIRECT_MODE='direct-compatible';
export const DIRECT_CONFIG='wrangler.direct.json';
export const DIRECT_PLAN='.upgrade/direct-plan.json';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PART=1024*1024,MAX=64*PART;
export const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export function directError(code,message){const e=new Error(code+'：'+message);e.code=code;return e;}
export function privateWrite(file,bytes){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file+'.tmp',bytes,{mode:0o600});fs.renameSync(file+'.tmp',file);}

/** Only reads an isolated, restored snapshot. Deliberately NOT the old ledger
 * migration plan: a compatible code update does not require historical backfill. */
export function inspectDirectBundle(bundle){
  const memory=restoreToMemory(bundle);
  try{
    const rows=new Map(bundle.kv.map(row=>[row.name,row]));
    const text=k=>rows.has(k)?Buffer.from(rows.get(k).valueBase64,'base64').toString('utf8'):null;
    if(text('schema_version')!=='v3')throw directError('ST_DIRECT_SCHEMA','原 KV 不是 v3 数据结构；未发布、未尝试旧版破坏性迁移。');
    let config;try{config=JSON.parse(text('config')||'null');}catch{throw directError('ST_DIRECT_CONFIG','原 config 不是有效 JSON；不会重建配置或密钥。');}
    if(!config||typeof config.JWT_SECRET!=='string'||!config.JWT_SECRET||typeof config.CREDENTIALS_ENCRYPTION_KEY!=='string'||!config.CREDENTIALS_ENCRYPTION_KEY)
      throw directError('ST_DIRECT_CONFIG','原 config 缺少 JWT/凭据加密密钥；为避免重置密码或密钥，未发布。');
    if(memory.db){
      const accountColumns=memory.db.prepare('PRAGMA table_info(accounts)').all();
      const credentialColumns=memory.db.prepare('PRAGMA table_info(account_credentials)').all();
      if(accountColumns.some(r=>r.name==='account_serial'&&Number(r.pk)>0)||credentialColumns.some(r=>r.name==='account_serial'))
        throw directError('ST_DIRECT_OLD_D1','检测到会触发旧账号表重建的早期 D1 结构；没有改表或发布。');
      // Empty/new optional D1 tables are allowed: existing application has additive
      // CREATE IF NOT EXISTS initialization. No DDL is executed on the remote DB here.
    }
    return {schema:'v3',kvKeys:bundle.kv.length,d1:!!memory.db,credentialsPreserved:true,
      snapshotConsistency:'live-non-transactional',historicalBackfill:'not-run'};
  }finally{memory.close();}
}
export function makeDirectConfig(original,{bindings,database,schedules,domain,accountId}){
  const config=structuredClone(original);
  assertD1KVConfig(config);
  if(!Array.isArray(schedules)||schedules.some(s=>typeof s?.cron!=='string'))throw directError('ST_DIRECT_SCHEDULES','无法确认原 Cron 配置。');
  if(typeof domain?.enabled!=='boolean')throw directError('ST_DIRECT_DOMAIN','无法确认原 workers.dev 配置。');
  config.account_id=accountId;config.main='src/index.js';config.keep_vars=true;
  config.build={command:'node scripts/require-safe-upgrade.mjs'};
  config.assets={...(config.assets||{}),directory:'./public',binding:'ASSETS'};
  config.kv_namespaces=[{binding:'SUBSCRIPTIONS_KV',id:bindings.kvId}];
  config.d1_databases=bindings.dbId?[{binding:'SUBSCRIPTIONS_DB',database_id:bindings.dbId,database_name:database?.name||'existing-database'}]:[];
  config.vars=Object.fromEntries(bindings.variables.map(b=>[b.name,b.type==='json'?(typeof b.json==='string'?JSON.parse(b.json):b.json):b.text]));
  config.triggers={crons:schedules.map(s=>s.cron)};
  config.workers_dev=domain.enabled;
  if(typeof domain.previews_enabled==='boolean')config.preview_urls=domain.previews_enabled;
  // Updating code does not opt into route/DO/database migrations from local templates.
  delete config.route;delete config.routes;delete config.migrations;delete config.env;
  return config;
}
export function directRun(plan){return {version:VERSION,id:plan.runId,tokenHash:'',mode:DIRECT_MODE,schema:'v3'};}
export function directReleaseSource(plan){return '// Generated only after original-binding checks and encrypted backup verification.\nexport const UPGRADE_RUN=Object.freeze('+JSON.stringify(directRun(plan))+');\n';}
export function writeDirectPlan(root,plan){
  privateWrite(path.join(root,DIRECT_CONFIG),JSON.stringify(plan.config,null,2));
  privateWrite(path.join(root,DIRECT_PLAN),JSON.stringify(plan,null,2));
  privateWrite(path.join(root,'src/upgrade-release.js'),directReleaseSource(plan));
}
export function assertDirectGuard(root,env=process.env){
  const plan=JSON.parse(fs.readFileSync(path.join(root,DIRECT_PLAN),'utf8'));
  if(plan.format!=='substracker-direct-plan-v1'||plan.version!==VERSION||plan.mode!==DIRECT_MODE||plan.phase!=='ready'||!UUID.test(plan.backupId||'')||plan.runId!==VERSION+'-direct-'+plan.backupId||env.SUBSTRACKER_DIRECT_DEPLOY_RUN!==plan.runId)
    throw directError('ST_DIRECT_GUARD','没有本次已验证的直接部署计划；不能只设置环境变量强行放行。');
  if(plan.accountId!==env.CLOUDFLARE_ACCOUNT_ID||plan.config.account_id!==plan.accountId||plan.config.name!==plan.worker)
    throw directError('ST_DIRECT_GUARD','部署目标与原账号/Worker 不符。');
  assertD1KVConfig(plan.config);
  const config=JSON.parse(fs.readFileSync(path.join(root,DIRECT_CONFIG),'utf8'));
  if(stableJSON(config)!==stableJSON(plan.config)||config.kv_namespaces?.length!==1||config.kv_namespaces[0].id!==plan.bindings.kvId||config.kv_namespaces[0].binding!=='SUBSCRIPTIONS_KV'||(config.d1_databases?.[0]?.database_id||null)!==plan.bindings.dbId||config.d1_databases.length!==(plan.bindings.dbId?1:0))
    throw directError('ST_DIRECT_GUARD','生成配置/原存储绑定发生变化；未放行。');
  if(sourceFingerprint(root)!==plan.sourceHash||fs.readFileSync(path.join(root,'src/upgrade-release.js'),'utf8')!==directReleaseSource(plan))
    throw directError('ST_DIRECT_SOURCE','本次检查后源码或发布描述发生变化；未放行。');
  const receipt=plan.backup;
  if(!receipt||receipt.namespaceId!==plan.bindings.kvId||receipt.backupId!==plan.backupId||receipt.remoteVerified!==true||!/^([a-f0-9]{64})$/.test(receipt.sha256||'')||receipt.filename!==plan.backupId+'.stbackup')
    throw directError('ST_DIRECT_BACKUP','缺少原 KV 远端加密备份回读凭证。');
  const bytes=fs.readFileSync(path.join(root,'upgrade-backups',receipt.filename));
  if(digest(bytes)!==receipt.sha256)throw directError('ST_DIRECT_BACKUP','本地备份密文校验失败。');
  const payload=decryptArchive(bytes,env.SUBSTRACKER_BACKUP_PASSWORD);
  if(payload.accountId!==plan.accountId||payload.worker!==plan.worker||payload.backupId!==plan.backupId||stableJSON(payload.bindings)!==stableJSON(plan.bindings))
    throw directError('ST_DIRECT_BACKUP','备份不属于此 Worker 的原存储。');
  inspectDirectBundle(payload);
  return plan;
}
function basePrefix(cf,worker,backupId){if(!UUID.test(backupId||''))throw directError('ST_DIRECT_BACKUP_ID','备份 ID 必须是 UUID。');return checkpointPrefixes(cf.accountId,worker).artifact+'direct:'+backupId+':';}
function validateDescriptor(d){
  if(!d||d.format!=='substracker-direct-backup-v1'||!UUID.test(d.backupId||'')||!Number.isInteger(d.parts)||d.parts<1||d.parts>64||!Number.isInteger(d.bytes)||d.bytes<1||d.bytes>MAX||d.parts!==Math.ceil(d.bytes/PART)||!/^[a-f0-9]{64}$/.test(d.sha256||''))throw directError('ST_DIRECT_BACKUP','远端备份描述不完整。');
}
export async function readArtifact(cf,kvId,key,{pause=sleep,attempts=16}={}){
  for(let n=0;n<attempts;n++){
    const bytes=await cf.request('/storage/kv/namespaces/'+kvId+'/values/'+encodeURIComponent(key),{raw:true,allowNotFound:true});
    if(bytes!==null)return bytes;
    if(n+1<attempts)await pause(5000);
  }
  throw directError('ST_DIRECT_BACKUP_READ','新备份分片尚未可读；未发布，不会把未验证备份当作成功。');
}
export async function readDirectBackup(cf,{worker,kvId,backupId,password,descriptor,pause}){
  const prefix=basePrefix(cf,worker,backupId);
  const d=descriptor||JSON.parse((await readArtifact(cf,kvId,prefix+'manifest',{pause})).toString('utf8'));validateDescriptor(d);
  if(d.backupId!==backupId||d.namespaceId!==kvId||d.worker!==worker||d.accountId!==cf.accountId)throw directError('ST_DIRECT_BACKUP','远端描述与原目标不符。');
  const chunks=[];
  for(let i=0;i<d.parts;i++){
    const part=await readArtifact(cf,kvId,prefix+i,{pause});
    const expected=Math.min(PART,d.bytes-i*PART);
    if(part.length!==expected)throw directError('ST_DIRECT_BACKUP','远端分片长度不符。');chunks.push(part);
  }
  const bytes=Buffer.concat(chunks);
  if(bytes.length!==d.bytes||digest(bytes)!==d.sha256)throw directError('ST_DIRECT_BACKUP','远端密文摘要不符。');
  const payload=decryptArchive(bytes,password);
  if(payload.format!=='substracker-full-storage'||payload.accountId!==cf.accountId||payload.worker!==worker||payload.backupId!==backupId||payload.bindings?.kvId!==kvId)throw directError('ST_DIRECT_BACKUP','解密备份不属于原目标。');
  inspectDirectBundle(payload);return {bytes,payload,descriptor:d};
}
export async function saveDirectBackup(cf,{root,worker,bindings,backupId,password,payload,beforeWrite=async()=>{},pause}){
  const bytes=encryptArchive(payload,password);
  if(bytes.length>MAX)throw directError('ST_DIRECT_BACKUP_SIZE','加密备份超过64MiB保护上限；未开始发布。');
  if(stableJSON(decryptArchive(bytes,password))!==stableJSON(payload))throw directError('ST_DIRECT_BACKUP','本地备份解密校验不符。');
  const filename=backupId+'.stbackup';privateWrite(path.join(root,'upgrade-backups',filename),bytes);
  const prefix=basePrefix(cf,worker,backupId),d={format:'substracker-direct-backup-v1',backupId,accountId:cf.accountId,worker,namespaceId:bindings.kvId,parts:Math.ceil(bytes.length/PART),bytes:bytes.length,sha256:digest(bytes)};
  for(let i=0;i<d.parts;i++){
    await beforeWrite();
    await cf.request('/storage/kv/namespaces/'+bindings.kvId+'/bulk',{method:'PUT',body:[{key:prefix+i,value:bytes.subarray(i*PART,(i+1)*PART).toString('base64'),base64:true}]});
  }
  await readDirectBackup(cf,{worker,kvId:bindings.kvId,backupId,password,descriptor:d,pause});
  await beforeWrite();
  const descriptorBytes=Buffer.from(JSON.stringify(d));
  await cf.request('/storage/kv/namespaces/'+bindings.kvId+'/bulk',{method:'PUT',body:[{key:prefix+'manifest',value:descriptorBytes.toString('base64'),base64:true}]});
  const saved=await readArtifact(cf,bindings.kvId,prefix+'manifest',{pause});
  if(!saved.equals(descriptorBytes))throw directError('ST_DIRECT_BACKUP','远端备份索引回读不符；未发布。');
  return {...d,filename,remoteVerified:true};
}
