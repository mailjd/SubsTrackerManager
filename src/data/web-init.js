/** Authenticated, resumable upgrade for the no-storage deployment path.
 * GETs never initialize storage. Existing KV business keys/config/secrets and D1
 * business rows are never replaced. Only missing schema, immutable ledger rows,
 * and release-scoped control/receipt records are added. No cross-store transaction
 * is claimed: KV visibility is explicitly verified before the D1 completion flag.
 */
import {WEB_INIT_MODE,WEB_INIT_TABLE,WEB_INIT_PREFIX,WEB_INIT_FORMAT} from './web-init-protocol.js';
import {inspectWebSchema} from './web-init-schema.js';
import {collectSubscriptionInventory,stableJSON,sha256,hasTable} from './upgrade-reconcile.js';
import {planLedgerUpgrade,readRawLedgerEntries,LEDGER_UPGRADE_MARKER} from './subscription-ledger.js';
import {verifySuperAdminPassword,verifyRuntimeSuperAdminCredentials} from '../core/superadmin.js';
import {renderWebInitPage} from '../views/web-init-page.js';
export {WEB_INIT_MODE};
const TABLE=WEB_INIT_TABLE,MAX_STATE_BYTES=900000,STEP_SIZE=8;
const attempts=new Map(); // Best-effort isolate throttling, NOT a global rate limit.
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
function fail(code,message,status=409){const e=new Error(message);e.code=code;e.status=status;throw e;}
function validRun(run){if(run?.mode!==WEB_INIT_MODE||typeof run.id!=='string'||!/^[a-zA-Z0-9_.-]{1,120}$/.test(run.id)||typeof run.version!=='string')fail('INIT_RUN_INVALID','發布識別不完整，不能開啟 init。',503);}
function bindingState(env){return {kv:!!env?.SUBSCRIPTIONS_KV&&typeof env.SUBSCRIPTIONS_KV.get==='function'&&typeof env.SUBSCRIPTIONS_KV.list==='function'&&typeof env.SUBSCRIPTIONS_KV.put==='function',d1:!!env?.SUBSCRIPTIONS_DB&&typeof env.SUBSCRIPTIONS_DB.prepare==='function'&&typeof env.SUBSCRIPTIONS_DB.batch==='function'};}
function requireBindings(env){const b=bindingState(env);if(!b.kv||!b.d1)fail('INIT_BINDINGS_REQUIRED','請綁回原 SUBSCRIPTIONS_KV 與 SUBSCRIPTIONS_DB，並儲存及部署綁定變更。',503);}
function sessionEnv(env){if(typeof env?.SUBSCRIPTIONS_DB?.withSession==='function')return {...env,SUBSCRIPTIONS_DB:env.SUBSCRIPTIONS_DB.withSession('first-primary')};return env;}
function authConfig(env){return {configured:typeof env?.SUBSTRACKER_SUPERADMIN_PASSWORD==='string'&&!!env.SUBSTRACKER_SUPERADMIN_PASSWORD,usernameRequired:typeof env?.SUBSTRACKER_SUPERADMIN_USERNAME==='string'&&!!env.SUBSTRACKER_SUPERADMIN_USERNAME.trim()};}
async function authenticate(request,env,run,body){
  if(!authConfig(env).configured)fail('INIT_AUTH_NOT_CONFIGURED','請在 Worker 的執行時 Variables and Secrets 設定 SUBSTRACKER_SUPERADMIN_PASSWORD；不是 Builds 的機密。',503);
  const ip=(request.headers.get('CF-Connecting-IP')||'unknown')+':'+run.id;
  const entry=attempts.get(ip),now=Date.now();
  if(entry&&entry.until>now&&entry.failures>=5)fail('INIT_RATE_LIMIT','登入失敗次數過多，請稍後再試。',429);
  const valid=authConfig(env).usernameRequired?await verifyRuntimeSuperAdminCredentials(env,body.username,body.password):await verifySuperAdminPassword(body.password,env);
  if(!valid){if(attempts.size>=1024)attempts.delete(attempts.keys().next().value);attempts.set(ip,{failures:entry?.until>now?entry.failures+1:1,until:entry?.until>now?entry.until:now+60000});fail('INIT_UNAUTHORIZED','SuperAdmin 憑證無效。',403);}
  attempts.delete(ip);
}
async function readBody(request){
  const url=new URL(request.url);
  if(request.headers.get('Origin')!==url.origin||request.headers.get('X-SubsTracker-Init')!=='1'||!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type')||''))fail('INIT_REQUEST_REJECTED','僅接受同源 init 頁面發出的 JSON 請求。',403);
  if(Number(request.headers.get('Content-Length')||0)>16384)fail('INIT_BODY_TOO_LARGE','請求過大。',413);
  // Stream limit also covers chunked requests; don't allocate an unbounded body.
  const reader=request.body?.getReader();if(!reader)fail('INIT_BODY_INVALID','缺少請求內容。',400);
  const chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>16384){await reader.cancel();fail('INIT_BODY_TOO_LARGE','請求過大。',413);}chunks.push(value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}
  let body;try{body=JSON.parse(new TextDecoder().decode(bytes));}catch{fail('INIT_BODY_INVALID','JSON 格式無效。',400);}
  if(!body||typeof body!=='object'||Array.isArray(body))fail('INIT_BODY_INVALID','請求格式無效。',400);
  return body;
}
async function originalConfig(env){
  const [schema,raw]=await Promise.all([env.SUBSCRIPTIONS_KV.get('schema_version'),env.SUBSCRIPTIONS_KV.get('config')]);
  if(schema!=='v3')fail('INIT_KV_SCHEMA','原 KV 不是 v3 結構。這是既有 v3.3.29+ 升級入口，不是空庫首次安裝；未建立預設帳戶或清空資料。');
  let config;try{config=JSON.parse(raw||'null');}catch{fail('INIT_CONFIG_INVALID','原 config JSON 損壞；不以空設定覆蓋。');}
  if(!config||typeof config.JWT_SECRET!=='string'||!config.JWT_SECRET||typeof config.CREDENTIALS_ENCRYPTION_KEY!=='string'||!config.CREDENTIALS_ENCRYPTION_KEY)fail('INIT_ORIGINAL_KEYS_REQUIRED','原 JWT 或憑據加密密鑰缺失；請確認綁回正確的 KV，不會生成替代密鑰。');
  return {hash:await sha256(raw),keyHash:await sha256([config.JWT_SECRET,config.CREDENTIALS_ENCRYPTION_KEY])};
}
async function readJob(env,run){
  if(!await hasTable(env,TABLE))return null;
  const row=await env.SUBSCRIPTIONS_DB.prepare('SELECT phase,revision,data_json FROM '+TABLE+' WHERE run_id=?').bind(run.id).first();
  if(!row)return null;
  let data;try{data=JSON.parse(row.data_json);}catch{fail('INIT_STATE_CORRUPT','init 檢查點損壞；沒有覆蓋原紀錄。');}
  if(data?.format!==WEB_INIT_FORMAT||data.runId!==run.id||data.version!==run.version||!['schema','ledger','checkpoint','verify_kv','complete'].includes(row.phase))fail('INIT_STATE_CORRUPT','init 檢查點與本版不符。');
  return {phase:row.phase,revision:Number(row.revision),data};
}
function summary(job){return job?{phase:job.phase,startedAt:job.data.startedAt,counts:job.data.counts,progress:job.data.progress||null,report:job.phase==='complete'?job.data.report:null}:null;}
function receiptKey(run){return WEB_INIT_PREFIX+run.id+':complete';}
/** No permanent readiness cache: replacing a binding cannot reuse another DB's approval. */
export async function webInitReady(env,run){
  try{
    validRun(run);requireBindings(env);env=sessionEnv(env);
    if(!await hasTable(env,TABLE))return false;
    // Normal traffic must not fetch the potentially large migration manifest.
    const row=await env.SUBSCRIPTIONS_DB.prepare("SELECT phase,json_extract(data_json,'$.format') AS format,json_extract(data_json,'$.version') AS version,json_extract(data_json,'$.runId') AS run_id,json_extract(data_json,'$.keyHash') AS key_hash,json_extract(data_json,'$.receipt') AS receipt FROM "+TABLE+" WHERE run_id=?").bind(run.id).first();
    if(row?.phase!=='complete'||row.format!==WEB_INIT_FORMAT||row.version!==run.version||row.run_id!==run.id||typeof row.receipt!=='string')return false;
    const config=await originalConfig(env);if(config.keyHash!==row.key_hash)return false;
    return await env.SUBSCRIPTIONS_KV.get(receiptKey(run))===row.receipt;
  }catch{return false;}
}
export async function inspectWebInit(env,run){
  validRun(run);requireBindings(env);
  const config=await originalConfig(env),schema=await inspectWebSchema(env.SUBSCRIPTIONS_DB);
  const inventory=await collectSubscriptionInventory(env),ledger=await planLedgerUpgrade(env,inventory);
  if(await hasTable(env,'schema_meta')){
    const old=await env.SUBSCRIPTIONS_DB.prepare('SELECT value FROM schema_meta WHERE key=?').bind(LEDGER_UPGRADE_MARKER).first();
    if(old){let marker;try{marker=JSON.parse(old.value);}catch{fail('INIT_OLD_MARKER_INVALID','原歷史標記損壞；不覆蓋。');}if(marker?.verified!==true)fail('INIT_OLD_MARKER_INVALID','原歷史標記未驗證；不強制改成成功。');}
  }
  const expectedDigest=await sha256({runId:run.id,config:config.hash,source:inventory.sourceDigest,schema:schema.signature,changes:schema.sql,existing:ledger.existingDigest});
  return {config,schema,inventory,ledger,expectedDigest};
}
async function assertOriginals(env,job){
  const config=await originalConfig(env);
  if(config.hash!==job.data.configHash)fail('INIT_CONFIG_CHANGED','init 期間原設定改變，已停止；不會覆蓋或重設密鑰。');
  const inventory=await collectSubscriptionInventory(env);
  if(inventory.sourceDigest!==job.data.sourceDigest)fail('INIT_SOURCE_CHANGED','原訂閱資料在 init 期間改變；保留雙方資料並停止，不能以舊檢查點繼續。');
  const ledger=await readRawLedgerEntries(env),byId=new Map(ledger.map(e=>[e.id,e]));
  for(const [id,hash] of job.data.originalLedgerHashes)if(!byId.has(id)||await sha256(byId.get(id))!==hash)fail('INIT_LEDGER_CHANGED','原歷史紀錄改變，未標記完成。');
  return {inventory,ledger};
}
async function updateJob(env,run,job,phase,data,additional=[]){
  const text=stableJSON(data);if(new TextEncoder().encode(text).length>MAX_STATE_BYTES)fail('INIT_STATE_LIMIT','驗證資料超過單筆檢查點的安全上限；未寫入該批次。');
  const statement=env.SUBSCRIPTIONS_DB.prepare('UPDATE '+TABLE+' SET phase=?,data_json=?,revision=revision+1,updated_at=? WHERE run_id=? AND revision=?').bind(phase,text,new Date().toISOString(),run.id,job.revision);
  const results=await env.SUBSCRIPTIONS_DB.batch([...additional,statement]);
  if(results.some(r=>r.success===false))fail('INIT_WRITE_FAILED','D1 批次未成功，尚未標記完成。');
  if(Number(results.at(-1)?.meta?.changes)!==1){
    // All additions are insert-only and deterministic. A concurrent retry may win
    // the checkpoint CAS; it cannot replace a business record or move phase back.
    const current=await readJob(env,run);if(!current)fail('INIT_STATE_CHANGED','init 檢查點遺失。');return current;
  }
  return {phase,revision:job.revision+1,data};
}
async function start(env,run,body){
  if(body.confirmOriginalBindings!==true||body.confirmBackup!==true)fail('INIT_CONFIRM_REQUIRED','請確認已綁回原資源，並已獨立備份原 D1/KV。',400);
  const existing=await readJob(env,run);
  if(existing){if(existing.phase!=='complete')await assertOriginals(env,existing);return existing;}
  const plan=await inspectWebInit(env,run);
  if(body.expectedDigest!==plan.expectedDigest)fail('INIT_PREVIEW_CHANGED','資料或結構與檢查頁不同，請重新檢查後再執行。');
  const startedAt=new Date().toISOString();
  const data={format:WEB_INIT_FORMAT,runId:run.id,version:run.version,startedAt,nonce:crypto.randomUUID(),configHash:plan.config.hash,keyHash:plan.config.keyHash,sourceDigest:plan.inventory.sourceDigest,counts:plan.inventory.counts,
    originalLedgerHashes:await Promise.all(plan.ledger.existing.map(async e=>[e.id,await sha256(e)])),originalLedgerCount:plan.ledger.existing.length,progress:{written:0,remaining:null},backup:'operator-confirmed-external; not-created-by-code-deploy'};
  const raw=stableJSON(data);if(new TextEncoder().encode(raw).length>MAX_STATE_BYTES)fail('INIT_STATE_LIMIT','原历史數量超出單筆檢查點安全上限，未開始寫入。');
  // Authentication, confirmation, complete preflight and preview-digest comparison
  // have all passed before the FIRST write (even this control table CREATE).
  await env.SUBSCRIPTIONS_DB.prepare('CREATE TABLE IF NOT EXISTS '+TABLE+' (run_id TEXT PRIMARY KEY,phase TEXT NOT NULL,data_json TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL)').run();
  await env.SUBSCRIPTIONS_DB.prepare('INSERT INTO '+TABLE+' (run_id,phase,data_json,revision,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(run_id) DO NOTHING').bind(run.id,'schema',raw,0,startedAt).run();
  const saved=await readJob(env,run);if(!saved||saved.data.sourceDigest!==data.sourceDigest||saved.data.configHash!==data.configHash)fail('INIT_STATE_CHANGED','同一發布的檢查點已不同，未覆蓋。');
  return saved;
}
async function step(env,run){
  let job=await readJob(env,run);if(!job)fail('INIT_NOT_STARTED','請先檢查資料並確認執行 init。');
  if(job.phase==='complete')return {job,ready:await webInitReady(env,run)};
  const before=await assertOriginals(env,job);
  if(job.phase==='schema'){
    const plan=await inspectWebSchema(env.SUBSCRIPTIONS_DB),sql=plan.sql.slice(0,STEP_SIZE);
    const phase=plan.sql.length>sql.length?'schema':'ledger';
    const data={...job.data,progress:{stage:'schema',written:(job.data.progress?.stage==='schema'?job.data.progress.written:0)+sql.length,remaining:plan.sql.length-sql.length}};
    // Each batch is atomic. A duplicate ALTER from a concurrent request fails
    // without removing any table; reload/retry re-inspects the current schema.
    job=await updateJob(env,run,job,phase,data,sql.map(s=>env.SUBSCRIPTIONS_DB.prepare(s)));
    return {job,ready:false};
  }
  if(job.phase==='ledger'){
    const plan=await planLedgerUpgrade(env,before.inventory);
    const rows=await env.SUBSCRIPTIONS_DB.prepare('SELECT entry_id FROM subscription_ledger').all();
    if(rows.success===false||!Array.isArray(rows.results))fail('INIT_LEDGER_READ','歷史索引讀取不完整。');
    const ids=new Set(rows.results.map(r=>r.entry_id));
    const candidates=[...plan.existing,...plan.additions.map(e=>({...e,createdAt:job.data.startedAt}))].filter(e=>!ids.has(e.id));
    const pending=candidates.slice(0,STEP_SIZE);
    const sql=pending.map(e=>env.SUBSCRIPTIONS_DB.prepare('INSERT INTO subscription_ledger(entry_id,subscription_id,source,occurred_at,created_at,snapshot_json,input_hash) VALUES(?,?,?,?,?,?,?) ON CONFLICT(entry_id) DO NOTHING').bind(e.id,e.subscriptionId,e.source,e.occurredAt,e.createdAt,JSON.stringify(e.snapshot),e.inputHash||''));
    if(sql.length){
      const results=await env.SUBSCRIPTIONS_DB.batch(sql);if(results.some(r=>r.success===false))fail('INIT_LEDGER_WRITE','歷史批次寫入失敗。');
      const saved=new Map((await readRawLedgerEntries(env)).map(e=>[e.id,e]));
      for(const e of pending)if(stableJSON(saved.get(e.id))!==stableJSON(e))fail('INIT_LEDGER_VERIFY','新增歷史回讀不符，尚未標記完成。');
    }
    const after=await assertOriginals(env,job);
    const remaining=candidates.length-pending.length;
    const report={version:run.version,runId:run.id,verified:true,counts:after.inventory.counts,sourceDigest:job.data.sourceDigest,ledgerCount:after.ledger.length,ledgerDigest:await sha256(after.ledger),retained:job.data.originalLedgerCount,added:after.ledger.length-job.data.originalLedgerCount,originalConfigPreserved:true,originalSubscriptionsPreserved:true,completedAt:job.data.startedAt};
    const phase=remaining?'ledger':'checkpoint';
    const receipt={format:WEB_INIT_FORMAT,runId:run.id,version:run.version,nonce:job.data.nonce,sourceDigest:job.data.sourceDigest,keyHash:job.data.keyHash};
    job=await updateJob(env,run,job,phase,{...job.data,progress:{stage:'ledger',written:(job.data.progress?.stage==='ledger'?job.data.progress.written:0)+pending.length,remaining},...(remaining?{}:{report,receipt})});
    return {job,ready:false};
  }
  if(job.phase==='checkpoint'){
    // Separate release-scoped key, never 'config', 'schema_version', sub:* or a
    // previous completed release. Retries write the exact same immutable value.
    const expected=stableJSON(job.data.receipt),old=await env.SUBSCRIPTIONS_KV.get(receiptKey(run));
    if(old!==null&&old!==expected)fail('INIT_KV_RECEIPT_CONFLICT','本次 KV 收據已有不同內容；不覆蓋。');
    if(old===null)await env.SUBSCRIPTIONS_KV.put(receiptKey(run),expected);
    job=await updateJob(env,run,job,'verify_kv',job.data);return {job,ready:false,retryAfterSeconds:5};
  }
  if(job.phase==='verify_kv'){
    if((await inspectWebSchema(env.SUBSCRIPTIONS_DB)).sql.length)fail('INIT_SCHEMA_INCOMPLETE','驗收時資料結構仍有缺項；未開放網站。');
    const value=await env.SUBSCRIPTIONS_KV.get(receiptKey(run));
    if(value===null)return {job,ready:false,retryAfterSeconds:5};
    if(value!==stableJSON(job.data.receipt))fail('INIT_KV_RECEIPT_CONFLICT','KV 收據不符，尚未開放網站。');
    if(await sha256(before.ledger)!==job.data.report.ledgerDigest)fail('INIT_LEDGER_CHANGED','验收時歷史內容改變，尚未標記完成。');
    const old=await env.SUBSCRIPTIONS_DB.prepare('SELECT value FROM schema_meta WHERE key=?').bind(LEDGER_UPGRADE_MARKER).first();
    if(old){let marker;try{marker=JSON.parse(old.value);}catch{fail('INIT_OLD_MARKER_INVALID','原歷史標記損壞；不覆蓋。');}if(marker?.verified!==true)fail('INIT_OLD_MARKER_INVALID','原歷史標記未驗證；不強制改成成功。');}
    const completedAt=new Date().toISOString();
    const completedData={...job.data,report:{...job.data.report,completedAt}};
    const sql=old?[]:[env.SUBSCRIPTIONS_DB.prepare('INSERT INTO schema_meta(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING').bind(LEDGER_UPGRADE_MARKER,JSON.stringify(completedData.report),completedAt)];
    job=await updateJob(env,run,job,'complete',completedData,sql);
    const ready=await webInitReady(env,run);
    return {job,ready,...(!ready?{retryAfterSeconds:5}:{})};
  }
  fail('INIT_STATE_INVALID','不支援的 init 階段。');
}
async function publicStatus(env,run){
  const bindings=bindingState(env),base={success:true,version:run.version,runId:run.id,mode:WEB_INIT_MODE,codeDeployed:true,applicationReady:false,maintenance:true,bindings,initURL:'/init',auth:authConfig(env)};
  if(!bindings.kv||!bindings.d1)return {...base,phase:'bindings_required'};
  try{
    const row=await hasTable(env,TABLE)?await env.SUBSCRIPTIONS_DB.prepare('SELECT phase FROM '+TABLE+' WHERE run_id=?').bind(run.id).first():null;
    const ready=row?.phase==='complete'&&await webInitReady(env,run);
    return {...base,phase:ready?'ready':row?.phase==='complete'?'receipt_pending':row?.phase||'init_required',applicationReady:!!ready,maintenance:!ready};
  }catch{return {...base,phase:'storage_unavailable'};}
}
export async function handleWebInitGate(request,env,run){
  const path=new URL(request.url).pathname;
  try{
    validRun(run);env=sessionEnv(env);
    if((path==='/api/init/status'||path==='/api/upgrade/status')&&request.method==='GET')return json(await publicStatus(env,run));
    if(path==='/init'||path==='/init/'){
      if(request.method!=='GET')return json({success:false,code:'INIT_METHOD',message:'請由 /init 頁面的按鈕執行。'},405);
      return renderWebInitPage(run.version);
    }
    if(path.startsWith('/api/init/')){
      if(request.method!=='POST')return json({success:false,code:'INIT_METHOD',message:'此操作只允許 POST。'},405);
      if(!['/api/init/preview','/api/init/start','/api/init/step','/api/init/report'].includes(path))return json({success:false,code:'INIT_NOT_FOUND'},404);
      const body=await readBody(request);await authenticate(request,env,run,body);requireBindings(env);
      if(path==='/api/init/report'){const job=await readJob(env,run);return json({success:true,version:run.version,runId:run.id,...summary(job),applicationReady:await webInitReady(env,run)});}
      if(path==='/api/init/preview'){
        const existing=await readJob(env,run);
        if(existing)return json({success:true,resume:true,expectedDigest:null,...summary(existing),applicationReady:await webInitReady(env,run)});
        const plan=await inspectWebInit(env,run);
        return json({success:true,resume:false,expectedDigest:plan.expectedDigest,counts:plan.inventory.counts,existingLedger:plan.ledger.existing.length,missingLegacyLedger:plan.ledger.additions.length,schemaChanges:plan.schema.changes,configFingerprint:plan.config.keyHash.slice(0,16),sourceDigest:plan.inventory.sourceDigest,resourceIdentity:'Operator must verify original Cloudflare resource IDs; Worker binding API does not prove prior identity.'});
      }
      if(path==='/api/init/start'){const job=await start(env,run,body);return json({success:true,...summary(job),applicationReady:await webInitReady(env,run)});}
      const result=await step(env,run);
      return json({success:true,...summary(result.job),applicationReady:result.ready,maintenance:!result.ready,...(result.retryAfterSeconds?{retryAfterSeconds:result.retryAfterSeconds}:{}),...(result.ready?{code:'ST_WEB_INIT_COMPLETE'}:{})});
    }
    if(path.startsWith('/api/upgrade/'))return json({success:false,code:'INIT_WEB_ONLY',message:'本版使用 /init，不接收舊分段遷移命令。'},409);
    if(await webInitReady(env,run))return null;
    if(path.startsWith('/api/'))return json({success:false,code:'INIT_REQUIRED',message:'尚未綁齊原 D1/KV 或尚未完成 init；業務資料操作暫停。',initURL:'/init'},503);
    return renderWebInitPage(run.version);
  }catch(error){
    // No raw SQL, source record, password or internal exception stack in responses.
    const known=/^(INIT_|UPGRADE_CONFLICT)/.test(error?.code||'');
    return json({success:false,code:known?error.code:'INIT_OPERATION_FAILED',message:known?error.message:'儲存讀寫或結構驗證未完成；原資料未清空，請檢查綁定或稍後由同一 init 頁面重試。',maintenance:true},error?.status||409);
  }
}
