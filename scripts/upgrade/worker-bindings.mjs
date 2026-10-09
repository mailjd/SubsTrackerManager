/** Read-only resolution of D1 bindings from a CURRENT deployment, never a database
 * name, account-wide inventory, local hint, old deployment, or latest uploaded version.
 * Official APIs: Workers scripts settings, deployments, versions/{version_id}.
 */
import {isDeepStrictEqual} from 'node:util';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function fail(code,message){const error=new Error(code+'：'+message);error.code=code;throw error;}
export function checkedBindingList(value){
  if(!Array.isArray(value))fail('ST_BINDING_RESPONSE','Worker 綁定清單不完整；不能推斷為 KV-only。');
  const names=new Set();
  for(const row of value){
    if(!row||typeof row!=='object'||typeof row.name!=='string'||!row.name||typeof row.type!=='string'||!row.type)
      fail('ST_BINDING_RESPONSE','Worker 綁定欄位不完整；沒有修改遠端。');
    if(names.has(row.name))fail('ST_BINDING_DUPLICATE','Worker 綁定名稱重複；拒絕猜測目標。');
    names.add(row.name);
  }
  return value;
}
export function d1BindingId(row){
  if(!row)return null;
  const values=[row.database_id,row.id].filter(v=>v!==undefined&&v!==null&&v!=='');
  if(values.some(v=>typeof v!=='string'||!UUID.test(v)))fail('ST_BINDING_D1_ID','Cloudflare 返回無效 D1 ID；不按名稱尋找替代庫。');
  if(new Set(values.map(v=>v.toLowerCase())).size>1)fail('ST_BINDING_D1_ID','D1 API 同時返回不一致的 ID，已停止。');
  return values[0]?.toLowerCase()||null;
}
function canonical(rows,{omitD1=false}={}){
  return checkedBindingList(rows).filter(r=>!omitD1||r.type!=='d1').map(row=>{
    const {name,type}=row;
    if(type==='d1')return {name,type,id:d1BindingId(row)};
    if(type==='kv_namespace')return {name,type,namespace_id:typeof row.namespace_id==='string'?row.namespace_id.toLowerCase():row.namespace_id};
    if(type==='plain_text')return {name,type,text:row.text};
    if(type==='json'){
      let value=row.json;
      if(typeof value==='string'){try{value=JSON.parse(value);}catch{fail('ST_BINDING_RESPONSE','Worker JSON 變數格式無效；不改寫原變數。');}}
      return {name,type,json:value};
    }
    if(type==='secret_text'||type==='assets')return {name,type};
    return row; // Never discard unknown bindings to make an identity comparison pass.
  }).sort((a,b)=>a.name.localeCompare(b.name));
}
function activeDeployment(result){
  if(!Array.isArray(result?.deployments)||result.deployments.length===0)
    fail('ST_BINDING_PROBE_INCOMPLETE','沒有可核驗的現行部署；不能斷言原 D1 不存在。');
  // API contract: first entry is the deployment actively serving traffic.
  const deployment=result.deployments[0];
  if(!UUID.test(deployment?.id||'')||!Array.isArray(deployment?.versions))
    fail('ST_BINDING_PROBE_INCOMPLETE','現行部署識別資訊不完整。');
  if(deployment.versions.length!==1||deployment.versions[0]?.percentage!==100||!UUID.test(deployment.versions[0]?.version_id||''))
    fail('ST_BINDING_MULTIVERSION','現行部署不是單一版本承接 100% 流量；不從灰度版本猜測原 D1。');
  return {deploymentId:deployment.id.toLowerCase(),versionId:deployment.versions[0].version_id.toLowerCase()};
}
/** A normal, complete settings response remains the fast path. Missing D1 triggers
 * a second source ONLY when the caller requires D1; KV-only long-run upgrades remain valid.
 * An existing D1 row without an ID is ALWAYS unresolved, never silently downgraded.
 */
