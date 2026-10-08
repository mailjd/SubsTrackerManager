import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {Cloudflare} from '../../scripts/upgrade/cloudflare.mjs';
export const ACCOUNT='a'.repeat(32),KV='b'.repeat(32),DB='12345678-1234-1234-1234-123456789abc';
export function makeD1({mutate, transform}={}) {
 const db=new DatabaseSync(':memory:'),trace=[];
 const cf=new Cloudflare({accountId:ACCOUNT,token:'test-only-secret',fetchImpl:async (input,opt)=>{
  const url=new URL(input);assert.equal(url.origin,'https://api.cloudflare.com');
  assert.equal(url.pathname,`/client/v4/accounts/${ACCOUNT}/d1/database/${DB}/query`);
  assert.equal(opt.method,'POST');assert.equal(opt.redirect,'error');
  const body=JSON.parse(opt.body);assert.match(body.sql,/^(SELECT|PRAGMA)\b/); // no remote mutation in backup
  trace.push(body);mutate?.(db,body,trace);
  let rows=db.prepare(body.sql).all(...(body.params||[]));
  rows=transform?transform(rows,body,trace):rows;
  return Response.json({success:true,result:[{success:true,results:rows}]});
 }});
 return {db,cf,trace,close:()=>db.close()};
}
export function restore(sql){const db=new DatabaseSync(':memory:');db.exec(sql);assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);return db;}
export function rows(db,sql){const s=db.prepare(sql);s.setReadBigInts(true);return s.all();}
