#!/usr/bin/env node
/** Diagnostic and local-only source pin of an explicitly verified EXISTING D1. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Cloudflare} from './upgrade/cloudflare.mjs';
import {readWranglerConfig} from './upgrade/deploy-environment.mjs';
import {getBindingDiagnosis,verifyExactOriginalIds,renderPinSuffix,assertExpectedTables,writePinnedConfig} from './upgrade/original-binding-repair.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function main(){
  const args=process.argv.slice(2);
  if(args.includes('--help')){
    console.log('npm run binding:doctor — read-only live Worker/checked-in TOML diagnosis.\n'+
      'npm run binding:pin — pin VERIFIED CURRENT live D1/KV IDs into local wrangler.toml, no remote write.\n'+
      'Requires CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN. Pin additionally requires SUBSTRACKER_ORIGINAL_D1_ID.\n'+
      'Never supply the offline all-zero ID. Pin does NOT bind a D1 to a live Worker; do that first in Cloudflare Dashboard.');return;
  }
  if(args.some(a=>a!=='--pin'))throw new Error('Unknown arguments. Use --help or --pin only.');
  const pin=args.includes('--pin');
  const cf=new Cloudflare({accountId:process.env.CLOUDFLARE_ACCOUNT_ID,token:process.env.CLOUDFLARE_API_TOKEN});
  const effective=readWranglerConfig(ROOT,process.env);
  const envName=process.env.SUBSTRACKER_ENVIRONMENT||null;
  const original=fs.readFileSync(path.join(ROOT,'wrangler.toml'),'utf8');
  const remote=await cf.settings(effective.name);
  const d=getBindingDiagnosis({config:effective,settings:remote,worker:effective.name});
  // Show only names, booleans and the selected environment. IDs and secrets are never logged.
  const report={...d,environment:envName||'default',localKVDeclared:(effective.kv_namespaces||[]).length>0,
    localD1Declared:(effective.d1_databases||[]).length>0};
  console.log('[binding:doctor] ST_ORIGINAL_BINDING_DIAG '+JSON.stringify(report));
  if(d.diagnosis!=='D1_PRESENT_CHECK_ID_AND_SCHEMA'){
    throw new Error('ST_D1_LIVE_MISSING: Cloudflare API 查到的 '+effective.name+' 正式版本沒有可用原 D1。'+
      '請先確認這個 Worker 的 Settings→Bindings 顯示 SUBSCRIPTIONS_DB 並已保存啟用。'+
      '若原 Worker 本來就只有 KV，必須改用 GitHub Actions Safe upgrade；不能用全零或空 D1 修復。');
  }
  if(!pin){
    console.log('[binding:doctor] D1 已在正式版本顯示；若 TOML 尚未宣告原綁定，請從 Cloudflare Dashboard 核對原 D1 ID，然後執行 binding:pin。');return;
  }
  const d1Id=process.env.SUBSTRACKER_ORIGINAL_D1_ID;
  const kvBinding=remote.bindings.find(b=>b.type==='kv_namespace'&&b.name==='SUBSCRIPTIONS_KV');
  verifyExactOriginalIds({settings:remote,d1Id,kvId:kvBinding?.namespace_id});
  const meta=await cf.database(d1Id); // Existing resource GET only; no create.
  if(!meta || typeof meta.name!=='string' || !meta.name.trim())throw new Error('ST_D1_META: 無法讀取原 D1 名稱，停止');
  const query=await cf.request('/d1/database/'+encodeURIComponent(d1Id)+'/query',{method:'POST',body:{sql:"SELECT name FROM sqlite_master WHERE type='table'",params:[]}});
  assertExpectedTables(query);
  // Read TOML with full env objects to avoid inheriting root-only binding arrays.
  const python=process.env.PYTHON||(process.platform==='win32'?'python':'python3');
  const {spawnSync}=await import('node:child_process');
  const parsed=spawnSync(python,['-c','import sys,tomllib,json;print(json.dumps(tomllib.load(open(sys.argv[1],"rb"))))',path.join(ROOT,'wrangler.toml')],{encoding:'utf8',timeout:10000});
  if(parsed.status!==0)throw new Error('ST_D1_TOML: 原設定格式錯誤');
  const fullConfig=JSON.parse(parsed.stdout);
  const suffix=renderPinSuffix({config:fullConfig,environment:envName,kvId:kvBinding.namespace_id,d1Id,databaseName:meta.name});
  const result=writePinnedConfig({root:ROOT,original,candidate:original.replace(/\s*$/,'\n')+suffix,python,apply:true});
  console.log('[binding:doctor] ST_BINDING_SOURCE_PINNED '+JSON.stringify(result));
  console.log('[binding:doctor] 僅修改本機 wrangler.toml；請核對 diff 後再 Commit。沒有部署、修改遠端設定、建立或刪除任何資料。');
}
main().catch(e=>{console.error('[binding:doctor] '+e.message);process.exitCode=1;});
