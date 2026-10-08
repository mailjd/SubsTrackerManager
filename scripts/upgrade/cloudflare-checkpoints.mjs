/** Encrypted cross-Build checkpoints in existing KV; append-only pointers and leases in existing D1.
 * Never creates/deletes a database, overwrites an application record, or stores the backup password.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {encryptArchive,decryptArchive} from './archive.mjs';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const PART = 1024 * 1024;
const MAX_BYTES = 64 * 1024 * 1024;
const UUID = /^[a-f0-9-]{36}$/;
export function checkpointPrefixes(account,worker) {
  const id=digest(account+'\n'+worker).slice(0,32);
  return {artifact:`__substracker_upgrade_artifacts_v1__:${id}:`,control:`upgrade:3322:cloudflare:${id}:`};
}
export function sourceFingerprint(root) {
  const files=[];
  function scan(dir){for(const item of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){const file=dir+'/'+item.name;
    if(item.isSymbolicLink())throw new Error('部署源码不可含符号链接：'+file);
    if(item.isDirectory())scan(file);else if(file!=='src/upgrade-release.js')files.push(file);
  }}
  for(const dir of ['src','scripts','migrations','public'])if(fs.existsSync(path.join(root,dir)))scan(dir);
  for(const file of ['package.json','package-lock.json'])if(fs.existsSync(path.join(root,file)))files.push(file);
  const h=crypto.createHash('sha256');for(const file of files.sort()){h.update(file+'\0');h.update(fs.readFileSync(path.join(root,file)));h.update('\0');}return h.digest('hex');
}
function privateWrite(file,bytes) {
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  fs.writeFileSync(file+'.tmp',bytes,{mode:0o600});fs.renameSync(file+'.tmp',file);
}
export class CloudflareCheckpoints {
  constructor(cf,{worker,bindings,password}) {
    if(!bindings.dbId)throw new Error('ST_SPLIT_D1_REQUIRED：Cloudflare 分段部署需要原有 D1 作原子协调；不会新建 D1。KV-only 请使用原 Safe upgrade。');
    if(password.length<16)throw new Error('缺少有效备份密码');
    this.cf=cf;this.worker=worker;this.bindings=bindings;this.password=password;
    this.prefix=checkpointPrefixes(cf.accountId,worker);this.claim=null;
  }
  async query(sql,params=[]) {
    const data=await this.cf.request('/d1/database/'+encodeURIComponent(this.bindings.dbId)+'/query',{method:'POST',body:{sql,params}});
    if(!Array.isArray(data.result)||data.result.length!==1||data.result[0].success===false)throw new Error('D1 控制记录响应不完整');
    return data.result[0];
  }
  async acquire() {
    const schema=await this.query("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'");
    if(schema.results?.length!==1)throw new Error('原 D1 缺少 schema_meta；不会创建替代库或猜测旧结构');
    const id=crypto.randomUUID(),now=Date.now(),leasePrefix=this.prefix.control+'lease:';
    const claim={id,key:leasePrefix+id,releaseKey:this.prefix.control+'release:'+id,expiresAt:now+25*60*1000};
    const result=await this.query(`INSERT INTO schema_meta(key,value,updated_at)
      SELECT ?,?,? WHERE NOT EXISTS (
        SELECT 1 FROM schema_meta AS l WHERE substr(l.key,1,?)=?
        AND CAST(json_extract(l.value,'$.expiresAt') AS INTEGER)>?
        AND NOT EXISTS(SELECT 1 FROM schema_meta AS r WHERE r.key=json_extract(l.value,'$.releaseKey'))
      ) RETURNING key`,[claim.key,JSON.stringify(claim),new Date(now).toISOString(),leasePrefix.length,leasePrefix,now]);
    if(result.results?.[0]?.key!==claim.key)throw new Error('ST_SPLIT_BUSY：另一个部署仍持有锁；不要并行发布。异常中止后锁最多25分钟到期，再重试同一提交。');
    this.claim=claim;return claim;
  }
  async assertLease() {
    if(!this.claim)throw new Error('未取得构建协调锁');
    const c=this.claim,rows=await this.query(`SELECT key FROM schema_meta WHERE key=?
      AND CAST(json_extract(value,'$.expiresAt') AS INTEGER)>?
      AND NOT EXISTS(SELECT 1 FROM schema_meta WHERE key=?)`,[c.key,Date.now(),c.releaseKey]);
    if(rows.results?.length!==1)throw new Error('ST_SPLIT_LEASE_EXPIRED：构建锁已过期，停止远端操作并保留检查点');
  }
  async release() {
    if(!this.claim)return;
    await this.query('INSERT OR IGNORE INTO schema_meta(key,value,updated_at) VALUES(?,?,?)',[
      this.claim.releaseKey,JSON.stringify({released:true,claim:this.claim.key}),new Date().toISOString()]);
    this.claim=null;
  }
  async latestDescriptor() {
    const prefix=this.prefix.control+'checkpoint:';
    const q=await this.query('SELECT value FROM schema_meta WHERE substr(key,1,?)=? ORDER BY key DESC LIMIT 1',[prefix.length,prefix]);
    if(!q.results?.length)return null;
    const x=JSON.parse(q.results[0].value);
    if(x.format!=='substracker-cloudflare-checkpoint-v1'||!UUID.test(x.objectId)||!Number.isInteger(x.parts)||x.parts<1||x.parts>64||!Number.isInteger(x.bytes)||x.bytes<1||x.bytes>MAX_BYTES||!/^[a-f0-9]{64}$/.test(x.sha256))throw new Error('损坏的远端检查点描述；不覆盖或新开批次');
    return x;
  }
  async readPart(key) {
    for(let n=0;n<12;n++){
      const data=await this.cf.request('/storage/kv/namespaces/'+this.bindings.kvId+'/values/'+encodeURIComponent(key),{raw:true,allowNotFound:true});
      if(data!==null)return data;
      if(n<11)await sleep(1000);
    }
    throw new Error('远端加密备份分片暂不可读；保留检查点后重试，不继续部署');
  }
  async readCapsule(desc) {
    const parts=[];for(let i=0;i<desc.parts;i++){const part=await this.readPart(this.prefix.artifact+desc.objectId+':'+i);if(part.length>PART || part.length<1)throw new Error('远端备份分片长度无效');parts.push(part);}
    const bytes=Buffer.concat(parts);
    if(bytes.length!==desc.bytes||digest(bytes)!==desc.sha256)throw new Error('远端加密备份校验失败；未继续发布/迁移');
    const data=decryptArchive(bytes,this.password);
    if(data.format!=='substracker-cloudflare-capsule-v1'||data.state?.runId!==desc.runId||data.state?.worker!==this.worker||data.state?.accountId!==this.cf.accountId||data.state?.bindings?.kvId!==this.bindings.kvId||data.state?.bindings?.dbId!==this.bindings.dbId)throw new Error('远端检查点不属于原 Worker / 原存储');
    if(data.state.remoteArtifactsPrefix!==this.prefix.artifact||data.state.remoteControlPrefix!==this.prefix.control)throw new Error('检查点备份前缀不匹配');
    return data;
  }
  async load(root,{version,sourceHash,write=true}={}) {
    const desc=await this.latestDescriptor();if(!desc)return null;
    const capsule=await this.readCapsule(desc);
    if(version&&capsule.state.version!==version)throw new Error('ST_SPLIT_VERSION：存在其他版本的检查点；请用原版本和原备份完成，不混用批次');
    if(sourceHash&&capsule.state.sourceHash!==sourceHash)throw new Error('ST_SPLIT_SOURCE：源码与第一次部署不同；请 Retry 同一提交，不在维护期间换代码');
    if(write)this.restore(root,capsule);
    return capsule.state;
  }
  restore(root,capsule) {
    const state=capsule.state;
    if(!/^[0-9A-Za-z_.-]+$/.test(state.runId||'')||!Array.isArray(capsule.files))throw new Error('检查点文件列表无效');
    for(const file of capsule.files){
      if(!/^[0-9A-Za-z_.-]+$/.test(file.name)||!file.name.startsWith(state.runId+'-'))throw new Error('拒绝恢复越界文件名');
      const bytes=Buffer.from(file.base64,'base64');if(digest(bytes)!==file.sha256)throw new Error('恢复附件内容不符');
      privateWrite(path.join(root,'upgrade-backups',file.name),bytes);
    }
    privateWrite(path.join(root,'.upgrade/state.stbackup'),encryptArchive(state,this.password));
  }
  async publish(root,state) {
    await this.assertLease();
    const folder=path.join(root,'upgrade-backups'),files=[];
    for(const name of fs.readdirSync(folder).filter(n=>n.startsWith(state.runId+'-')).sort()) {
      // Store an up-to-date resume file rather than a stale one captured before this checkpoint.
      const bytes=name.endsWith('-resume.stbackup')?encryptArchive(state,this.password):fs.readFileSync(path.join(folder,name));
      files.push({name,sha256:digest(bytes),base64:bytes.toString('base64')});
    }
    const capsule={format:'substracker-cloudflare-capsule-v1',state,files};
    const bytes=encryptArchive(capsule,this.password);
    if(bytes.length>MAX_BYTES)throw new Error('ST_SPLIT_SIZE：恢复包超过64MiB分段部署保护上限；未发布。请使用长时限 Safe upgrade 并保留原数据。');
    const objectId=crypto.randomUUID();
    const desc={format:'substracker-cloudflare-checkpoint-v1',objectId,parts:Math.ceil(bytes.length/PART),bytes:bytes.length,sha256:digest(bytes),runId:state.runId,version:state.version,phase:state.phase};
    for(let i=0;i<desc.parts;i++){
      await this.assertLease();
      const key=this.prefix.artifact+objectId+':'+i;
      await this.cf.request('/storage/kv/namespaces/'+this.bindings.kvId+'/bulk',{method:'PUT',body:[{key,value:bytes.subarray(i*PART,(i+1)*PART).toString('base64'),base64:true}]});
    }
    await this.readCapsule(desc); // Full round-trip authentication before publishing a pointer.
    await this.assertLease();
    const old=await this.latestDescriptor(),timestamp=Math.max(Date.now(),(old?.timestamp||0)+1);
    desc.timestamp=timestamp;
    const key=this.prefix.control+'checkpoint:'+String(timestamp).padStart(16,'0')+':'+objectId;
    await this.query('INSERT INTO schema_meta(key,value,updated_at) VALUES(?,?,?)',[key,JSON.stringify(desc),new Date(timestamp).toISOString()]);
    const confirmed=await this.latestDescriptor();if(confirmed?.sha256!==desc.sha256)throw new Error('检查点指针未回读确认；停止发布');
    return desc;
  }
}
