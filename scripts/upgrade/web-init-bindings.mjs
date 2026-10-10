/** Canonical identities for a binding-preserving, deferred-web-init release.
 * Metadata only: this module cannot read/write database contents or provision resources.
 */
import {isDeepStrictEqual} from 'node:util';
import {checkedBindingList,d1BindingId} from './worker-bindings.mjs';
import {assertD1KVConfig} from './storage-policy.mjs';
function fail(code,message){const e=new Error(code+'：'+message);e.code=code;throw e;}
export function webInitBindingIdentity(settings){
  return checkedBindingList(settings?.bindings).map(b=>{
    const {name,type}=b;
    if(type==='kv_namespace'){
      if(typeof b.namespace_id!=='string'||!/^[a-f0-9]{32}$/i.test(b.namespace_id)||/^0+$/.test(b.namespace_id))fail('ST_WEB_INIT_KV_ID','原 KV 綁定 '+name+' 缺少有效 Namespace ID；不按本地設定或名稱猜測。');
      return {name,type,namespace_id:b.namespace_id.toLowerCase()};
    }
    if(type==='d1'){
      const id=d1BindingId(b);
      if(!id||/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(id))fail('ST_WEB_INIT_D1_ID','原 D1 綁定 '+name+' 缺少有效 database_id/id；不當作未綁定，不猜測替代庫。');
      return {name,type,database_id:id};
    }
    if(type==='plain_text'){
      if(typeof b.text!=='string')fail('ST_UNBOUND_VARIABLE','原一般變數內容不完整，不發布空值。');
      return {name,type,text:b.text};
    }
    if(type==='json'){
      let value=b.json;
      if(typeof value==='string'){try{value=JSON.parse(value);}catch{fail('ST_UNBOUND_VARIABLE','原 JSON 變數格式無效。');}}
      if(value===undefined||typeof value==='string')fail('ST_UNBOUND_VARIABLE','無法無損保留此 JSON 變數型別，已停止。');
      return {name,type,json:value};
    }
    if(type==='secret_text')return {name,type};
    if(type==='assets'){
      if(name!=='ASSETS')fail('ST_UNBOUND_ASSETS','原靜態資產綁定名稱不是 ASSETS；不改名或移除它。');
      return {name,type};
    }
    fail('ST_UNBOUND_OTHER_BINDING','原 Worker 包含尚未支援的綁定 '+name+'（'+type+'）；停止以免移除或改綁。');
  }).sort((a,b)=>a.name.localeCompare(b.name));
}
export function storageSummary(rows){
  return rows.filter(b=>b.type==='d1'||b.type==='kv_namespace').map(b=>({name:b.name,type:b.type,id:b.namespace_id||b.database_id}));
}
export function requiredBindings(rows){
  const kv=rows.some(b=>b.type==='kv_namespace'&&b.name==='SUBSCRIPTIONS_KV');
  const d1=rows.some(b=>b.type==='d1'&&b.name==='SUBSCRIPTIONS_DB');
  return {kv,d1,missing:[...(!kv?['SUBSCRIPTIONS_KV']:[]),...(!d1?['SUBSCRIPTIONS_DB']:[])]};
}
export function preservedStorageConfig(rows){
  return {
    kv_namespaces:rows.filter(b=>b.type==='kv_namespace').map(b=>({binding:b.name,id:b.namespace_id})),
    // Wrangler binds by database_id. Use that exact ID as the non-authoritative label,
    // so no account-wide database lookup or database creation is necessary.
    d1_databases:rows.filter(b=>b.type==='d1').map(b=>({binding:b.name,database_id:b.database_id,database_name:b.database_id}))
  };
}
export function assertPreservedStorage(config,rows){
  const expected=preservedStorageConfig(webInitBindingIdentity({bindings:rows}));
  if(!isDeepStrictEqual(config.kv_namespaces,expected.kv_namespaces)||!isDeepStrictEqual(config.d1_databases,expected.d1_databases))fail('ST_UNBOUND_GUARD','待發布的 D1/KV 名稱或 ID 與核對後的原綁定不符；不允許移除、替換或自動建立。');
}

/** Reject local binding injectors rather than provisioning an unreviewed resource. */
export function assertWebInitLocalBindings(config){
  assertD1KVConfig(config);
  for(const key of ['unsafe','site','send_email','browser','ai','images','version_metadata','wasm_modules','text_blobs','data_blobs','mtls_certificates','logfwdr']){
    const value=config[key];
    const present=Array.isArray(value)?value.length>0:value&&typeof value==='object'?Object.keys(value).length>0:!!value;
    if(present)fail('ST_UNBOUND_LOCAL_BINDINGS','本地 '+key+' 可注入未核對綁定；停止以免改變現行資源。');
  }
}
