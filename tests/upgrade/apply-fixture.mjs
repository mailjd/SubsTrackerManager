/** Integration-test-only tool: encrypted restore + real gate on synthetic disk KV/SQLite. No network. */
import fs from 'node:fs';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';
import {dumpSql} from './helpers.mjs';
import {inspectBundle,encryptArchive,decryptArchive,assertOriginalsPreserved} from '../../scripts/upgrade/archive.mjs';
import {handleUpgradeGate} from '../../src/data/upgrade-gate.js';import {sha256} from '../../src/data/upgrade-reconcile.js';
const dir=path.resolve(process.argv[2]),file=path.join(dir,'kv.json');let values=JSON.parse(fs.readFileSync(file,'utf8'));const db=new DatabaseSync(path.join(dir,'d1.sqlite'));
class Statement{constructor(text,args=[]){this.text=text;this.args=args;}bind(...args){return new Statement(this.text,args);}async all(){return {success:true,results:db.prepare(this.text).all(...this.args)};}async first(col){const r=db.prepare(this.text).get(...this.args)||null;return col?r?.[col]??null:r;}async run(){return {success:true,meta:db.prepare(this.text).run(...this.args)};}}
const env={SUBSCRIPTIONS_KV:{async get(k){return values[k]??null;},async put(k,v){values[k]=String(v);fs.writeFileSync(file,JSON.stringify(values));},async list({prefix='',limit=500,cursor='0'}={}){const keys=Object.keys(values).filter(n=>n.startsWith(prefix)).sort(),i=Number(cursor);return {keys:keys.slice(i,i+limit).map(name=>({name})),cursor:i+limit<keys.length?String(i+limit):'',list_complete:i+limit>=keys.length};}},SUBSCRIPTIONS_DB:{prepare:s=>new Statement(s),async batch(stmts){db.exec('BEGIN');try{const r=[];for(const st of stmts)r.push(await st.run());db.exec('COMMIT');return r;}catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}}}};
const bundle=()=>({format:'substracker-full-storage',kv:Object.entries(values).map(([name,v])=>({name,valueBase64:Buffer.from(v).toString('base64')})),d1Sql:dumpSql(db)});
const run={id:'local-fixture-'+crypto.randomUUID(),version:'3.3.20',tokenHash:await sha256('local-test-only')};
const call=async(op,data)=>{const r=await handleUpgradeGate(new Request('https://fixture.invalid/api/upgrade/'+op,{method:'POST',headers:{'X-Upgrade-Token':'local-test-only'},body:JSON.stringify(data)}),env,run);const v=await r.json();if(r.status>=300)throw new Error(JSON.stringify(v));return v;};
try{
 const before=bundle(),a=await inspectBundle(before);const password='synthetic-archive-password-only';const encrypted=encryptArchive(before,password);const decoded=decryptArchive(encrypted,password);const restored=await inspectBundle(decoded);
 assertOriginalsPreserved(before,decoded,a.image,restored.image);
 const applied=await call('apply',{expectedSourceDigest:a.summary.sourceDigest,backupReceipt:{runId:run.id,verified:true,archiveSha256:await sha256(encrypted.toString('base64'))}});
 const after=bundle(),b=await inspectBundle(after);assertOriginalsPreserved(before,after,a.image,b.image);
 const result=await call('commit',{reportDigest:applied.reportDigest,originalsVerified:true,restoreVerified:true});
 fs.writeFileSync(path.join(dir,'upgrade-test-report.json'),JSON.stringify({success:true,...applied.report,originalsVerified:true,restoreVerified:true,ready:result.ready},null,2));console.log(JSON.stringify({success:true,report:applied.report}));
}catch(e){console.error(e);process.exitCode=1;}finally{db.close();}
