#!/usr/bin/env node
/** Verify actual local capabilities, not just runtime version labels. No cloud I/O. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

export function pythonCommand(env=process.env) {
  return env.PYTHON || (process.platform==='win32'?'python':'python3');
}
export async function checkTestRuntime(root, env=process.env) {
  let directory, db;
  try {
    const {DatabaseSync} = await import('node:sqlite');
    directory = fs.mkdtempSync(path.join(os.tmpdir(),'subs-runtime-'));
    const database = path.join(directory,'capability.sqlite');
    db = new DatabaseSync(database);
    db.exec('CREATE TABLE capability (value TEXT NOT NULL, n INTEGER NOT NULL);');
    db.prepare('INSERT INTO capability VALUES (?,?)').run('SQLite 能力檢查',9223372036854775807n);
    const sqliteVersion = db.prepare('SELECT sqlite_version() AS version').get().version;
    db.close(); db=undefined;
    const code = [
      'import sys,json,tomllib,subprocess,urllib.request,urllib.error,http.cookiejar,socket,tempfile,concurrent.futures',
      'assert sys.version_info >= (3,11), "Python 3.11+ required"',
      'sys.path.insert(0, sys.argv[1])',
      'from sqlite_local import query_rows',
      'assert query_rows(sys.argv[2], "SELECT value,n FROM capability") == [("SQLite 能力檢查",9223372036854775807)]',
      'print(json.dumps({"version":sys.version.split()[0],"executable":sys.executable}))',
    ].join('\n');
    const child = spawnSync(pythonCommand(env), ['-c',code,path.join(root,'tests/support'),database],
      {cwd:root, env:{...env,SUBSTRACKER_TEST_NODE:process.execPath,PYTHONDONTWRITEBYTECODE:'1'},encoding:'utf8',timeout:20000,maxBuffer:1024*1024});
    if (child.status!==0) throw new Error('Python 3.11+ / tomllib 或 Python→Node SQLite 实际读回失败；'+(child.error?.code||child.stderr?.trim().slice(-900)||'exit='+child.status));
    const py = JSON.parse(child.stdout);
    const report = {node:process.versions.node,python:py.version,sqliteEngine:'node:sqlite',sqliteVersion,
      pythonSQLiteRequired:false,crossProcessDiskRead:true,remoteAccess:false};
    console.log('[runtime] ST_TEST_RUNTIME_OK '+JSON.stringify(report));
    return {report,python:pythonCommand(env)};
  } catch(error) {
    const e = new Error('ST_TEST_RUNTIME：本机测试运行环境未通过；不跳过测试、不发布。'+error.message);
    e.code='ST_TEST_RUNTIME';throw e;
  } finally {
    if(db)try{db.close();}catch{}
    if(directory)fs.rmSync(directory,{recursive:true,force:true});
  }
}
const self=fileURLToPath(import.meta.url);
if(process.argv[1]&&path.resolve(process.argv[1])===self) {
  checkTestRuntime(path.resolve(path.dirname(self),'..')).catch(error=>{
    console.error('[runtime] '+error.message);process.exitCode=1;
  });
}
