#!/usr/bin/env node
/** Use the probed Python executable and this Node runtime for local test runners. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {checkTestRuntime} from './check-test-runtime.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
try {
  const [relative,...args]=process.argv.slice(2);
  const allowed=['tests/regression/workflow3319.py','tests/regression/api-regression.py','tests/upgrade/old-version-integration.py'];
  if(!allowed.includes(relative))throw new Error('ST_TEST_ENTRY：需要项目内明确支持的本机测试入口');
  const script=path.join(root,relative);
  if(!fs.statSync(script).isFile())throw new Error('ST_TEST_ENTRY：测试文件不存在');
  const runtime=await checkTestRuntime(root);
  const result=spawnSync(runtime.python,[script,...args],{cwd:root,stdio:'inherit',timeout:240000,
    env:{...process.env,SUBSTRACKER_TEST_NODE:process.execPath,PYTHONDONTWRITEBYTECODE:'1'}});
  if(result.status!==0){
    console.error('[runtime] ST_PYTHON_TEST_FAILED '+relative+' exit='+(result.status??'null')+' signal='+(result.signal||'none'));
    process.exitCode=result.status>0?result.status:1;
  }
} catch(error){console.error('[runtime] '+error.message);process.exitCode=1;}
