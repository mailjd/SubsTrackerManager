#!/usr/bin/env node
/** Real Wrangler dry run, with synthetic binding IDs and without production credentials.
 * Its temporary diagnostic config is NEVER handed to the production deployment runner.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {localWrangler} from './upgrade/local-toolchain.mjs';
export function bundleEnvironment(env=process.env){
  // Deliberate allowlist. No Cloudflare/backup credentials, NODE_OPTIONS preloads, or CI flags.
  const out={WRANGLER_SEND_METRICS:'false',NO_COLOR:'1',CI:'true'};
  for(const k of ['PATH','SystemRoot','WINDIR','TEMP','TMP','TMPDIR','LANG','LC_ALL'])if(env[k])out[k]=env[k];
  return out;
}
export function checkBundle(root){
  root=path.resolve(root);const tool=localWrangler(root),temp=fs.mkdtempSync(path.join(os.tmpdir(),'substracker-bundle-'));
  try{
    const config={name:'substracker-offline-diagnostic',main:path.join(root,'src/index.js'),compatibility_date:'2024-09-23',compatibility_flags:['nodejs_compat'],workers_dev:false,
      assets:{directory:path.join(root,'public'),binding:'ASSETS'},vars:{ENVIRONMENT:'test'},
      kv_namespaces:[{binding:'SUBSCRIPTIONS_KV',id:'0'.repeat(32)}],
      d1_databases:[{binding:'SUBSCRIPTIONS_DB',database_name:'offline-diagnostic',database_id:'00000000-0000-4000-8000-000000000000'}]};
    const file=path.join(temp,'wrangler.json');fs.writeFileSync(file,JSON.stringify(config));
    const env={...bundleEnvironment(),HOME:temp,USERPROFILE:temp,XDG_CONFIG_HOME:temp};
    const result=spawnSync(tool.command,[tool.entry,'deploy','--dry-run','--config',file,'--outdir',path.join(temp,'bundle')],{cwd:root,env,stdio:'inherit',timeout:180000});
    if(result.status!==0)throw new Error(`ST_BUNDLE：Wrangler ${tool.version} 离线打包未通过（exit ${result.status??'null'}${result.error?', '+result.error.code:''}）。尚未发布，也未写入升级检查点。`);
    const output=path.join(temp,'bundle');
    if(!fs.existsSync(output)||!fs.readdirSync(output).some(f=>f.endsWith('.js')||f.endsWith('.mjs')))throw new Error('ST_BUNDLE：Wrangler 未生成 JS bundle，不能将退出0视为打包成功。');
    console.log('[bundle] ST_BUNDLE_OK '+JSON.stringify({wrangler:tool.version,uploaded:false,productionStorageAccess:false}));
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{checkBundle(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));}
  catch(e){console.error('[bundle] '+e.message);process.exitCode=1;}
}
