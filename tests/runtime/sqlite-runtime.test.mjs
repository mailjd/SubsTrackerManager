import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {pythonCommand,checkTestRuntime} from '../../scripts/check-test-runtime.mjs';
import {RELEASE_CHECKS} from '../../scripts/upgrade/release-checks.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const blocker=path.join(root,'tests/runtime/no-sqlite-python.py');
const support=path.join(root,'tests/support');
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'subs-sqlite-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'fixture.sqlite');
  const db=new DatabaseSync(file);
  db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY,note TEXT,n INTEGER,b BLOB,v REAL,empty_value);');
  db.prepare('INSERT INTO sample VALUES (?,?,?,?,?,?)').run(1,'中文\u0000測試',9223372036854775807n,Buffer.from([0,255,1]),1.25,null);
  db.close();return {dir,file};
}
function py(code,args=[],env={}) {
  return spawnSync(pythonCommand(),[blocker,'-c',`import sys\nsys.path.insert(0, ${JSON.stringify(support)})\nfrom sqlite_local import query_rows, execute_transaction\n`+code,...args],
    {cwd:os.tmpdir(),env:{...process.env,SUBSTRACKER_TEST_NODE:process.execPath,PYTHONDONTWRITEBYTECODE:'1',...env},encoding:'utf8',timeout:30000});
}
function ok(r){assert.equal(r.status,0,(r.stdout||'')+'\n'+(r.stderr||''));}
function value(file){const db=new DatabaseSync(file,{readOnly:true});try{return Buffer.from(db.prepare('SELECT hex(CAST(note AS BLOB)) AS bytes FROM sample WHERE id=1').get().bytes,'hex').toString('utf8');}finally{db.close();}}

