import {getConfig} from '../../data/config.js';
import {ensureLedgerSeed,allLedgerEntries} from '../../data/subscription-ledger.js';
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});}
/** Read-only financial history. Editing/deleting current subscriptions does not mutate this store. */
export async function handleSubscriptionHistory(request,env,path){
  if(path!=='/subscription-history')return null;
  if(request.method!=='GET')return json({success:false,message:'订阅历史为累计记录，不支持覆盖或删除'},405);
  try{
    await ensureLedgerSeed(env);
    const u=new URL(request.url),q=(u.searchParams.get('q')||'').trim().toLocaleLowerCase();
    const subscriptionId=u.searchParams.get('subscriptionId')||'';
    const type=u.searchParams.get('type')||'',from=u.searchParams.get('from')||'',to=u.searchParams.get('to')||'';
    const timezone=(await getConfig(env)).TIMEZONE||'UTC';
    const dateKey=v=>new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(v));
    let rows=await allLedgerEntries(env);
    const types=[...new Set(rows.map(e=>e.snapshot.customType||'开会员'))].sort();
    rows=rows.filter(e=>{
      const s=e.snapshot,date=dateKey(e.occurredAt);
      return (!subscriptionId||e.subscriptionId===subscriptionId)&&(!type||(s.customType||'开会员')===type)&&(!from||date>=from)&&(!to||date<=to)&&(!q||[s.name,s.account,s.accountSerial,s.users,s.customType,s.notes].some(v=>String(v||'').toLocaleLowerCase().includes(q)));
    });
    const pageSize=Math.min(500,Math.max(10,Number(u.searchParams.get('pageSize'))||50));
    const total=rows.length,totalPages=Math.ceil(total/pageSize),page=Math.min(Math.max(1,Number(u.searchParams.get('page'))||1),Math.max(1,totalPages));
    return json({success:true,items:rows.slice((page-1)*pageSize,page*pageSize),total,totalPages,page,pageSize,types,timezone});
  }catch(e){return json({success:false,message:e.message||'读取订阅历史失败'},500);}
}
