/** TEST ONLY: API-shape fixture for the REAL default CLI, with no network fallback.
 * No KV/D1 mock implementation exists: any data API access is an immediate failure.
 */
import fs from 'node:fs';
import path from 'node:path';
const root=process.env.FAKE_UPGRADE_ROOT,state=process.env.FAKE_UPGRADE_STATE;
if(!root||!state)throw new Error('synthetic fixture required');
const old='00000000-1111-2222-3333-000000000001',next='00000000-1111-2222-3333-000000000002';
const published=()=>fs.existsSync(path.join(state,'published-config.json'));
const bindings=()=>[
  {name:'ORIGINAL_SECRET',type:'secret_text'},
  ...Object.entries(published()?JSON.parse(fs.readFileSync(path.join(state,'published-config.json'))).vars:{ENVIRONMENT:'original'}).map(([name,text])=>({name,type:'plain_text',text})),
  ...(published()?JSON.parse(fs.readFileSync(path.join(state,'published-config.json'))).kv_namespaces.map(b=>({name:b.binding,type:'kv_namespace',namespace_id:b.id})):(process.env.FAKE_UNBOUND_KV==='1'?[{name:'SUBSCRIPTIONS_KV',type:'kv_namespace',namespace_id:'b'.repeat(32)}]:[])),
  ...(published()?JSON.parse(fs.readFileSync(path.join(state,'published-config.json'))).d1_databases.map(b=>({name:b.binding,type:'d1',database_id:b.database_id})):(process.env.FAKE_WEB_INIT_D1==='1'?[{name:'SUBSCRIPTIONS_DB',type:'d1',id:old}]:[]))
];
const ok=result=>Response.json({success:true,result});
globalThis.fetch=async(input,opts={})=>{
  const url=new URL(input);fs.appendFileSync(path.join(state,'transport.jsonl'),JSON.stringify({url:url.href,method:opts.method||'GET'})+'\n');
  if(url.origin!=='https://api.cloudflare.com'||(opts.method||'GET')!=='GET'||!url.pathname.includes('/workers/'))throw new Error('TEST: forbidden data/write/non-Cloudflare request');
  const p=url.pathname,version=published()?next:old;
  if(p.endsWith('/settings'))return ok({bindings:bindings()});
  if(p.endsWith('/deployments'))return ok({deployments:[{id:version,versions:[{version_id:version,percentage:100}]}]});
  if(p.includes('/versions/'))return ok({id:version,resources:{bindings:bindings()}});
  if(p.endsWith('/schedules'))return ok({schedules:[{cron:'0 * * * *'}]});
  if(p.endsWith('/subdomain'))return ok({enabled:false,previews_enabled:false});
  if(p.endsWith('/workers/domains')||p.endsWith('/workers/scripts'))return ok([]);
  throw new Error('TEST: unexpected API shape: '+p);
};