test('failure injection really reproduces a missing Python _sqlite3 extension',()=>{
  const r=py('import _sqlite3');assert.notEqual(r.status,0);assert.match(r.stderr,/ModuleNotFoundError: No module named '_sqlite3'/);
});
test('disk reads work with sqlite3 and _sqlite3 unavailable; preserve Unicode/NUL/int64/blob/NULL',t=>{
  const f=fixture(t);ok(py(`r=query_rows(sys.argv[1], 'SELECT note,n,b,v,empty_value FROM sample')[0]\nassert r == ('中文\\x00測試',9223372036854775807,b'\\x00\\xff\\x01',1.25,None),r`,[f.file]));
});
test('bound parameters preserve quotes and prevent query text injection',t=>{
  const f=fixture(t);ok(py(`assert query_rows(sys.argv[1], 'SELECT note FROM sample WHERE id=?', (1,))[0][0]=='中文\\x00測試'\nassert query_rows(sys.argv[1], 'SELECT note FROM sample WHERE note=?', ("x' OR 1=1 --",))==[]`,[f.file]));
});
test('missing fixture is rejected and is not silently created',t=>{
  const f=fixture(t);const missing=path.join(f.dir,'missing.sqlite');const r=py(`query_rows(sys.argv[1], 'SELECT 1')`,[missing]);assert.notEqual(r.status,0);assert.ok(!fs.existsSync(missing));
});
test('corrupt fixture and invalid SQL fail, not empty successful test results',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.dir,'bad.sqlite'),'not a database');
  assert.notEqual(py(`query_rows(sys.argv[1], 'SELECT * FROM sample')`,[path.join(f.dir,'bad.sqlite')]).status,0);
  assert.notEqual(py(`query_rows(sys.argv[1], 'SELECT missing_field FROM sample')`,[f.file]).status,0);
});
test('the read-only path rejects mutations and leaves original bytes untouched',t=>{
  const f=fixture(t),before=fs.readFileSync(f.file);const r=py(`query_rows(sys.argv[1], 'DELETE FROM sample RETURNING id')`,[f.file]);assert.notEqual(r.status,0);assert.deepEqual(fs.readFileSync(f.file),before);
});
test('explicit fixture transaction persists on independent process reopen',t=>{
  const f=fixture(t);ok(py(`execute_transaction(sys.argv[1],[('UPDATE sample SET note=? WHERE id=?',('committed',1))])`,[f.file]));assert.equal(value(f.file),'committed');
  ok(py(`assert query_rows(sys.argv[1],'SELECT note FROM sample WHERE id=1')==[('committed',)]`,[f.file]));
});
test('a failed batch rolls back its preceding statement',t=>{
  const f=fixture(t);const r=py(`execute_transaction(sys.argv[1],[('UPDATE sample SET note=? WHERE id=?',('must rollback',1)),('INSERT INTO sample(id) VALUES (?)',(1,))])`,[f.file]);assert.notEqual(r.status,0);assert.equal(value(f.file),'中文\u0000測試');
});
test('multiple SQL statements cannot silently execute only the first one',t=>{
  const f=fixture(t);const r=py(`execute_transaction(sys.argv[1],[(\"UPDATE sample SET note='bad'; DELETE FROM sample\",())])`,[f.file]);assert.notEqual(r.status,0);assert.match(r.stderr,/Exactly one complete SQL statement/);assert.equal(value(f.file),'中文\u0000測試');
});
test('fixture DDL and ATTACH are not accepted by the write helper',t=>{
  const f=fixture(t);for(const sql of ['DROP TABLE sample',"ATTACH DATABASE ':memory:' AS extra"]){assert.notEqual(py(`execute_transaction(sys.argv[1],[(sys.argv[2],())])`,[f.file,sql]).status,0);}assert.equal(value(f.file),'中文\u0000測試');
});
test('blob/empty string/NULL and minimum int64 values round trip through fixture writes',t=>{
  const f=fixture(t);ok(py(`execute_transaction(sys.argv[1],[('UPDATE sample SET note=?,n=?,b=?,v=?,empty_value=? WHERE id=1',('',-(2**63),b'',-3.5,None))])\nassert query_rows(sys.argv[1],'SELECT note,n,b,v,empty_value FROM sample')==[('',-(2**63),b'',-3.5,None)]`,[f.file]));
});
test('out-of-range integer and non-finite real parameters fail without modifying fixture',t=>{
  const f=fixture(t);for(const code of ['2**80',"float('nan')"]){assert.notEqual(py(`execute_transaction(sys.argv[1],[('UPDATE sample SET n=?',(${code},))])`,[f.file]).status,0);}assert.equal(value(f.file),'中文\u0000測試');
});
test('missing Node executable is an actual failure, not a Python/sqlite fallback',t=>{
  const f=fixture(t);const r=py(`query_rows(sys.argv[1],'SELECT * FROM sample')`,[f.file],{SUBSTRACKER_TEST_NODE:path.join(f.dir,'missing-node')});assert.notEqual(r.status,0);assert.match(r.stderr,/ST_TEST_SQLITE/);
});
test('runtime preflight tests a real disk file and a Python-to-Node round trip',async()=>{
  const r=await checkTestRuntime(root);assert.equal(r.report.pythonSQLiteRequired,false);assert.equal(r.report.crossProcessDiskRead,true);assert.equal(r.report.remoteAccess,false);
});
test('runtime preflight rejects a missing Python executable before release checks',async()=>{
  await assert.rejects(checkTestRuntime(root,{...process.env,PYTHON:'/no-such-python'}),{code:'ST_TEST_RUNTIME'});
});
test('workflow launcher uses PYTHON rather than silently invoking another interpreter',t=>{
  const f=fixture(t);const r=spawnSync(process.execPath,[path.join(root,'scripts/run-python-test.mjs'),'tests/regression/workflow3319.py','.'],{cwd:f.dir,env:{...process.env,PYTHON:path.join(f.dir,'missing-python')},encoding:'utf8',timeout:30000});assert.notEqual(r.status,0);assert.match(r.stderr,/ST_TEST_RUNTIME/);assert.doesNotMatch(r.stdout,/PASS D1/);
});
test('mandatory release workflow and original checks are retained; runtime probe is first',()=>{
  assert.equal(RELEASE_CHECKS[0],'test:runtime');for(const s of ['lint','test:context','test:storage','test:deploy','test:upgrade','test:workflow','test'])assert.ok(RELEASE_CHECKS.includes(s));
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json')));assert.equal(pkg.scripts['test:workflow'],'node scripts/run-python-test.mjs tests/regression/workflow3319.py .');
  const build=fs.readFileSync(path.join(root,'scripts/build.mjs'),'utf8');assert.ok(build.indexOf("['check-test-runtime.mjs'")<build.indexOf("['lint'"));
});
test('all shipped Python disk assertions use the portable helper, not sqlite3 imports',()=>{
  for(const file of ['tests/regression/workflow3319.py','tests/regression/api-regression.py','tests/upgrade/old-version-integration.py']){
    const s=fs.readFileSync(path.join(root,file),'utf8');assert.doesNotMatch(s,/\bsqlite3\b/);assert.match(s,/from sqlite_local import/);assert.match(s,/query_rows\(/);
  }
});

test('runtime preflight succeeds when the selected Python explicitly blocks SQLite imports',async t=>{
  const f=fixture(t),wrapper=path.join(f.dir,'python-no-sqlite');
  const python=pythonCommand();
  fs.writeFileSync(wrapper,`#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const r=spawnSync(${JSON.stringify(python)},[${JSON.stringify(blocker)},...process.argv.slice(2)],{stdio:'inherit'});process.exit(r.status??1);\n`,{mode:0o700});
  const r=await checkTestRuntime(root,{...process.env,PYTHON:wrapper});
  assert.equal(r.report.pythonSQLiteRequired,false);assert.equal(r.python,wrapper);
});
test('disabled Node SQLite is rejected explicitly instead of silently skipping local SQL checks',()=>{
  const r=spawnSync(process.execPath,['--no-experimental-sqlite',path.join(root,'scripts/check-test-runtime.mjs')],{cwd:root,encoding:'utf8',timeout:30000});
  assert.notEqual(r.status,0);assert.match(r.stderr,/ST_TEST_RUNTIME/);assert.doesNotMatch(r.stdout,/ST_TEST_RUNTIME_OK/);
});
test('Python test failures propagate their exit status through the launcher',t=>{
  const f=fixture(t);
  for(const dir of ['scripts','tests/support'])fs.cpSync(path.join(root,dir),path.join(f.dir,dir),{recursive:true});
  fs.mkdirSync(path.join(f.dir,'tests/regression'),{recursive:true});
  fs.writeFileSync(path.join(f.dir,'tests/regression/workflow3319.py'),'import sys\nprint("real test failure",flush=True)\nsys.exit(7)\n');
  const r=spawnSync(process.execPath,[path.join(f.dir,'scripts/run-python-test.mjs'),'tests/regression/workflow3319.py','.'],{cwd:os.tmpdir(),encoding:'utf8',timeout:30000});
  assert.equal(r.status,7,r.stderr);assert.match(r.stderr,/ST_PYTHON_TEST_FAILED/);assert.match(r.stdout,/real test failure/);
});