export async function resolveSettingsBindings(cf,worker,settings,{requireD1=false}={}){
  const original=checkedBindingList(settings?.bindings);
  const d1=original.filter(b=>b.type==='d1');
  if(d1.length>1)fail('ST_BINDING_STRUCTURE','存储绑定结构不同于当前应用，拒绝猜测目标。');
  const id=d1BindingId(d1[0]);
  if(id||(!requireD1&&d1.length===0))return settings;
  const base='/workers/scripts/'+encodeURIComponent(worker);
  console.log('[upgrade] ST_BINDING_FALLBACK '+JSON.stringify({worker,reason:d1.length?'d1-id-not-visible':'no-d1-in-settings',probe:'read-only'}));
  let active,version,confirmed,fresh;
  try{
    active=activeDeployment((await cf.request(base+'/deployments')).result);
    version=(await cf.request(base+'/versions/'+active.versionId)).result;
    if(typeof version?.id!=='string'||version.id.toLowerCase()!==active.versionId)
      fail('ST_BINDING_PROBE_INCOMPLETE','版本回應與現行部署 ID 不一致。');
    checkedBindingList(version?.resources?.bindings);
    confirmed=activeDeployment((await cf.request(base+'/deployments')).result);
    fresh=(await cf.request(base+'/settings')).result;
  }catch(error){
    if(String(error.code||'').startsWith('ST_BINDING_'))throw error;
    fail('ST_BINDING_PROBE_INCOMPLETE','現行版本綁定查詢失敗'+(error.httpStatus?'（HTTP '+error.httpStatus+'）':'')+'；請核對此 Worker 的 API 讀取權限。未判定為 KV-only，未寫入遠端。');
  }
  if(!isDeepStrictEqual(active,confirmed)||!isDeepStrictEqual(canonical(original),canonical(fresh?.bindings)))
    fail('ST_BINDING_CHANGED','查詢期間 Worker 部署或綁定已變更；請重試同一提交，不混用兩個版本。');
  const deployed=version.resources.bindings;
  if(!isDeepStrictEqual(canonical(original,{omitD1:true}),canonical(deployed,{omitD1:true})))
    fail('ST_BINDING_SOURCE_CONFLICT','settings 與現行版本的 KV／變數／Secret 名稱等綁定不一致；不合併不同來源。');
  const actual=deployed.filter(b=>b.type==='d1');
  if(actual.length>1)fail('ST_BINDING_STRUCTURE','現行版本含多個 D1；拒絕猜測。');
  const actualId=d1BindingId(actual[0]);
  if((actual.length&&!actualId)||(d1.length&&(!actualId||actual[0].name!==d1[0].name)))
    fail('ST_BINDING_D1_UNRESOLVED','原 D1 綁定仍無可核驗的 database_id/id；不能按 KV-only 發布。');
  if(!actualId){
    console.log('[upgrade] ST_BINDING_KV_ONLY_CONFIRMED '+JSON.stringify({worker,sources:['settings','active-deployment'],probe:'read-only'}));
    return settings;
  }
  console.log('[upgrade] ST_BINDING_D1_RECOVERED '+JSON.stringify({worker,binding:actual[0].name,source:'active-deployment',probe:'read-only'}));
  return {...settings,bindings:deployed,bindingDiscovery:{source:'active-deployment',...active}};
}
/** Compare storage and runtime values, not discovery metadata or response ordering. */
export function assertSameBindingIdentity(expected,current){
  const image=b=>({kvId:b.kvId?.toLowerCase(),dbId:b.dbId?.toLowerCase()||null,
    secrets:[...(b.secretNames||[])].sort(),variables:canonical(b.variables||[])});
  if(!isDeepStrictEqual(image(expected),image(current)))
    fail('ST_BINDING_CHANGED','預檢後原 Worker 的儲存綁定／Variables／Secret 名稱已變更；尚未繼續寫入或發布。');
  return true;
}
