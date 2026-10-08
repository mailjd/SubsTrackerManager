/** Encrypted, full-fidelity storage bundle. No plaintext credential data is written to disk. */
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {stableJSON,sha256,collectSubscriptionInventory} from '../../src/data/upgrade-reconcile.js';
import {planLedgerUpgrade} from '../../src/data/subscription-ledger.js';
export const FORMAT='substracker-storage-upgrade-v1';
const AAD=Buffer.from(FORMAT);
export function encryptArchive(payload,password){
  if(typeof password!=='string'||password.length<16)throw new Error('SUBSTRACKER_BACKUP_PASSWORD 至少 16 个字符；不会使用管理员密码代替');
  const salt=crypto.randomBytes(16),iv=crypto.randomBytes(12);
  const key=crypto.scryptSync(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});
  const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(AAD);
  const plaintext=Buffer.from(JSON.stringify(payload));
  const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);key.fill(0);
  return Buffer.from(JSON.stringify({format:FORMAT,kdf:'scrypt-32768-8-1',cipher:'AES-256-GCM',salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:ciphertext.toString('base64')}));
}
export function decryptArchive(bytes,password){
  const x=JSON.parse(Buffer.from(bytes).toString('utf8'));
  if(x.format!==FORMAT||x.kdf!=='scrypt-32768-8-1'||x.cipher!=='AES-256-GCM')throw new Error('不是受支持的加密存储备份');
  const salt=Buffer.from(x.salt,'base64'),iv=Buffer.from(x.iv,'base64'),tag=Buffer.from(x.tag,'base64');
  if(salt.length!==16||iv.length!==12||tag.length!==16)throw new Error('备份加密头无效');
  const key=crypto.scryptSync(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});
  try{const c=crypto.createDecipheriv('aes-256-gcm',key,iv);c.setAAD(AAD);c.setAuthTag(tag);return JSON.parse(Buffer.concat([c.update(Buffer.from(x.data,'base64')),c.final()]).toString('utf8'));}
  catch{throw new Error('备份密码不正确或文件已损坏；没有执行还原');}finally{key.fill(0);}
}
export function restoreToMemory(bundle){
  if(!Array.isArray(bundle.kv))throw new Error('存储备份缺少 KV 数组');
  const kv=new Map();for(const row of bundle.kv){if(kv.has(row.name))throw new Error('备份中 KV key 重复');kv.set(row.name,row);}
  const db=bundle.d1Sql==null?null:new DatabaseSync(':memory:');
  if(db){
    db.exec('PRAGMA foreign_keys=OFF;');
    // SQL executes only in an isolated in-memory database; no network or extension loading.
    if(/\b(?:ATTACH|DETACH|VACUUM|load_extension|writefile|readfile)\b/i.test(bundle.d1Sql.replace(/'(?:''|[^'])*'/g,"''")))throw new Error('备份 SQL 包含文件访问指令，拒绝执行');
    db.exec(bundle.d1Sql);
    const integrity=db.prepare('PRAGMA integrity_check').get();
    if(Object.values(integrity)[0]!=='ok')throw new Error('备份 SQL 未通过 SQLite 完整性检查');
    if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('备份 SQL 含外键断链');
  }
  class Statement {
    constructor(text,args=[]){this.text=text;this.args=args;}
    bind(...args){return new Statement(this.text,args);}
    async all(){return {success:true,results:db.prepare(this.text).all(...this.args)};}
    async first(col){const row=db.prepare(this.text).get(...this.args)||null;return col?row?.[col]??null:row;}
  }
  const env={SUBSCRIPTIONS_KV:{
    async get(name){if(Array.isArray(name))return new Map(name.map(k=>[k,kv.has(k)?Buffer.from(kv.get(k).valueBase64,'base64').toString('utf8'):null]));const item=kv.get(name);return item?Buffer.from(item.valueBase64,'base64').toString('utf8'):null;},
    async list({prefix='',limit=500,cursor='0'}={}){const keys=[...kv.keys()].filter(n=>n.startsWith(prefix)).sort(),start=Number(cursor);return {keys:keys.slice(start,start+limit).map(name=>({name})),list_complete:start+limit>=keys.length,cursor:start+limit<keys.length?String(start+limit):''};}
  }};
  if(db)env.SUBSCRIPTIONS_DB={prepare:s=>new Statement(s)};
  return {db,env,close(){db?.close();}};
}
const quote=name=>'"'+String(name).replaceAll('"','""')+'"';
export function sqlImage(db){
  if(!db)return {};
  const out={};
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all();
  for(const {name} of tables){
    const columns=db.prepare(`PRAGMA table_info(${quote(name)})`).all().map(x=>x.name);
    const rows=db.prepare(`SELECT * FROM ${quote(name)}`).all();
    // Unsafe integers must not be silently rounded in a JS verification path.
    for(const row of rows)for(const v of Object.values(row))if(typeof v==='number'&&Number.isInteger(v)&&!Number.isSafeInteger(v))throw new Error('SQL 包含超出安全整数范围的值，拒绝不准确验收');
    out[name]={columns,rows:rows.map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,v instanceof Uint8Array?{$blob:Buffer.from(v).toString('base64')}:v]))).sort((a,b)=>stableJSON(a).localeCompare(stableJSON(b)))};
  }return out;
}
export async function inspectBundle(bundle){
  const memory=restoreToMemory(bundle);
  try{
    const inventory=await collectSubscriptionInventory(memory.env);
    const plan=await planLedgerUpgrade(memory.env,inventory);
    const image=sqlImage(memory.db);
    if(memory.db){const required=['schema_meta','subscriptions_current','subscription_history','accounts','account_credentials','account_history','menu_option_groups','menu_options','account_database_backups'];if(required.some(n=>!image[n]))throw new Error('D1 基础结构不完整；不会猜测或执行破坏性旧结构迁移');if(memory.db.prepare('PRAGMA table_info(accounts)').all().some(r=>r.name==='account_serial'&&Number(r.pk)>0)||image.account_credentials.columns.includes('account_serial'))throw new Error('检测到早期账号主键结构，保留原表并停止');}
    if(await memory.env.SUBSCRIPTIONS_KV.get('schema_version')!=='v3')throw new Error('此升级包要求现有 v3 数据结构（v3.3.18/3.3.19）；不会执行会改写旧表的早期迁移');
    const config=JSON.parse(await memory.env.SUBSCRIPTIONS_KV.get('config')||'null');
    if(!config || !config.JWT_SECRET || !config.CREDENTIALS_ENCRYPTION_KEY)throw new Error('原 KV config 缺少 JWT/加密密钥；为避免生成新密钥，已停止');
    const summary={kvCount:bundle.kv.length,tables:Object.fromEntries(Object.entries(image).map(([n,t])=>[n,t.rows.length])),sourceDigest:inventory.sourceDigest,counts:inventory.counts,
      existingHistory:plan.existing.length,newHistory:plan.additions.length,orphanIds:inventory.orphanIds,
      supersededSnapshotIds:plan.supersededSnapshotIds,sqlDigest:await sha256(image),kvDigest:await sha256([...bundle.kv].sort((a,b)=>a.name.localeCompare(b.name)))};
    return {summary,image,inventory};
  }finally{memory.close();}
}
/** All original rows/columns and key bytes must still exist, never merely equal total counts.
 * New ledger rows and new schema metadata are allowed, but existing values are not changed.
 */
export function assertOriginalsPreserved(before,after,beforeImage,afterImage){
  const map=new Map(after.kv.map(x=>[x.name,x]));
  const lost=[];
  for(const row of before.kv){const current=map.get(row.name);if(!current){if(row.expiration && row.expiration<=Math.floor(Date.now()/1000))continue;lost.push('KV:'+row.name);}
    else if(stableJSON(row)!==stableJSON(current))lost.push('KV:'+row.name);}
  for(const [name,table] of Object.entries(beforeImage)){
    const target=afterImage[name];if(!target){lost.push('D1 table:'+name);continue;}
    if(table.columns.some(c=>!target.columns.includes(c))){lost.push('D1 columns:'+name);continue;}
    const counts=new Map();for(const row of target.rows){const k=stableJSON(Object.fromEntries(table.columns.map(c=>[c,row[c]])));counts.set(k,(counts.get(k)||0)+1);}
    for(const row of table.rows){const k=stableJSON(row);if(!(counts.get(k)>0))lost.push('D1 row:'+name);else counts.set(k,counts.get(k)-1);}
  }
  if(lost.length)throw new Error('原始记录保护校验失败，未解除维护模式：'+[...new Set(lost)].slice(0,20).join('；'));
  return true;
}
