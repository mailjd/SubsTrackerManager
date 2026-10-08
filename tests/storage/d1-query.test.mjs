import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshotD1WithQueries} from '../../scripts/upgrade/d1-query-snapshot.mjs';
import {makeD1,DB,restore,rows} from './helpers.mjs';

async function roundtrip(schema,verify,options={}){const x=makeD1();let out;try{x.db.exec(schema);const sql=await snapshotD1WithQueries(x.cf,DB,options);out=restore(sql);await verify(x.db,out,x.trace,sql);}finally{out?.close();x.close();}}

test('empty D1 returns valid logical SQL (application schema gate remains separate)',async()=>roundtrip('',(a,b)=>assert.equal(b.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get().n,0)));
test('data pages never call export API or any object URL and round-trip every row',async()=>{
 const x=makeD1();let out;try{x.db.exec('CREATE TABLE sample(id TEXT PRIMARY KEY,data TEXT)');const insert=x.db.prepare('INSERT INTO sample VALUES(?,?)');for(let i=0;i<137;i++)insert.run('r'+i,'data-'+i);out=restore(await snapshotD1WithQueries(x.cf,DB,{pageSize:7}));assert.deepEqual(rows(out,'SELECT * FROM sample ORDER BY id'),rows(x.db,'SELECT * FROM sample ORDER BY id'));const pages=x.trace.filter(t=>t.sql.includes(' AS st_insert'));assert.equal(pages.length,20);assert.ok(pages.every(t=>!t.sql.includes('OFFSET')));assert.ok(pages.slice(1).every(t=>t.sql.includes('>CAST(? AS INTEGER)')));}finally{out?.close();x.close();}
});
test('Unicode / apostrophe / newlines / NUL TEXT bytes preserved',async()=>{
 const x=makeD1();let out;try{x.db.exec('CREATE TABLE sample(value TEXT)');x.db.prepare('INSERT INTO sample VALUES(?)').run("中文🙂'\"\\\n\0尾端");out=restore(await x.cf.exportSQL(DB));assert.deepEqual(rows(x.db,'SELECT typeof(value),hex(value) FROM sample'),rows(out,'SELECT typeof(value),hex(value) FROM sample'));}finally{out?.close();x.close();}
});
test('NULL, empty text, empty BLOB and binary are distinct after restore',async()=>roundtrip("CREATE TABLE sample(v);INSERT INTO sample VALUES(NULL),(''),(X''),(X'00FF7F80');",(a,b)=>assert.deepEqual(rows(a,'SELECT typeof(v),hex(v) FROM sample'),rows(b,'SELECT typeof(v),hex(v) FROM sample'))));
test('int64 extremes pass as SQL text without JSON number rounding',async()=>roundtrip('CREATE TABLE sample(v INTEGER);INSERT INTO sample VALUES(9223372036854775807),(-9223372036854775808),(9007199254740993);',(a,b)=>assert.deepEqual(rows(a,'SELECT v FROM sample'),rows(b,'SELECT v FROM sample'))));
test('finite and infinite REAL values preserve numeric values',async()=>roundtrip('CREATE TABLE sample(v REAL);INSERT INTO sample VALUES(0.1),(1.2345678901234567),(5e-324),(-1.7976931348623157e308),(9.0e999),(-9.0e999),(1.0);',(a,b)=>assert.deepEqual(rows(a,'SELECT typeof(v),v FROM sample'),rows(b,'SELECT typeof(v),v FROM sample'))));
test('implicit rowid gaps and duplicate business rows preserved',async()=>roundtrip("CREATE TABLE sample(v TEXT);INSERT INTO sample(rowid,v) VALUES(-7,'dup'),(15,'dup'),(999,'third');",(a,b)=>assert.deepEqual(rows(a,'SELECT rowid,v FROM sample'),rows(b,'SELECT rowid,v FROM sample'))));
test('AUTOINCREMENT high-water value survives deleted highest row',async()=>roundtrip("CREATE TABLE sample(id INTEGER PRIMARY KEY AUTOINCREMENT,v TEXT);INSERT INTO sample(id,v) VALUES(500,'gone');DELETE FROM sample;",(a,b)=>{assert.deepEqual(rows(a,'SELECT * FROM sqlite_sequence'),rows(b,'SELECT * FROM sqlite_sequence'));a.exec("INSERT INTO sample(v) VALUES('new')");b.exec("INSERT INTO sample(v) VALUES('new')");assert.deepEqual(rows(a,'SELECT * FROM sample'),rows(b,'SELECT * FROM sample'));}));
test('WITHOUT ROWID composite/collated primary key is ordered and preserved',async()=>roundtrip("CREATE TABLE sample(a TEXT COLLATE NOCASE,b INTEGER,c BLOB,PRIMARY KEY(a,b)) WITHOUT ROWID;INSERT INTO sample VALUES('b',3,X'FF'),('A',2,X'00'),('a',1,X'0102');",(a,b)=>assert.deepEqual(rows(a,'SELECT * FROM sample ORDER BY a,b'),rows(b,'SELECT * FROM sample ORDER BY a,b')),{pageSize:1}));
test('STORED and VIRTUAL generated columns restored from table definition',async()=>roundtrip('CREATE TABLE sample(a INTEGER,b INTEGER GENERATED ALWAYS AS(a*2) STORED,c AS(a+1) VIRTUAL);INSERT INTO sample(a) VALUES(4),(9);',(a,b)=>assert.deepEqual(rows(a,'SELECT * FROM sample'),rows(b,'SELECT * FROM sample'))));
test('trigger creation after inserts does not duplicate audit rows; trigger still works',async()=>roundtrip("CREATE TABLE sample(v);CREATE TABLE audit(v);CREATE TRIGGER sample_a AFTER INSERT ON sample BEGIN INSERT INTO audit VALUES(new.v);END;INSERT INTO sample VALUES('first');",(a,b)=>{assert.deepEqual(rows(a,'SELECT * FROM audit'),rows(b,'SELECT * FROM audit'));b.exec("INSERT INTO sample VALUES('second')");assert.equal(b.prepare('SELECT COUNT(*) AS n FROM audit').get().n,2);}));
test('indexes/views/constraints retained and external system table not queried',async()=>roundtrip("CREATE TABLE _cf_KV(k,v);INSERT INTO _cf_KV VALUES('managed','secret');CREATE TABLE sample(id INTEGER PRIMARY KEY,v TEXT UNIQUE);CREATE INDEX ix_sample ON sample(v) WHERE v IS NOT NULL;CREATE VIEW show_sample AS SELECT * FROM sample;INSERT INTO sample VALUES(7,'real');",(a,b,trace)=>{assert.equal(b.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='_cf_KV'").get().n,0);assert.equal(b.prepare('SELECT v FROM show_sample').get().v,'real');assert.ok(!trace.some(t=>t.sql.includes('FROM "_cf_KV"')));assert.throws(()=>b.exec("INSERT INTO sample VALUES(8,'real')"));}));
test('quoted SQL identifiers do not break schema/row serialization',async()=>roundtrip('CREATE TABLE "weird\" table"("a\"b" TEXT);INSERT INTO "weird\" table" VALUES(\'quoted\');'.replaceAll('weird" table','weird"" table').replaceAll('"a"b"','"a""b"'),(a,b)=>assert.deepEqual(rows(a,'SELECT * FROM "weird"" table"'),rows(b,'SELECT * FROM "weird"" table"'))));
test('large TEXT uses bounded chunks including NUL and multibyte characters',async()=>{
 const x=makeD1();let out;try{x.db.exec('CREATE TABLE sample(id INTEGER PRIMARY KEY,v TEXT)');x.db.prepare('INSERT INTO sample VALUES(?,?)').run(41,'中文\0🙂'.repeat(20000));out=restore(await x.cf.exportSQL(DB));assert.deepEqual(rows(x.db,'SELECT hex(v),length(CAST(v AS BLOB)) FROM sample'),rows(out,'SELECT hex(v),length(CAST(v AS BLOB)) FROM sample'));assert.ok(x.trace.filter(t=>t.sql.includes(' AS chunk')).length>2);}finally{out?.close();x.close();}
});
test('large binary uses chunks and exact BLOB type, not UTF-8 replacement',async()=>{
 const x=makeD1();let out;try{x.db.exec('CREATE TABLE sample(id INTEGER PRIMARY KEY,v BLOB)');const bytes=Buffer.alloc(900001);for(let i=0;i<bytes.length;i++)bytes[i]=i%256;x.db.prepare('INSERT INTO sample VALUES(?,?)').run(9,bytes);out=restore(await x.cf.exportSQL(DB));assert.deepEqual(Buffer.from(out.prepare('SELECT v FROM sample').get().v),bytes);assert.equal(out.prepare('SELECT typeof(v) AS t FROM sample').get().t,'blob');}finally{out?.close();x.close();}
});
test('large WITHOUT ROWID record retains composite identity',async()=>{
 const x=makeD1();let out;try{x.db.exec('CREATE TABLE sample(a TEXT,b INTEGER,v TEXT,PRIMARY KEY(a,b)) WITHOUT ROWID');x.db.prepare('INSERT INTO sample VALUES(?,?,?)').run('key',2,'x'.repeat(70000));out=restore(await x.cf.exportSQL(DB));assert.deepEqual(rows(x.db,'SELECT * FROM sample'),rows(out,'SELECT * FROM sample'));}finally{out?.close();x.close();}
});
test('missing page entries fail instead of being accepted as complete',async()=>{
 const x=makeD1({transform:(r,q)=>q.sql.includes(' AS st_insert')?r.slice(1):r});try{x.db.exec('CREATE TABLE sample(v);INSERT INTO sample VALUES(1),(2)');await assert.rejects(x.cf.exportSQL(DB),/ST_D1_SNAPSHOT_CHANGED/);}finally{x.close();}
});
test('repeating pages fail monotonic rowid verification',async()=>{
 let first;const x=makeD1({transform:(r,q)=>{if(q.sql.includes(' AS st_insert')){first??=r;return first;}return r;}});try{x.db.exec('CREATE TABLE sample(v);INSERT INTO sample VALUES(1),(2)');await assert.rejects(snapshotD1WithQueries(x.cf,DB,{pageSize:1}),/分頁重複/);}finally{x.close();}
});
test('schema change during scan fails and returns no archive',async()=>{
 let n=0;const x=makeD1({mutate:(db,q)=>{if(q.sql.startsWith('SELECT type,name')&&++n===2)db.exec('CREATE TABLE late(v)');}});try{x.db.exec('CREATE TABLE sample(v)');await assert.rejects(x.cf.exportSQL(DB),/結構變更/);}finally{x.close();}
});
test('row count changes during scan fail',async()=>{
 let n=0;const x=makeD1({mutate:(db,q)=>{if(q.sql.startsWith('SELECT CAST(COUNT')&&++n===2)db.exec('INSERT INTO sample VALUES(2)');}});try{x.db.exec('CREATE TABLE sample(v);INSERT INTO sample VALUES(1)');await assert.rejects(x.cf.exportSQL(DB),/筆數變更/);}finally{x.close();}
});
test('unsupported virtual/shadow tables rejected before returning partial backup',async()=>{
 const x=makeD1({transform:(r,q)=>q.sql==='PRAGMA table_list'?r.map(i=>i.name==='sample'?{...i,type:'virtual'}:i):r});try{x.db.exec('CREATE TABLE sample(v)');await assert.rejects(x.cf.exportSQL(DB),/ST_D1_SCHEMA_UNSUPPORTED/);assert.ok(!x.trace.some(q=>q.sql.includes(' AS st_insert')));}finally{x.close();}
});
test('incomplete xinfo refused, generated/hidden columns never silently omitted',async()=>{
 const x=makeD1({transform:(r,q)=>q.sql.startsWith('PRAGMA table_xinfo')?[]:r});try{x.db.exec('CREATE TABLE sample(v)');await assert.rejects(x.cf.exportSQL(DB),/欄位結構/);}finally{x.close();}
});
test('damaged large cell chunk fails before it can reach encryption',async()=>{
 const x=makeD1({transform:(r,q)=>q.sql.includes(' AS chunk')?r.map(i=>({...i,chunk:i.chunk.slice(2)})):r});try{x.db.exec('CREATE TABLE sample(v TEXT)');x.db.prepare('INSERT INTO sample VALUES(?)').run('v'.repeat(60000));await assert.rejects(x.cf.exportSQL(DB),/分片不完整/);}finally{x.close();}
});
test('backup size budget fails closed without changing storage backend',async()=>{
 const x=makeD1();try{x.db.exec('CREATE TABLE sample(v);INSERT INTO sample VALUES(1)');await assert.rejects(snapshotD1WithQueries(x.cf,DB,{maxBytes:10}),/ST_D1_SNAPSHOT_SIZE/);}finally{x.close();}
});
test('integer bounds and snapshot options checked before querying',async()=>{
 const x=makeD1();try{await assert.rejects(snapshotD1WithQueries(x.cf,'bad'),/CONFIG/);await assert.rejects(snapshotD1WithQueries(x.cf,DB,{pageSize:1000}),/CONFIG/);assert.equal(x.trace.length,0);}finally{x.close();}
});
