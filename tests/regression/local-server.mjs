/** Local-only regression server: production router/services with file-backed KV and SQLite D1 adapters.
 * Never connects to Cloudflare. Bind localhost only. No dependencies, Node >=22.13.
 * Usage: node tests/regression/local-server.mjs <sourceRoot> <storageDir> <port> [kv-only]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const root = path.resolve(process.argv[2] || '.');
const state = path.resolve(process.argv[3] || '/tmp/substracker-regression');
const port = Number(process.argv[4] || 8778);
fs.mkdirSync(state, {recursive:true});
const kvPath = path.join(state,'kv.json');
const tracePath = path.join(state,'requests.jsonl');
let kv = fs.existsSync(kvPath) ? JSON.parse(fs.readFileSync(kvPath,'utf8')) : {};
const flush = () => fs.writeFileSync(kvPath, JSON.stringify(kv,null,2));
const sql = new DatabaseSync(path.join(state,'d1.sqlite'));
class Statement {
  constructor(text,args=[]) { this.text=text; this.args=args; }
  bind(...args) { return new Statement(this.text,args); }
  async run(){ const r=sql.prepare(this.text).run(...this.args); return {success:true,meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}; }
  async all(){ return {success:true,results:sql.prepare(this.text).all(...this.args),meta:{}}; }
  async first(col){ const v=sql.prepare(this.text).get(...this.args) || null; return col?(v?.[col]??null):v; }
  async raw(){return sql.prepare(this.text).all(...this.args).map(Object.values);}
}
const controls={failPatch:false,delayPatch:0,dropWrites:false,dropReminderWrites:false,dropD1Writes:false,failIds:[],staleReads:false,stale:new Map()};
const env = {SUBSCRIPTIONS_KV:{
  async get(key,opts){let v=controls.staleReads && controls.stale.has(key)?controls.stale.get(key):(kv[key]??null); return (opts==='json'||opts?.type==='json') && v!==null ? JSON.parse(v) : v;},
  async put(key,value){fs.appendFileSync(path.join(state,'writes.jsonl'),JSON.stringify({key,at:Date.now()})+'\n');if((controls.dropWrites && key.startsWith('sub:'))||(controls.dropReminderWrites && key.startsWith('reminder_rules:')))return; kv[key]=String(value);flush();},
  async delete(key){delete kv[key];flush();},
  async list({prefix='',limit=1000,cursor=''}={}){const keys=Object.keys(kv).filter(x=>x.startsWith(prefix)).sort();const i=Number(cursor)||0;return {keys:keys.slice(i,i+limit).map(name=>({name})),list_complete:i+limit>=keys.length,cursor:i+limit<keys.length?String(i+limit):''};}
}};
if(process.argv[5]!=='kv-only') env.SUBSCRIPTIONS_DB={
  prepare(text){return new Statement(text);},
  async batch(statements){if(controls.dropD1Writes)return statements.map(()=>({success:true,meta:{changes:0}}));sql.exec('BEGIN');try{const out=[];for(const st of statements)out.push(await st.run());sql.exec('COMMIT');return out;}catch(e){sql.exec('ROLLBACK');throw e;}},
  async exec(text){sql.exec(text);return {count:1,duration:0};}
};
const {handleApiRequest}=await import(pathToFileURL(path.join(root,'src/api/router.js')));
const {ensureMigrations}=await import(pathToFileURL(path.join(root,'src/data/migrate.js')));
const {generateJWT}=await import(pathToFileURL(path.join(root,'src/core/auth.js')));
if(!kv.config){
 kv.config=JSON.stringify({ADMIN_USERNAME:'regression',ADMIN_PASSWORD:'local-test-only',JWT_SECRET:'local-regression-key',CREDENTIALS_ENCRYPTION_KEY:'local-regression-credentials',TIMEZONE:'Asia/Shanghai',THEME_MODE:'dark',ENABLED_NOTIFIERS:[]});
 kv.schema_version='v3';
 const samples=[
  {id:'row-a',name:'Baseline A',customType:'开会员'},
  {id:'row-b',name:'Baseline B',customType:'开会员'},
  {id:'row-history',name:'Historical',customType:'旧类型',startDate:'2025-01-01T16:00:00.000Z',expiryDate:'2025-02-01T16:00:00.000Z'}
 ].map(s=>({account:'',accountSerial:'',memberLevel:'Pro',points:100,users:'Test user',category:'Test',amount:10,currency:'CNY',subscriptionMode:'reset',startDate:'2030-09-24T16:00:00.000Z',expiryDate:'2030-10-24T16:00:00.000Z',periodValue:1,periodUnit:'month',useLunar:false,endOfMonth:false,reminderUnit:'day',reminderValue:1,notes:'Original note',isActive:true,autoRenew:false,paymentHistory:[],createdAt:'2026-09-20T00:00:00.000Z',updatedAt:'2026-09-20T00:00:00.000Z',...s}));
 kv.sub_index=JSON.stringify(samples.map(s=>s.id));samples.forEach(s=>kv['sub:'+s.id]=JSON.stringify(s));flush();
}
await ensureMigrations(env);
const token=await generateJWT('regression',JSON.parse(kv.config).JWT_SECRET);
const utilityCss=`*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif}button,input,select,textarea{font:inherit}button{cursor:pointer}.hidden{display:none!important}.flex,.inline-flex{display:flex}.flex-wrap{flex-wrap:wrap}.flex-col{flex-direction:column}.items-center{align-items:center}.justify-between{justify-content:space-between}.justify-end{justify-content:flex-end}.gap-2{gap:.5rem}.gap-3{gap:.75rem}.gap-4{gap:1rem}.p-4{padding:1rem}.p-6{padding:1.5rem}.px-4{padding-left:1rem;padding-right:1rem}.py-2{padding-top:.5rem;padding-bottom:.5rem}.w-full{width:100%}.overflow-x-auto{overflow-x:auto}.overflow-y-auto{overflow-y:auto}.relative{position:relative}.fixed{position:fixed}.inset-0{inset:0}.bg-white{background:#fff}.border{border:1px solid #aaa}.rounded-lg{border-radius:.5rem}table{border-collapse:collapse}.text-sm{font-size:14px}.text-xs{font-size:12px}.max-w-7xl{max-width:1280px}.mx-auto{margin:auto}button:disabled{opacity:.5;cursor:default}`;
http.createServer(async(req,res)=>{try{
 const url=new URL(req.url,`http://127.0.0.1:${port}`);const buffers=[];for await(const c of req)buffers.push(c);const body=Buffer.concat(buffers).toString();
 if(url.pathname==='/__test__/login'){res.writeHead(200,{'Set-Cookie':`token=${token}; Path=/; SameSite=Lax`,'Content-Type':'application/json'});return res.end('{"success":true}');}
 if(url.pathname==='/__test__/state'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(kv));}
 if(url.pathname==='/__test__/controls' && req.method==='POST'){Object.assign(controls,JSON.parse(body||'{}'));if(controls.staleReads)controls.stale=new Map(Object.entries(kv));res.setHeader('Content-Type','application/json');return res.end('{}');}
 if(url.pathname==='/__test__/trace'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(fs.existsSync(tracePath)?fs.readFileSync(tracePath,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[]));}
 if(url.pathname==='/__test__/utility.css'){res.setHeader('Content-Type','text/css');return res.end(utilityCss);}
 if(url.pathname==='/admin' || url.pathname==='/'){
  let html=fs.readFileSync(path.join(root,'src/views/adminPage.html'),'utf8').replace(/\$\{themeResources\}/g,()=>fs.readFileSync(path.join(root,'src/views/theme-resources.html'),'utf8'));
  html=html.replace(/<link[^>]+href="https:[^"]+"[^>]*>/g,'').replace(/<script[^>]+src="https:[^"]+"[^>]*><\/script>/g,'');
  html=html.replace('</head>','<link rel="stylesheet" href="/__test__/utility.css"></head>');
  res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(html);
 }
 const isPatch=req.method==='PATCH'&&url.pathname.endsWith('/table-edit');
 if(isPatch && controls.delayPatch)await new Promise(r=>setTimeout(r,controls.delayPatch));
 const request=new Request(url,{method:req.method,headers:req.headers,...(body?{body}:{})});
 await ensureMigrations(env);
 const response=isPatch&&(controls.failPatch||controls.failIds.includes(decodeURIComponent(url.pathname.split('/')[3]))) ? new Response('{"success":false,"message":"injected local regression failure"}',{status:500,headers:{'Content-Type':'application/json'}}) : await handleApiRequest(request,env);
 const text=await response.text();if(url.pathname.startsWith('/api/subscriptions')) fs.appendFileSync(tracePath,JSON.stringify({at:new Date().toISOString(),method:req.method,path:url.pathname,request:body?JSON.parse(body):null,status:response.status,response:JSON.parse(text)})+'\n');
 res.writeHead(response.status,Object.fromEntries(response.headers));res.end(text);
 }catch(e){console.error(e);res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({success:false,message:e.message}));}
}).listen(port,'127.0.0.1',()=>console.log(`READY http://127.0.0.1:${port} source=${root} storage=${state}`));
