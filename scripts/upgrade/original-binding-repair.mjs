/** Read-only D1/KV binding diagnosis and source-control pinning.
 * This module has no Cloudflare write operations and never invents a database.
 * Changes to wrangler.toml require explicit user action after verifying the LIVE binding.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';

const D1_ID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const KV_ID=/^[a-f0-9]{32}$/i;
const ENV_NAME=/^[a-zA-Z][a-zA-Z0-9_-]*$/;
const atom=(v)=>JSON.stringify(v);

export function getBindingDiagnosis({config,settings,worker,environment=null}){
  if(!settings || !Array.isArray(settings.bindings))throw new Error('ST_D1_PROBE_RESPONSE: Cloudflare settings.bindings 缺失，不能推測為 KV-only');
  const kv=settings.bindings.filter(b=>b.type==='kv_namespace');
  const d1=settings.bindings.filter(b=>b.type==='d1');
  const effective=environment ? (config?.env?.[environment] || {}) : config;
  return {
    worker,
    environment:environment || 'default',
    onlineKV:kv.map(b=>b.name),
    onlineD1:d1.map(b=>({name:b.name,idPresent:!!(b.database_id||b.id)})),
    localKVDeclared:Array.isArray(effective?.kv_namespaces)&&effective.kv_namespaces.length>0,
    localD1Declared:Array.isArray(effective?.d1_databases)&&effective.d1_databases.length>0,
    bindingsPinnedInSource:!!(effective?.kv_namespaces?.length&&effective?.d1_databases?.length),
    diagnosis:d1.length===0?'D1_NOT_ATTACHED_TO_THIS_LIVE_WORKER':
      d1.length===1&&d1[0].name==='SUBSCRIPTIONS_DB'&&(d1[0].database_id||d1[0].id)?'D1_PRESENT_CHECK_ID_AND_SCHEMA':'D1_BINDING_NEEDS_REVIEW',
    remoteMutation:false
  };
}

export function verifyExactOriginalIds({settings,d1Id,kvId}){
  if(!D1_ID.test(d1Id||''))throw new Error('ST_D1_EXPLICIT_ID: 必須提供原 D1 的真實 UUID（不是零值／猜測值）');
  if(!KV_ID.test(kvId||''))throw new Error('ST_KV_ORIGINAL_ID: 原 KV namespace ID 不完整');
  if(/^0+$/.test(d1Id.replace(/-/g,''))||/^0+$/.test(kvId))throw new Error('ST_STORAGE_TEST_ID: 禁止使用離線打包時的全零 ID');
  if(!Array.isArray(settings?.bindings))throw new Error('ST_D1_PROBE_RESPONSE: 缺少線上綁定列表');
  const d1=settings.bindings.filter(b=>b.type==='d1');
  const kv=settings.bindings.filter(b=>b.type==='kv_namespace');
  if(d1.length!==1||d1[0].name!=='SUBSCRIPTIONS_DB'||(d1[0].database_id||d1[0].id)!==d1Id)
    throw new Error('ST_D1_NOT_ACTIVE: 原 D1 尚未綁定到目前正式 Worker。先在正確 Worker 保存並啟用原 D1 綁定；本工具絕不代替建立／部署資料庫。');
  if(kv.length!==1||kv[0].name!=='SUBSCRIPTIONS_KV'||kv[0].namespace_id!==kvId)
    throw new Error('ST_KV_MISMATCH: 正式 Worker 的 KV 與原命名空間不一致');
  return true;
}

export function renderPinSuffix({config,environment=null,kvId,d1Id,databaseName}){
  if(!D1_ID.test(d1Id||'')||!KV_ID.test(kvId||'')||!databaseName||!String(databaseName).trim())throw new Error('ST_BINDING_PIN_INPUT: 缺少真實綁定參數');
  if(environment && (!ENV_NAME.test(environment)||!config?.env?.[environment]))throw new Error('ST_BINDING_PIN_ENV: 指定環境不存在');
  const target=environment?config.env[environment]:config;
  if((target.kv_namespaces||[]).length || (target.d1_databases||[]).length)throw new Error('ST_BINDING_PIN_CONFLICT: 原 TOML 已有儲存宣告；請人工核對，不能覆寫或追加重複綁定');
  const base=environment?`env.${environment}.`:'';
  return [
    '',
    '# Existing verified storage IDs — NEVER replace with diagnostic zeros or newly created resources.',
    `[[${base}kv_namespaces]]`,
    'binding = "SUBSCRIPTIONS_KV"',
    `id = ${atom(kvId)}`,
    '',
    `[[${base}d1_databases]]`,
    'binding = "SUBSCRIPTIONS_DB"',
    `database_id = ${atom(d1Id)}`,
    `database_name = ${atom(databaseName)}`,
    ''
  ].join('\n');
}

export function assertExpectedTables(queryResult){
  const results=queryResult?.result?.[0]?.results;
  if(queryResult?.success!==true||!Array.isArray(results))throw new Error('ST_D1_SCHEMA_RESPONSE: D1 查詢結果無法核對');
  const tables=new Set(results.map(r=>r.name));
  const required=['schema_meta','subscriptions_current','subscription_history','accounts','account_credentials','account_history','menu_option_groups','menu_options','account_database_backups'];
  const missing=required.filter(x=>!tables.has(x));
  if(missing.length)throw new Error('ST_D1_EMPTY_OR_WRONG: 所選 D1 不符合原業務資料結構；缺少 '+missing.join(', ')+ '。禁止把空 D1 當作原庫');
  return true;
}

export function writePinnedConfig({root,original,candidate,python,apply=false}){
  const target=path.join(root,'wrangler.toml');
  if(fs.readFileSync(target,'utf8')!==original)throw new Error('ST_BINDING_PIN_RACE: TOML 已變更，拒絕覆蓋');
  const r=spawnSync(python,['-c','import sys,tomllib;tomllib.loads(sys.stdin.read())'],{input:candidate,encoding:'utf8',timeout:10000});
  if(r.status!==0)throw new Error('ST_BINDING_TOML: 修訂後的 TOML 無法解析，不修改原檔');
  const result={verifiedToml:true,willWrite:apply,remoteWrite:false};
  if(!apply)return result;
  const backupDir=path.join(root,'.binding-backups');
  fs.mkdirSync(backupDir,{recursive:true,mode:0o700});
  const backup=path.join(backupDir,'wrangler.before-existing-d1-'+crypto.createHash('sha256').update(original).digest('hex').slice(0,12)+'.toml');
  fs.writeFileSync(backup,original,{flag:'wx',mode:0o600});
  try{fs.writeFileSync(target,candidate,{flag:'w'});}catch(e){fs.writeFileSync(target,original);throw e;}
  return {...result,backup:path.relative(root,backup)};
}
