/** Shared required release checks. No environment variable can skip this list. */
import {spawnSync} from 'node:child_process';
export const RELEASE_CHECKS=Object.freeze(['test:runtime','test:toolchain','lint','test:context','test:syntax','test:bundle','test:storage','test:deploy','test:upgrade','test:table-contract','test:workflow','test']);
export function verifyReleaseChecks(root,deadline=Date.now()+15*60*1000){
 const npm=process.platform==='win32'?'npm.cmd':'npm';
 for(const script of RELEASE_CHECKS){
   const remaining=deadline-Date.now()-30000;
   if(remaining<=0)throw new Error('ST_SPLIT_BUDGET：发布前检查达到预算；尚未开始本次发布，请使用长时限 Safe upgrade。');
   console.log('[release:check] '+script);
   const r=spawnSync(npm,['run',script],{cwd:root,stdio:'inherit',timeout:Math.min(240000,remaining)});
   if(r.status!==0)throw new Error(`ST_SPLIT_TEST：${script} 未通过（exit=${r.status??'null'}, signal=${r.signal||'none'}, error=${r.error?.code||'none'}），本次未开始发布；查看上方具体错误，不能跳过检查。`);
 }
}
