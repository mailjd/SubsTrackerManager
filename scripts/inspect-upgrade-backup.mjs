#!/usr/bin/env node
/** Offline verification only. Optional extraction writes to a NEW local directory, never Cloudflare. */
import fs from 'node:fs';import path from 'node:path';
import {decryptArchive,inspectBundle} from './upgrade/archive.mjs';
try{
 const file=process.argv[2];if(!file)throw new Error('用法: node scripts/inspect-upgrade-backup.mjs <文件.stbackup> [全新导出目录]');
 const backup=decryptArchive(fs.readFileSync(file),process.env.SUBSTRACKER_BACKUP_PASSWORD||'');
 const check=await inspectBundle(backup);console.log(JSON.stringify({verified:true,...check.summary},null,2));
 if(process.argv[3]){
  const dir=path.resolve(process.argv[3]);if(fs.existsSync(dir))throw new Error('导出目录已存在，拒绝覆盖');fs.mkdirSync(dir,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(dir,'kv-full.json'),JSON.stringify(backup.kv,null,2),{mode:0o600});
  if(backup.d1Sql)fs.writeFileSync(path.join(dir,'d1-full.sql'),backup.d1Sql,{mode:0o600});
  fs.writeFileSync(path.join(dir,'original-wrangler.toml'),backup.originalWrangler||'',{mode:0o600});
  console.log('警告：导出目录包含原始密码密文、管理员配置及加密密钥，请离线保密保存。没有操作远端数据库。');
 }
}catch(e){console.error(e.message);process.exitCode=1;}
