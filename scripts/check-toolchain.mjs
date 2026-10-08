#!/usr/bin/env node
/** Prints package provenance only; never echoes tokens/environment secrets. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectToolchain} from './upgrade/local-toolchain.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
try{
  const arg=process.argv[2];if(arg&&arg!=='--report-only')throw new Error('仅支持 --report-only');
  const report=inspectToolchain(root,{requireInstalled:arg!=='--report-only'});
  console.log('[toolchain] '+JSON.stringify(report));
  console.log('[toolchain] 发布仅使用项目根 node_modules/wrangler；测试套件的间接 Wrangler 不是发布版本。');
  if(arg==='--report-only')console.log('[toolchain] 仅诊断 lock，不是已安装依赖或部署成功证明。');
}catch(e){console.error('[toolchain] '+(e.code||'ST_TOOLCHAIN')+' '+e.message);process.exitCode=1;}
