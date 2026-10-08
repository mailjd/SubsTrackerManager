/** Isolated fake Cloudflare transport used ONLY by runner integration tests. No network fallback. */
import fs from 'node:fs';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';import {pathToFileURL} from 'node:url';
const root=process.env.FAKE_UPGRADE_ROOT,dir=process.env.FAKE_UPGRADE_STATE;
if(!root||!dir)throw new Error('Missing synthetic integration fixture');
const db=new DatabaseSync(path.join(dir,'d1.sqlite')),kvFile=path.join(dir,'kv.json'),kv=()=>JSON.parse(fs.readFileSync(kvFile,'utf8'));
const {dumpSql}=await import(pathToFileURL(path.join(root,'tests/upgrade/helpers.mjs')));
const {handleUpgradeGate}=await import(pathToFileURL(path.join(root,'src/data/upgrade-gate.js')));
class St{constructor(text,args=[]){this.text=text;this.args=args;}bind(...args){return new St(this.text,args);}async first(col){const r=db.prepare(this.text).get(...this.args)||null;return col?r?.[col]??null:r;}async all(){return {success:true,results:db.prepare(this.text).all(...this.args)};}async run(){const r=db.prepare(this.text).run(...this.args);return {success:true,meta:{changes:Number(r.changes)}};}}
const env={SUBSCRIPTIONS_KV:{async get(k){return kv()[k]??null;},async put(k,v){const x=kv();x[k]=String(v);fs.writeFileSync(kvFile,JSON.stringify(x));},async list({prefix='',limit=500,cursor='0'}={}){const keys=Object.keys(kv()).filter(k=>k.startsWith(prefix)).sort(),i=Number(cursor);return {keys:keys.slice(i,i+limit).map(name=>({name})),list_complete:i+limit>=keys.length,cursor:i+limit<keys.length?String(i+limit):''};}},SUBSCRIPTIONS_DB:{prepare:s=>new St(s),async batch(stmts){db.exec('BEGIN');try{const r=[];for(const st of stmts)r.push(await st.run());db.exec('COMMIT');return r;}catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}}}};
const ok=(result,extra={})=>new Response(JSON.stringify({success:true,result,...extra}),{headers:{'Content-Type':'application/json'}});
const normalNow=Date.now;let clockOffset=0;Date.now=()=>normalNow()+clockOffset;
globalThis.fetch=async(input,opt={})=>{
 const url=new URL(input instanceof Request?input.url:input);fs.appendFileSync(path.join(dir,'transport.jsonl'),JSON.stringify({host:url.host,path:url.pathname,method:opt.method||'GET'})+'\n');
 if(url.host==='export.invalid')return new Response(dumpSql(db));
 if(url.host==='upgrade.example.invalid'){
   if(!fs.existsSync(path.join(dir,'deployed')))return new Response('{}',{status:404});
   const text=fs.readFileSync(path.join(root,'src/upgrade-release.js'),'utf8'),run=JSON.parse(text.match(/Object\.freeze\((\{[^\n]+\})\)/)[1]);
   if(url.pathname.endsWith('/status'))clockOffset=17*60*1000; // only test runtime; production retains 16-minute drain.
   const response=await handleUpgradeGate(new Request(url,opt),env,run);
   if(url.pathname.endsWith('/apply')&&process.env.FAKE_LOSE_APPLY_RESPONSE==='1'&&!fs.existsSync(path.join(dir,'lost-once'))){fs.writeFileSync(path.join(dir,'lost-once'),'1');throw new Error('Synthetic connection lost after server committed apply');}
   if(url.pathname.endsWith('/commit')&&process.env.FAKE_LOSE_COMMIT_RESPONSE==='1'&&!fs.existsSync(path.join(dir,'lost-commit'))){fs.writeFileSync(path.join(dir,'lost-commit'),'1');throw new Error('Synthetic connection lost after server committed unlock');}
   return response;
 }
 if(url.host!=='api.cloudflare.com')throw new Error('Synthetic transport refuses real network: '+url.host);
 const p=url.pathname;
 if(p.endsWith('/settings'))return ok({bindings:[{name:'SUBSCRIPTIONS_KV',type:'kv_namespace',namespace_id:'b'.repeat(32)},{name:'SUBSCRIPTIONS_DB',type:'d1',database_id:'12345678-1234-1234-1234-123456789abc'},{name:'KEEP_SECRET',type:'secret_text'},{name:'ENVIRONMENT',type:'plain_text',text:'production'}]});
 if(p.endsWith('/schedules'))return ok({schedules:[{cron:'0 * * * *'}]});
 if(p.endsWith('/subdomain'))return ok({enabled:true,subdomain:'existing'});
 if(p.includes('/storage/kv/namespaces/')){
  if(p.endsWith('/keys'))return ok(Object.keys(kv()).sort().map(name=>({name})),{result_info:{cursor:'',count:Object.keys(kv()).length}});
  if(p.includes('/values/'))return new Response(kv()[decodeURIComponent(p.split('/values/')[1])]);
  return ok({id:'b'.repeat(32),title:'CUSTOM-KEEP-EXISTING'});
 }
 if(p.includes('/d1/database/'))return p.endsWith('/export')?ok({status:'complete',result:{signed_url:'https://export.invalid/database.sql'}}):ok({uuid:'12345678-1234-1234-1234-123456789abc',name:'CUSTOM-EXISTING-D1'});
 if(/\/workers\/scripts\/[^/]+$/.test(p))return new Response('synthetic previous Worker source');
 throw new Error('Unexpected API route: '+p);
};
