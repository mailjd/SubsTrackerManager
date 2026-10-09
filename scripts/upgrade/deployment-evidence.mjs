/** v3.3.33: separate release identity, public URL reachability and data readiness.
 * Control-plane identity is authoritative for CODE publication, never for init.
 * The marker is non-secret Worker metadata, not a KV/D1 key or an auth bypass.
 */
import {isDeepStrictEqual} from 'node:util';
export const RELEASE_MARKER='SUBSTRACKER_CODE_RELEASE_V1';
export const MARKER_FORMAT='substracker-code-release-v1';
export function deploymentMarker(plan){
  return JSON.stringify({format:MARKER_FORMAT,version:plan.version,mode:'deferred-web-init',runId:plan.runId,sourceHash:plan.sourceHash});
}
export function assertMarkerAvailable(bindings){
  const row=bindings.find(b=>b.name===RELEASE_MARKER);
  if(!row)return;
  let marker;try{marker=JSON.parse(row.text);}catch{/* refuse an unrelated pre-existing variable */}
  if(row.type!=='plain_text'||marker?.format!==MARKER_FORMAT||marker.mode!=='deferred-web-init'||!/^\d+\.\d+\.\d+-web-init-[a-f0-9-]{36}$/.test(marker.runId||'')||!/^[a-f0-9]{64}$/.test(marker.sourceHash||'')){
    const error=new Error('ST_UNBOUND_MARKER_COLLISION：保留名稱 '+RELEASE_MARKER+' 已被其他設定使用；未覆蓋原值。');error.code='ST_UNBOUND_MARKER_COLLISION';throw error;
  }
}
export function releaseEvidence(plan,snapshot){
  const active=snapshot.active;
  if(active.deploymentId===plan.previousDeployment.deploymentId||active.versionId===plan.previousDeployment.versionId)return false;
  const marker=deploymentMarker(plan);
  const expected=plan.bindingIdentity.filter(b=>b.type!=='assets'&&b.name!==RELEASE_MARKER);
  const current=snapshot.bindings.filter(b=>b.type!=='assets'&&b.name!==RELEASE_MARKER);
  if(!isDeepStrictEqual(expected,current))throw new Error('ST_UNBOUND_CHANGED：發布後原變數或機密名稱變更；未把此結果當成本次部署成功。');
  // readUnbound already checks settings == the ACTIVE version's binding list.
  // This unique nonce + source digest must be in BOTH, not only the latest upload.
  const row=snapshot.bindings.find(b=>b.name===RELEASE_MARKER);
  return row?.type==='plain_text'&&row.text===marker;
}
function origin(value){
  if(typeof value!=='string'||value.trim()!==value)return null;
  try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/')return null;return u.origin;}catch{return null;}
}
function hostnameOrigin(hostname){
  if(typeof hostname!=='string'||!/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z0-9-]+$/.test(hostname))return null;
  return origin('https://'+hostname);
}
export function rootRouteOrigin(pattern){
  // Do not invent a hostname from *.example.com or turn /app/* into root /init.
  if(typeof pattern!=='string'||pattern.startsWith('http://'))return null;
  const text=pattern.replace(/^https:\/\//,'');
  const match=/^([^/]+)\/\*$/.exec(text);
  return match?hostnameOrigin(match[1]):null;
}
/** URL discovery is OPTIONAL and bounded. No URL or lack of discovery permission
 * must not prevent a storage-free CODE release. No credentials go to these URLs.
 * Missing fields never mean a known route, or a disabled workers.dev setting.
 */
export async function discoverReleaseURLs(cf,{worker,domain,explicit}){
  const candidates=[],warnings=[];
  const add=(url,source)=>{if(url&&!candidates.some(c=>c.url===url))candidates.push({url,source});};
  if(explicit){const url=origin(explicit);if(url)add(url,'explicit');else warnings.push({code:'ST_URL_INVALID',message:'SUBSTRACKER_WORKER_URL 不是有效 HTTPS 根網址；已忽略，不影響程式發布。'});}
  if(candidates.length)return {candidates,warnings};
  const options={timeoutMs:8000,maxAttempts:1};
  try{
    const data=await cf.request('/workers/domains?service='+encodeURIComponent(worker),options);
    if(!Array.isArray(data?.result))throw new Error('incomplete');
    for(const row of data.result){
      // Wrangler's resolved script-name deployments use the default service
      // environment, even when SUBSTRACKER_ENVIRONMENT selected a suffixed name.
      if(row?.service===worker&&(!row.environment||row.environment==='production'))add(hostnameOrigin(row.hostname),'custom-domain');
    }
  }catch(error){warnings.push({code:'ST_URL_DOMAIN_LOOKUP',httpStatus:error.httpStatus||null,message:'Custom Domain 未能自動讀取；未建立、修改或刪除網域。'});}
  if(!candidates.length){
    try{
      const data=await cf.request('/workers/scripts',options);
      if(!Array.isArray(data?.result))throw new Error('incomplete');
      const script=data.result.find(row=>row?.id===worker);
      for(const route of script?.routes||[]){if(!route.script||route.script===worker)add(rootRouteOrigin(route.pattern),'existing-root-route');}
      if(script?.routes?.length&&!candidates.length)warnings.push({code:'ST_URL_ROUTE_AMBIGUOUS',message:'原 Route 不是可唯一推導的 HTTPS 根路由；不猜測 /init 網址。'});
    }catch(error){warnings.push({code:'ST_URL_ROUTE_LOOKUP',httpStatus:error.httpStatus||null,message:'既有 Route 未能自動讀取；原路由保留。'});}
  }
  if(domain.enabled===true){
    try{const result=await cf.request('/workers/subdomain',options);const sub=result?.result?.subdomain;add(hostnameOrigin(worker+'.'+sub+'.workers.dev'),'existing-workers.dev');}
    catch(error){warnings.push({code:'ST_URL_SUBDOMAIN_LOOKUP',httpStatus:error.httpStatus||null,message:'原 workers.dev 網址未能讀取；未開啟新的公開入口。'});}
  }
  return {candidates:candidates.slice(0,6),warnings};
}
/** A failing/old/protected URL is reported as not verified, not code failure.
 * A valid but wrong run ID NEVER satisfies URL verification.
 */
export async function verifyReleaseURL(candidates,plan,{fetchImpl=fetch,pause=async()=>{},now=Date.now,deadline=Date.now()+45000}={}){
  if(!candidates.length)return {status:'not_configured',verified:false,url:null,attempts:[]};
  const attempts=[];
  for(let round=0;round<3;round++){
    for(const item of candidates){
      if(now()+1000>=deadline)return {status:'not_verified',verified:false,url:null,attempts};
      const outcome={url:item.url,source:item.source,round:round+1};
      try{
        const r=await fetchImpl(item.url+'/api/upgrade/status',{method:'GET',redirect:'manual',headers:{'Cache-Control':'no-store'},signal:AbortSignal.timeout(Math.max(1,Math.min(8000,deadline-now())))});
        outcome.httpStatus=r.status;
        if(r.ok){
          // Avoid unbounded response allocation from a wrong user-supplied origin.
          const reader=r.body?.getReader();let text='',size=0;
          if(reader){try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>32768){await reader.cancel();throw new Error('response-too-large');}text+=new TextDecoder().decode(value);}}finally{reader.releaseLock();}}
          let v;try{v=JSON.parse(text);}catch{/* HTML/login/stale sites are not this release. */}
          if(v?.version===plan.version&&v.runId===plan.runId&&v.mode==='deferred-web-init'&&v.codeDeployed===true&&v.phase==='bindings_required'&&v.applicationReady===false){
            attempts.push({...outcome,matched:true});return {status:'verified',verified:true,url:item.url,attempts};
          }
          outcome.reason='not-this-waiting-release';
        }else outcome.reason=[301,302,303,307,308,401,403].includes(r.status)?'redirect-or-access-protected':'http-status';
      }catch{outcome.reason='unreachable-or-invalid-response';}
      attempts.push(outcome);
    }
    if(round<2&&now()+1500<deadline)await pause(1000);
  }
  return {status:'not_verified',verified:false,url:null,attempts};
}
