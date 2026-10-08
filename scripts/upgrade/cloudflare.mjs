/** All discovery/snapshot APIs are read-only. SQL export is a read operation using POST.
 * No create/namespace replacement/credential reset is present in the upgrade path. */
import {setTimeout as sleep} from 'node:timers/promises';
export class Cloudflare {
  constructor({accountId,token,fetchImpl=fetch}){
    if(!/^[a-fA-F0-9]{32}$/.test(accountId||'')||!token)throw new Error('缺少有效 CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN');
    this.accountId=accountId;this.token=token;this.fetchImpl=fetchImpl;
  }
  async request(path,{method='GET',body,raw=false}={}){
    const url='https://api.cloudflare.com/client/v4/accounts/'+this.accountId+path;
    for(let n=0;n<5;n++){
      const r=await this.fetchImpl(url,{method,redirect:'error',headers:{Authorization:'Bearer '+this.token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(120000)});
      if((r.status===429||r.status>=500)&&n<4){await sleep(Math.min(30000,1000*2**n));continue;}
      if(raw){if(!r.ok)throw new Error(`Cloudflare 读取失败 HTTP ${r.status} (${path.split('?')[0]})`);return Buffer.from(await r.arrayBuffer());}
      let data;try{data=await r.json();}catch{throw new Error('Cloudflare 返回非 JSON，已停止');}
      if(!r.ok||data.success!==true)throw new Error(`Cloudflare 请求失败 HTTP ${r.status} (${path.split('?')[0]})：${(data.errors||[]).map(e=>e.code).join(',')}`);
      return data;
    }
  }
  async settings(worker){return (await this.request(`/workers/scripts/${encodeURIComponent(worker)}/settings`)).result;}
  async schedules(worker){const r=(await this.request(`/workers/scripts/${encodeURIComponent(worker)}/schedules`)).result;if(!Array.isArray(r?.schedules))throw new Error('未取得完整 Cron 配置');return r.schedules;}
  async scriptSubdomain(worker){return (await this.request(`/workers/scripts/${encodeURIComponent(worker)}/subdomain`)).result;}
  async accountSubdomain(){return (await this.request('/workers/subdomain')).result;}
  async namespace(id){return (await this.request('/storage/kv/namespaces/'+encodeURIComponent(id))).result;}
  async database(id){return (await this.request('/d1/database/'+encodeURIComponent(id))).result;}
  async snapshotKV(id){
    const rows=[],seen=new Set(),cursors=new Set();let cursor='';
    do{
      const page=await this.request('/storage/kv/namespaces/'+encodeURIComponent(id)+'/keys?limit=1000'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
      if(!Array.isArray(page.result))throw new Error('KV 返回无效 key 列表');
      if(!page.result_info || typeof page.result_info.cursor!=='string')throw new Error('KV 分页元数据不完整，拒绝猜测已到末页');
      if(page.result_info.count!=null && page.result_info.count!==page.result.length)throw new Error('KV 页计数不符，备份已停止');
      for(const key of page.result){if(seen.has(key.name))throw new Error('KV 分页出现重复 key；数据仍在变化');seen.add(key.name);
        const value=await this.request('/storage/kv/namespaces/'+encodeURIComponent(id)+'/values/'+encodeURIComponent(key.name),{raw:true});
        rows.push({name:key.name,valueBase64:value.toString('base64'),...(key.expiration!=null?{expiration:key.expiration}:{}),...(key.metadata!==undefined?{metadata:key.metadata}:{})});}
      cursor=page.result_info?.cursor||'';
      if(cursor&&cursors.has(cursor))throw new Error('KV 分页游标未前进，拒绝不完整备份');cursors.add(cursor);
    }while(cursor);
    return rows.sort((a,b)=>a.name.localeCompare(b.name));
  }
  async exportSQL(id){
    let bookmark;
    for(let n=0;n<180;n++){
      const result=(await this.request('/d1/database/'+encodeURIComponent(id)+'/export',{method:'POST',body:{output_format:'polling',...(bookmark?{current_bookmark:bookmark}:{})}})).result;
      if(result?.status==='error')throw new Error('D1 SQL 导出失败');
      if(result?.status==='complete'){
        const url=new URL(result.result?.signed_url||'');if(url.protocol!=='https:')throw new Error('SQL 下载地址不是 HTTPS');
        // Signed export URL: never forward the Cloudflare API token to this host.
        const r=await this.fetchImpl(url,{signal:AbortSignal.timeout(120000)});
        if(!r.ok)throw new Error('SQL 导出文件下载失败');const sql=await r.text();if(!sql.trim())throw new Error('SQL 导出为空');return sql;
      }
      if(!result?.at_bookmark)throw new Error('D1 导出未返回轮询书签');bookmark=result.at_bookmark;await sleep(1000);
    }
    throw new Error('D1 导出超时；没有继续部署');
  }
}
export function protectBindings(config,settings){
  if(!Array.isArray(settings?.bindings))throw new Error('无法读取正在运行的 Worker 绑定；不按名称创建替代库');
  const allowed=new Set(['kv_namespace','d1','plain_text','json','secret_text','assets']);
  const unknown=settings.bindings.filter(b=>!allowed.has(b.type));
  if(unknown.length)throw new Error('存在未纳入升级器的其他绑定，请保留原配置并人工审查：'+unknown.map(b=>b.name).join(','));
  const allKv=settings.bindings.filter(b=>b.type==='kv_namespace'),allDb=settings.bindings.filter(b=>b.type==='d1');
  if(allKv.length!==1||allKv[0].name!=='SUBSCRIPTIONS_KV'||allDb.length>1||(allDb[0]&&allDb[0].name!=='SUBSCRIPTIONS_DB'))throw new Error('存储绑定结构不同于当前应用，拒绝猜测目标');
  if(allDb[0]?.database_id && allDb[0]?.id && allDb[0].database_id!==allDb[0].id)throw new Error('D1 API 同时返回不一致的 ID，已停止');
  const kvId=allKv[0].namespace_id,dbId=allDb[0]?.database_id||allDb[0]?.id||null;
  if(!/^[a-fA-F0-9]{32}$/.test(kvId||'')||(dbId&&!/^[a-fA-F0-9-]{36}$/.test(dbId)))throw new Error('Cloudflare 返回无效存储 ID');
  for(const row of config.kv_namespaces||[]){if(row.binding!=='SUBSCRIPTIONS_KV'||(row.id&&row.id!==kvId))throw new Error('本地 KV ID 与在线 Worker 不同，已停止防止改绑');}
  for(const row of config.d1_databases||[]){if(row.binding!=='SUBSCRIPTIONS_DB'||(row.database_id&&row.database_id!==dbId))throw new Error('本地 D1 ID 与在线 Worker 不同，已停止防止改绑');}
  return {kvId,dbId,secretNames:settings.bindings.filter(b=>b.type==='secret_text').map(b=>b.name).sort(),variables:settings.bindings.filter(b=>b.type==='plain_text'||b.type==='json')};
}
