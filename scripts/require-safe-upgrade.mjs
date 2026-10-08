/** Wrangler build guard: ordinary raw deploy must not bypass encrypted backup/binding checks. */
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {fileURLToPath} from 'node:url';
import {decryptArchive} from './upgrade/archive.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
try{
 const key=process.env.SUBSTRACKER_BACKUP_PASSWORD||'',run=process.env.SUBSTRACKER_SAFE_DEPLOY_RUN||'';
 if(!run||key.length<16)throw new Error('本版本禁止直接 wrangler deploy；请使用 npm run deploy:safe 或 Safe upgrade 工作流');
 const state=decryptArchive(fs.readFileSync(path.join(root,'.upgrade/state.stbackup')),key);
 if(state.runId!==run||state.phase!=='prepared'||!state.preBackup?.manifest?.restoreVerified)throw new Error('尚无本次已验证的升级前备份');
 const config=JSON.parse(fs.readFileSync(path.join(root,'wrangler.upgrade.json'),'utf8'));
 if(config.name!==state.worker||config.kv_namespaces?.[0]?.id!==state.bindings.kvId||(config.d1_databases?.[0]?.database_id||null)!==state.bindings.dbId)throw new Error('生成的部署绑定与原 Worker 不同');
 const backup=fs.readFileSync(path.join(root,'upgrade-backups',state.preBackup.filename));
 if(crypto.createHash('sha256').update(backup).digest('hex')!==state.preBackup.manifest.archiveSha256)throw new Error('升级前备份已变化');
 console.log('[upgrade] 构建保护检查通过；将以原存储绑定部署维护版本。');
}catch(e){console.error('[upgrade] 阻止未经保护的部署：'+e.message);process.exitCode=1;}
