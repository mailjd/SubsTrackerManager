/** Read-only compatibility check for one-shot code releases.
 * No fabricated completion marker, migrations, credentials reset or KV lock.
 */
export const DIRECT_MODE='direct-compatible';
export async function directRuntimeReady(env){
  if(!env?.SUBSCRIPTIONS_KV||typeof env.SUBSCRIPTIONS_KV.get!=='function')return false;
  try{
    const [schema,raw]=await Promise.all([env.SUBSCRIPTIONS_KV.get('schema_version'),env.SUBSCRIPTIONS_KV.get('config')]);
    if(schema!=='v3')return false;
    const config=JSON.parse(raw||'null');
    return !!config&&typeof config.JWT_SECRET==='string'&&!!config.JWT_SECRET&&typeof config.CREDENTIALS_ENCRYPTION_KEY==='string'&&!!config.CREDENTIALS_ENCRYPTION_KEY;
  }catch{return false;}
}
export async function handleDirectGate(request,env,run){
  const pathname=new URL(request.url).pathname;
  const ready=await directRuntimeReady(env);
  const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
  if(pathname==='/api/upgrade/status'&&request.method==='GET')return json({success:ready,version:run.version,runId:run.id,mode:DIRECT_MODE,maintenance:!ready,phase:ready?'ready':'incompatible',schema:ready?'v3':null},ready?200:503);
  if(pathname.startsWith('/api/upgrade/'))return json({success:false,code:'DIRECT_RELEASE_NO_MIGRATION',message:'此版本使用直接兼容升级，不接收分段迁移或解锁操作。'},409);
  if(!ready){
    if(pathname.startsWith('/api/'))return json({success:false,code:'DIRECT_STORAGE_INCOMPATIBLE',message:'原 KV 绑定/结构/密钥未通过只读检查；没有初始化或重置资料。'},503);
    return new Response('SubsTracker：原 KV 绑定、v3 结构或配置密钥不可读；已停止业务处理，未创建数据库或重置资料。',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}});
  }
  return null;
}
