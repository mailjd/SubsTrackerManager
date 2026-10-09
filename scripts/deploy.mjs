#!/usr/bin/env node
/** Explicit safe entry; never defaults unknown CLI options into a real deployment. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
if(args.some(x=>x!=='--help')||args.length>1){console.error('[deploy] ST_DEPLOY_ARGS：仅支持无参数或 --help；环境选择请设置 SUBSTRACKER_ENVIRONMENT。未执行部署。');process.exitCode=2;}
else{
 const file=path.join(root,'scripts','deploy-cloudflare.mjs');
 const r=spawnSync(process.execPath,[file,...args],{cwd:root,stdio:'inherit'});
 if(r.error)console.error('[deploy] '+r.error.code+' 无法启动安全部署入口。');
 process.exitCode=r.status??1;
}
