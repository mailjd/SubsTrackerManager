#!/usr/bin/env node
/** Executes the same mandatory checks as deployment, without any deployment call. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyReleaseChecks} from './upgrade/release-checks.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
try {
  verifyReleaseChecks(root);
  console.log('[verify] ST_RELEASE_CHECKS_OK：全部发布前检查通过；未发布、未迁移。');
} catch(error) {
  console.error('[verify] '+error.message);
  process.exitCode=1;
}
