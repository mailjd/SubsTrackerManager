#!/usr/bin/env node
/** A build is a real offline validation, never an implicit deployment. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {VERSION} from '../src/version.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
console.log(`[build] SubsTracker ${VERSION}：依赖、源码语法、Wrangler dry-run；不会发布。`);
console.log('[build] Cloudflare Deploy command 必须为 npm run deploy:cloudflare。npm run build 不能覆盖控制台的部署命令。');
for(const script of ['check-toolchain.mjs','check-syntax.mjs','check-bundle.mjs']){
 const r=spawnSync(process.execPath,[path.join(root,'scripts',script)],{cwd:root,stdio:'inherit',timeout:200000});
 if(r.status!==0){console.error('[build] ST_BUILD_CHECK '+script+' 未通过；不是部署成功。');process.exit(r.status||1);}
}
console.log('[build] ST_BUILD_VALIDATED：本机建置验证完成；尚未部署。后续日志应为 Executing user deploy command: npm run deploy:cloudflare。');
