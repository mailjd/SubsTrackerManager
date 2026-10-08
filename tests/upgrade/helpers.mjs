import {DatabaseSync} from 'node:sqlite';
import {ensureD1Schema} from '../../src/data/d1-schema.js';
import {buildUpsertStatement} from '../../src/data/subscription-history.repo.js';
export const clone=x=>JSON.parse(JSON.stringify(x));
export const sample=(id='a',extra={})=>({id,name:'Service '+id,account:'demo@example.invalid',accountSerial:'公司01号',memberLevel:'Pro',customType:'开会员',notes:'unchanged',amount:10,currency:'CNY',startDate:'2026-09-01T00:00:00.000Z',expiryDate:'2026-10-01T00:00:00.000Z',createdAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-20T00:00:00.000Z',paymentHistory:[],...extra});
export const payment=(id='p1',extra={})=>({id,amount:10,currency:'CNY',date:'2026-09-01T00:00:00.000Z',periodStart:'2026-09-01T00:00:00.000Z',periodEnd:'2026-10-01T00:00:00.000Z',...extra});
export async function fixture({d1=true,rows=[sample()],mirrors=null}={}){
 const values=new Map([['config',JSON.stringify({JWT_SECRET:'old-auth-secret',CREDENTIALS_ENCRYPTION_KEY:'old-credential-secret',ADMIN_USERNAME:'same-admin',ADMIN_PASSWORD:'same-hash',TIMEZONE:'Asia/Shanghai'})],['schema_version','v3'],['sub_index',JSON.stringify(rows.map(x=>x.id))],['table_templates',JSON.stringify([{name:'Keep my template',order:['name','account']}])]]);
 for(const row of rows)values.set('sub:'+row.id,JSON.stringify(row));
 const control={dropLedger:false,dropMarker:false,failList:false,pageSize:500,onPut:null,onBatch:null,maxQueries:Infinity,queries:0,kvOperations:0};
 const db=d1?new DatabaseSync(':memory:'):null;
 const writes=[];
 class Statement{
  constructor(text,args=[]){this.text=text;this.args=args;}
  bind(...args){return new Statement(this.text,args);}
  async all(){if(++control.queries>control.maxQueries)throw new Error('D1_QUERY_LIMIT_50');return {success:true,results:db.prepare(this.text).all(...this.args)};}
  async first(col){if(++control.queries>control.maxQueries)throw new Error('D1_QUERY_LIMIT_50');const r=db.prepare(this.text).get(...this.args)||null;return col?r?.[col]??null:r;}
  async run(){if(++control.queries>control.maxQueries)throw new Error('D1_QUERY_LIMIT_50');writes.push(this.text);if(control.dropLedger&&/INSERT.*INTO subscription_ledger/i.test(this.text))return {success:true,meta:{changes:0}};if(control.dropMarker&&/INSERT.*schema_meta/i.test(this.text))return {success:true,meta:{changes:0}};const r=db.prepare(this.text).run(...this.args);return {success:true,meta:{changes:Number(r.changes)}};}
 }
 const env={SUBSCRIPTIONS_KV:{
   async get(k,opt){control.kvOperations++;if(opt && typeof opt==='object' && opt.cacheTtl!==undefined && (!Number.isInteger(opt.cacheTtl)||opt.cacheTtl<60))throw new Error('KV GET failed: 400 Invalid cache_ttl. Cache TTL must be at least 60.');if(Array.isArray(k))return new Map(k.map(name=>[name,values.get(name)??null]));const v=values.get(k)??null;return (opt==='json'||opt?.type==='json')&&v!=null?JSON.parse(v):v;},
   async put(k,v){writes.push(k);if(control.dropLedger&&k.startsWith('subscription_ledger:'))return;if(control.dropMarker&&k==='subscription_ledger_seed_3320')return;values.set(k,String(v));await control.onPut?.(k);},
   async delete(k){writes.push('delete:'+k);values.delete(k);},
   async list({prefix='',limit=500,cursor='0'}={}){if(control.failList)throw new Error('injected enumeration failure');const keys=[...values.keys()].filter(x=>x.startsWith(prefix)).sort(),i=Number(cursor),n=Math.min(limit,control.pageSize);return {keys:keys.slice(i,i+n).map(name=>({name})),list_complete:i+n>=keys.length,cursor:i+n<keys.length?String(i+n):''};}
 }};
 if(db)env.SUBSCRIPTIONS_DB={prepare:s=>new Statement(s),async batch(stmts){db.exec('BEGIN');try{const out=[];for(const st of stmts)out.push(await st.run());db.exec('COMMIT');await control.onBatch?.(stmts);return out;}catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}},async exec(s){db.exec(s);return {};}};
 if(db){await ensureD1Schema(env);for(const row of (mirrors??rows))await buildUpsertStatement(env.SUBSCRIPTIONS_DB,row).run();}
 writes.length=0;
 return {env,db,values,control,writes,async mirror(row){await buildUpsertStatement(env.SUBSCRIPTIONS_DB,row).run();},close(){db?.close();},bundle(){return {format:'substracker-full-storage',kv:[...values].map(([name,value])=>({name,valueBase64:Buffer.from(value).toString('base64')})),d1Sql:db?dumpSql(db):null};}};
}
const qi=s=>'"'+s.replaceAll('"','""')+'"';
const literal=x=>x==null?'NULL':typeof x==='number'?String(x):x instanceof Uint8Array?"X'"+Buffer.from(x).toString('hex')+"'":"'"+String(x).replaceAll("'","''")+"'";
export function dumpSql(db){
 const objects=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,name").all();
 const lines=['PRAGMA foreign_keys=OFF;'];
 for(const o of objects){lines.push(o.sql+';');if(o.type==='table'){for(const r of db.prepare('SELECT * FROM '+qi(o.name)).all())lines.push(`INSERT INTO ${qi(o.name)}(${Object.keys(r).map(qi).join(',')}) VALUES(${Object.values(r).map(literal).join(',')});`);}}
 return lines.join('\n');
}
