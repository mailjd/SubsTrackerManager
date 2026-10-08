#!/usr/bin/env node
/** Idempotent, local-only repair before the unchanged complete tsc check. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {repairLegacyPagesContext} from './compat/legacy-pages-context.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  if (!fs.existsSync(path.join(root, 'src/pages-handler.js'))) {
    console.log('[compat] ST_CONTEXT_ABSENT：没有旧 src/pages-handler.js；无需修补，继续完整类型检查。');
  } else {
    const require = createRequire(path.join(root, 'package.json'));
    const ts = require('typescript');
    const result = repairLegacyPagesContext(root, ts);
    const code = result.status === 'repaired' ? 'ST_CONTEXT_REPAIRED' : 'ST_CONTEXT_UNCHANGED';
    console.log('[compat] ' + code + ' ' + JSON.stringify({...result, typescript: ts.version, remoteAccess: false}));
    console.log('[compat] 接下来仍必须通过完整 tsc；未删除旧文件，未禁用检查，未发布。');
  }
} catch (error) {
  console.error('[compat] ' + error.message);
  process.exitCode = 1;
}
