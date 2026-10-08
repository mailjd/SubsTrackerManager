#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {detectDeploymentHost} from './upgrade/deploy-environment.mjs';
const entry=detectDeploymentHost()==='cloudflare-workers-builds'?'scripts/deploy-cloudflare.mjs':'scripts/safe-upgrade.mjs';
const args=entry.endsWith('safe-upgrade.mjs')?['all']:[];
const result=spawnSync(process.execPath,[entry,...args],{stdio:'inherit'});
process.exitCode=result.status??1;
