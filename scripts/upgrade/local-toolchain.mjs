/** Offline deterministic tool resolution. No npx, registry lookup, or production side effects. */
import fs from 'node:fs';
import path from 'node:path';
import {DeploymentError} from './deploy-environment.mjs';
const fail=(message)=>{throw new DeploymentError('ST_TOOLCHAIN',message);};
function read(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{fail('缺少或无效的 '+path.basename(file)+'；请完整解压新版并执行 npm ci（包含 devDependencies）。');}}
const exact=/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export function inspectToolchain(root,{requireInstalled=true}={}){
  root=path.resolve(root);
  const pkg=read(path.join(root,'package.json')),lock=read(path.join(root,'package-lock.json'));
  if(lock.lockfileVersion!==3||lock.version!==pkg.version||lock.packages?.['']?.version!==pkg.version)fail('package.json / package-lock.json 版本不一致；不要混用旧 lock 或只上传部分文件。');
  const direct={};
  for(const group of ['dependencies','devDependencies']){
    if(JSON.stringify(Object.entries(pkg[group]||{}).sort())!==JSON.stringify(Object.entries(lock.packages[''][group]||{}).sort()))fail(group+' 在 package 与 lock 中不一致；请恢复本版配套文件。');
    for(const [name,pinned] of Object.entries(pkg[group]||{})){
      const locked=lock.packages['node_modules/'+name];
      if(!exact.test(pinned)||locked?.version!==pinned)fail(name+' 未按 lock 精确锁定；不能在发布时自动改装其他版本。');
      let installed=null;
      const file=path.join(root,'node_modules',name,'package.json');
      if(fs.existsSync(file))installed=read(file).version;
      if(requireInstalled&&installed!==pinned)fail(`${name}：预期 ${pinned}，实际 ${installed||'未安装'}。请用本版 package-lock.json 重新 npm ci --include=dev；不要仅更新全局 Wrangler。`);
      direct[name]={declared:pinned,locked:pinned,installed};
    }
  }
  const wranglers=Object.entries(lock.packages).filter(([name])=>name.endsWith('/node_modules/wrangler')||name==='node_modules/wrangler').map(([location,value])=>({location,version:value.version,role:location==='node_modules/wrangler'?'release':'test-transitive',deprecated:value.deprecated||null}));
  return {version:pkg.version,node:process.versions.node,lockfileVersion:lock.lockfileVersion,direct,wranglers,remoteAccess:false};
}
export function localWrangler(root){
  const report=inspectToolchain(root);
  const dir=path.join(path.resolve(root),'node_modules','wrangler'),pkg=read(path.join(dir,'package.json'));
  const relative=typeof pkg.bin==='string'?pkg.bin:pkg.bin?.wrangler;
  if(!relative||path.isAbsolute(relative))fail('Wrangler 本机入口无效。');
  const entry=path.resolve(dir,relative);
  if(!entry.startsWith(dir+path.sep)||!fs.existsSync(entry)||!fs.realpathSync(entry).startsWith(fs.realpathSync(dir)+path.sep))fail('Wrangler 入口缺失或越界；请重新 npm ci。');
  return {command:process.execPath,entry,version:report.direct.wrangler.locked};
}
