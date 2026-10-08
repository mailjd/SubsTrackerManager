#!/usr/bin/env node
/** Existing local development helper; cannot target a remote database. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {localWrangler} from './upgrade/local-toolchain.mjs';
try{const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),tool=localWrangler(root);
 const r=spawnSync(tool.command,[tool.entry,'d1','migrations','apply','subscription-manager-dev','--local','--config','wrangler.dev.toml'],{cwd:root,stdio:'inherit'});process.exitCode=r.status??1;
}catch(e){console.error(e.message);process.exitCode=1;}
