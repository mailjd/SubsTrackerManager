#!/usr/bin/env node
// Upgrade-only setup: it never creates/replaces storage or initializes credentials.
const {spawnSync}=require('node:child_process');
const result=spawnSync(process.execPath,['scripts/safe-upgrade.mjs','prepare'],{stdio:'inherit'});
process.exit(result.status===null?1:result.status);
