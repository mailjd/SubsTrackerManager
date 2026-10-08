#!/usr/bin/env node
/** Read-only checkout inventory. Extra repository files remain present AND tested.
 * No secret values, source text, database bindings or remote operations are used.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {VERSION} from '../src/version.js';
export function inspectCheckout(root, version=VERSION) {
  const manifestPath=path.join(root,`FILE_MANIFEST_${version}.json`);
  if(!fs.existsSync(manifestPath))return {version,status:'manifest-missing',extraFiles:[],modifiedFiles:[],missingFiles:[],remoteAccess:false};
  const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  const relevant=s=>/^(src|scripts|tests)\//.test(s)&&!s.startsWith('tests/results/')&&!s.startsWith('tests/regression/results/')&&/\.(js|mjs|cjs|py)$/.test(s);
  const expected=new Map(Object.entries(manifest.files||{}).filter(([p])=>relevant(p)));
  const current=new Map();
  function visit(dir){if(!fs.existsSync(dir))return;for(const item of fs.readdirSync(dir,{withFileTypes:true})){if(item.name==='__pycache__'||item.name==='node_modules')continue;const p=path.join(dir,item.name);if(item.isDirectory())visit(p);else if(item.isFile()){const rel=path.relative(root,p).split(path.sep).join('/');if(relevant(rel))current.set(rel,createHash('sha256').update(fs.readFileSync(p)).digest('hex'));}}}
  for(const part of ['src','scripts','tests'])visit(path.join(root,part));
  const extraFiles=[...current].filter(([p])=>!expected.has(p)).map(([file,sha256])=>({file,sha256}));
  const modifiedFiles=[...current].filter(([p,h])=>expected.has(p)&&expected.get(p)!==h).map(([file,sha256])=>({file,sha256}));
  const missingFiles=[...expected.keys()].filter(p=>!current.has(p));
  return {version,status:extraFiles.length||modifiedFiles.length||missingFiles.length?'differences':'match',checked:current.size,extraFiles,modifiedFiles,missingFiles,remoteAccess:false};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const report=inspectCheckout(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));
    console.log('[checkout] ST_CHECKOUT_INVENTORY '+JSON.stringify(report));
    if(report.status!=='match')console.log('[checkout] 以上只记录仓库与发布包的差异；未删除、排除或改写额外文件。完整类型检查及 Workers 测试仍会检查它们。');
  }catch(error){console.error('[checkout] 无法读取校验清单：'+error.message);process.exitCode=1;}
}
