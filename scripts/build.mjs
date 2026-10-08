#!/usr/bin/env node
/** A build is a real offline validation, never an implicit deployment. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {VERSION} from '../src/version.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const npm=process.platform==='win32'?'npm.cmd':'npm';
console.log(`[build] SubsTracker ${VERSION}：依赖、完整类型检查（含旧适配兼容）、源码语法、Wrangler dry-run；不会发布。`);
console.log('[build] Cloudflare Deploy command 保持 npm run deploy:cloudflare。npm run build 不会改写控制台设置。');
// npm run lint runs the targeted prelint repair, then the ORIGINAL whole-project tsc command.
// Keep this check before bundling so "build success" cannot hide this class of source error.
const checks=[
 ['check-toolchain.mjs',process.execPath,[path.join(root,'scripts/check-toolchain.mjs')]],
 ['lint',npm,['run','lint']],
 ['check-syntax.mjs',process.execPath,[path.join(root,'scripts/check-syntax.mjs')]],
 ['check-bundle.mjs',process.execPath,[path.join(root,'scripts/check-bundle.mjs')]]
];
for(const [name,command,args] of checks){
 const r=spawnSync(command,args,{cwd:root,stdio:'inherit',timeout:200000});
 if(r.status!==0){console.error('[build] ST_BUILD_CHECK '+name+' 未通过；尚未部署。');process.exit(r.status||1);}
}
console.log('[build] ST_BUILD_VALIDATED：本机建置验证完成；尚未部署。后续日志应为 Executing user deploy command: npm run deploy:cloudflare。');
