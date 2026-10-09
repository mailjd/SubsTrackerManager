/** All discovery/snapshot APIs are read-only. D1 backup uses read-only SELECT/PRAGMA via POST.
 * No create/namespace replacement/credential reset is present in the upgrade path. */
import {checkedBindingList,d1BindingId,resolveSettingsBindings} from './worker-bindings.mjs';
import {setTimeout as sleep} from 'node:timers/promises';
import {snapshotD1WithQueries} from './d1-query-snapshot.mjs';
import {assertD1KVConfig,assertD1KVRequest} from './storage-policy.mjs';
export class Cloudflare {
  constructor({accountId,token,fetchImpl=fetch}){
    if(!/^[a-fA-F0-9]{32}$/.test(accountId||'')||!token)throw new Error('缺少有效 CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN');
    this.accountId=accountId;this.token=token;this.fetchImpl=fetchImpl;
  }
  async request(path,{method='GET',body,raw=false,allowNotFound=false}={}){
    assertD1KVRequest(path,method);
    const url='https://api.cloudflare.com/client/v4/accounts/'+this.accountId+path;
    for(let n=0;n<5;n++){
      const r=await this.fetchImpl(url,{method,redirect:'error',headers:{Authorization:'Bearer '+this.token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(120000)});
      if(r.status===404 && allowNotFound)return null;
      if((r.status===429||r.status>=500)&&n<4){await sleep(Math.min(30000,1000*2**n));continue;}
      if(raw){if(!r.ok)throw new Error(`Cloudflare 读取失败 HTTP ${r.status} (${path.split('?')[0]})`);return Buffer.from(await r.arrayBuffer());}
      let data;try{data=await r.json();}catch{throw new Error('Cloudflare 返回非 JSON，已停止');}
      if(!r.ok||data?.success!==true){
        const error=new Error(`Cloudflare 请求失败 HTTP ${r.status} (${path.split('?')[0]})：${(data?.errors||[]).map(e=>e.code).join(',')}`);
        error.httpStatus=r.status;error.cloudflareCodes=(data?.errors||[]).map(e=>e.code);throw error;
      }
      return data;
    }
  }
  async settings(worker,options={}){const settings=(await this.request(`/workers/scripts/${encodeURIComponent(worker)}/settings`)).result;return resolveSettingsBindings(this,worker,settings,options);}
  async schedules(worker){const r=(await this.request(`/workers/scripts/${encodeURIComponent(worker)}/schedules`)).result;if(!Array.isArray(r?.schedules))throw new Error('未取得完整 Cron 配置');return r.schedules;}
  async scriptSubdomain(worker){return (await this.request(`/workers/scripts/${encodeURIComponent(worker)}/subdomain`)).result;}
  async accountSubdomain(){return (await this.request('/workers/subdomain')).result;}
  async namespace(id){return (await this.request('/storage/kv/namespaces/'+encodeURIComponent(id))).result;}
  async database(id){return (await this.request('/d1/database/'+encodeURIComponent(id))).result;}
  async snapshotKV(id,{excludePrefix}={}){
    if(excludePrefix && !/^__substracker_upgrade_artifacts_v1__:[a-f0-9]{32}:$/.test(excludePrefix))throw new Error('无效的内部备份前缀');
    const rows=[],seen=new Set(),cursors=new Set();let cursor='';
    do{
      const page=await this.request('/storage/kv/namespaces/'+encodeURIComponent(id)+'/keys?limit=1000'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
      if(!Array.isArray(page.result))throw new Error('KV 返回无效 key 列表');
      if(!page.result_info || typeof page.result_info.cursor!=='string')throw new Error('KV 分页元数据不完整，拒绝猜测已到末页');
      if(page.result_info.count!=null && page.result_info.count!==page.result.length)throw new Error('KV 页计数不符，备份已停止');
      for(const key of page.result){if(seen.has(key.name))throw new Error('KV 分页出现重复 key；数据仍在变化');seen.add(key.name);
        if(excludePrefix && key.name.startsWith(excludePrefix))continue; // Dedicated encrypted build artifacts only; never business keys.
        const value=await this.request('/storage/kv/namespaces/'+encodeURIComponent(id)+'/values/'+encodeURIComponent(key.name),{raw:true});
        rows.push({name:key.name,valueBase64:value.toString('base64'),...(key.expiration!=null?{expiration:key.expiration}:{}),...(key.metadata!==undefined?{metadata:key.metadata}:{})});}
      cursor=page.result_info?.cursor||'';
      if(cursor&&cursors.has(cursor))throw new Error('KV 分页游标未前进，拒绝不完整备份');cursors.add(cursor);
    }while(cursor);
    return rows.sort((a,b)=>a.name.localeCompare(b.name));
  }
  async exportSQL(id){
    // Compatibility method name; implementation is D1 query-only, with no export job or signed download.
    return snapshotD1WithQueries(this,id);
  }
}
export function protectBindings(config,settings){
  assertD1KVConfig(config);
  checkedBindingList(settings?.bindings);
  if(settings.bindings.some(b=>b.type==='r2_bucket'))throw new Error('ST_STORAGE_POLICY：原 Worker 含 R2 綁定；本版不使用 R2，不自動刪除或移轉，請先核對原資源。');
  const allowed=new Set(['kv_namespace','d1','plain_text','json','secret_text','assets']);
  const unknown=settings.bindings.filter(b=>!allowed.has(b.type));
  if(unknown.length)throw new Error('存在未纳入升级器的其他绑定，请保留原配置并人工审查：'+unknown.map(b=>b.name).join(','));
  const allKv=settings.bindings.filter(b=>b.type==='kv_namespace'),allDb=settings.bindings.filter(b=>b.type==='d1');
  if(allKv.length!==1||allKv[0].name!=='SUBSCRIPTIONS_KV'||allDb.length>1||(allDb[0]&&allDb[0].name!=='SUBSCRIPTIONS_DB'))throw new Error('存储绑定结构不同于当前应用，拒绝猜测目标');
  const kvId=typeof allKv[0].namespace_id==='string'?allKv[0].namespace_id.toLowerCase():null,dbId=d1BindingId(allDb[0]);
  if(allDb.length&&!dbId)throw new Error('ST_BINDING_D1_UNRESOLVED：原 D1 綁定沒有可核實的 ID；不能當成 KV-only 部署。');
  if(!/^[a-f0-9]{32}$/.test(kvId||''))throw new Error('Cloudflare 返回无效存储 ID');
  if((config.kv_namespaces||[]).length>1||(config.d1_databases||[]).length>1)throw new Error('本地存储绑定结构不同，拒绝忽略重复绑定');
  for(const row of config.kv_namespaces||[]){if(row.binding!=='SUBSCRIPTIONS_KV'||(row.id&&String(row.id).toLowerCase()!==kvId))throw new Error('本地 KV ID 与在线 Worker 不同，已停止防止改绑');}
  for(const row of config.d1_databases||[]){if(row.binding!=='SUBSCRIPTIONS_DB'||(row.database_id&&String(row.database_id).toLowerCase()!==dbId))throw new Error('本地 D1 ID 与在线 Worker 不同，已停止防止改绑');}
  return {kvId,dbId,secretNames:settings.bindings.filter(b=>b.type==='secret_text').map(b=>b.name).sort(),variables:settings.bindings.filter(b=>b.type==='plain_text'||b.type==='json')};
}
