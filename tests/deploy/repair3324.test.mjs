import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {inspectToolchain,localWrangler} from '../../scripts/upgrade/local-toolchain.mjs';
import {checkBundle,bundleEnvironment} from '../../scripts/check-bundle.mjs';
import {sourceFingerprint} from '../../scripts/upgrade/cloudflare-checkpoints.mjs';
import {VERSION} from '../../src/version.js';
import {deploymentRouteHelp} from '../../scripts/upgrade/deploy-environment.mjs';
import {RELEASE_CHECKS,verifyReleaseChecks} from '../../scripts/upgrade/release-checks.mjs';
import {installFakeToolchain} from '../upgrade/fake-local-toolchain.mjs';
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const validEnv={WORKERS_CI:'1',WORKERS_CI_BUILD_UUID:'synthetic-build',CF_PAGES:'',GITHUB_ACTIONS:'',CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'synthetic-private-token',SUBSTRACKER_BACKUP_PASSWORD:'synthetic-private-backup-password',SUBSTRACKER_SAFE_DEPLOY_RUN:'',SUBSTRACKER_WORKER_NAME:'synthetic-original'};
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'subs-tools-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));installFakeToolchain(source,root);return root;}
function edit(file,fn){const p=JSON.parse(fs.readFileSync(file));fn(p);fs.writeFileSync(file,JSON.stringify(p));}
function run(file,env={}){return spawnSync(process.execPath,[file],{cwd:source,env:{...process.env,...validEnv,...env},encoding:'utf8',timeout:15000});}

test('root release Wrangler and deprecated nested TEST Wrangler are correctly distinguished',t=>{
 const root=fixture(t),report=inspectToolchain(root);
 assert.equal(report.direct.wrangler.locked,'3.114.17');assert.equal(report.direct.wrangler.installed,'3.114.17');
 const nested=report.wranglers.find(x=>x.role==='test-transitive');assert.equal(nested.version,'3.100.0');assert.match(nested.deprecated,/Downgrade/);
 const tool=localWrangler(root);assert.equal(tool.command,process.execPath);assert.equal(tool.entry,path.join(root,'node_modules/wrangler/bin/wrangler.js'));
});
test('every direct dependency is an exact version paired with lock metadata',t=>{
 const report=inspectToolchain(fixture(t));for(const d of Object.values(report.direct)){assert.match(d.declared,/^\d+\.\d+\.\d+$/);assert.equal(d.declared,d.locked);assert.equal(d.installed,d.locked);}
});
test('missing root Wrangler fails rather than looking up npx/global/network fallback',t=>{
 const root=fixture(t);fs.rmSync(path.join(root,'node_modules/wrangler'),{recursive:true});assert.throws(()=>localWrangler(root),{code:'ST_TOOLCHAIN'});
});
test('wrong installed root version is explicitly rejected',t=>{
 const root=fixture(t);edit(path.join(root,'node_modules/wrangler/package.json'),p=>p.version='3.100.0');assert.throws(()=>localWrangler(root),e=>e.code==='ST_TOOLCHAIN'&&/3\.114\.17/.test(e.message)&&/3\.100\.0/.test(e.message));
});
test('partial package update / mismatching lock root version is rejected',t=>{
 const root=fixture(t);edit(path.join(root,'package-lock.json'),p=>p.version='3.3.23');assert.throws(()=>inspectToolchain(root),{code:'ST_TOOLCHAIN'});
});
test('caret or floating root Wrangler does not silently drift',t=>{
 const root=fixture(t);for(const n of ['package.json','package-lock.json'])edit(path.join(root,n),p=>{const obj=n==='package.json'?p:p.packages[''];obj.devDependencies.wrangler='^3.114.17';});assert.throws(()=>inspectToolchain(root),{code:'ST_TOOLCHAIN'});
});
test('bin traversal outside installed package is rejected',t=>{
 const root=fixture(t);edit(path.join(root,'node_modules/wrangler/package.json'),p=>p.bin.wrangler='../../../scripts/deploy.mjs');assert.throws(()=>localWrangler(root),{code:'ST_TOOLCHAIN'});
});
test('invalid package JSON gives a useful safe error',t=>{
 const root=fixture(t);fs.writeFileSync(path.join(root,'package-lock.json'),'{invalid');assert.throws(()=>inspectToolchain(root),{code:'ST_TOOLCHAIN'});
});
test('report-only distinguishes no install from successful verification',t=>{
 const root=fixture(t);fs.rmSync(path.join(root,'node_modules'),{recursive:true});const report=inspectToolchain(root,{requireInstalled:false});assert.equal(report.direct.wrangler.installed,null);assert.throws(()=>inspectToolchain(root),{code:'ST_TOOLCHAIN'});
});
test('public deploy:check now accepts Workers Builds and performs no remote writes',()=>{
 const marker=path.join(source,'.upgrade/state.stbackup'),before=fs.existsSync(marker)?fs.readFileSync(marker):null;
 const r=run('scripts/check-deploy-environment.mjs');assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/cloudflare-workers-builds/);assert.match(r.stdout,/remoteAccessChecked":false/);assert.deepEqual(fs.existsSync(marker)?fs.readFileSync(marker):null,before);
 for(const value of [validEnv.CLOUDFLARE_API_TOKEN,validEnv.SUBSTRACKER_BACKUP_PASSWORD])assert.ok(!r.stdout.includes(value)&&!r.stderr.includes(value));
});
test('public deploy:check still rejects Pages and missing build secrets',()=>{
 const pages=run('scripts/check-deploy-environment.mjs',{WORKERS_CI:'',WORKERS_CI_BUILD_UUID:'',CF_PAGES:'1'});assert.equal(pages.status,1);assert.match(pages.stderr,/ST_DEPLOY_ROUTE/);
 const missing=run('scripts/check-deploy-environment.mjs',{SUBSTRACKER_BACKUP_PASSWORD:''});assert.equal(missing.status,1);assert.match(missing.stderr,/ST_DEPLOY_CONFIG/);
});
test('raw Wrangler remains blocked: no fake-success workaround or clearing of protection',()=>{
 const r=run('scripts/require-safe-upgrade.mjs');assert.equal(r.status,1);assert.match(r.stderr,/ST_DEPLOY_COMMAND/);assert.match(r.stderr,/控制台设置尚未生效/);assert.ok(r.stderr.includes('v'+VERSION));assert.doesNotMatch(r.stderr,/v3\.3\.22|ExperimentalWarning/);
});
test('error help points at Deploy command and current documentation, not obsolete version',()=>{
 const help=deploymentRouteHelp('cloudflare-workers-builds');assert.match(help,new RegExp('v'+VERSION.replaceAll('.','\\.')));assert.ok(help.includes('DEPLOY_REPAIR_'+VERSION+'.md'));assert.match(help,/不是 Build command/);assert.match(help,/不必 Disconnect/);
});
test('build is no longer an echo-only success and no build script calls production deployment',()=>{
 const pkg=JSON.parse(fs.readFileSync(path.join(source,'package.json')));assert.equal(pkg.scripts.build,'node scripts/build.mjs');const s=fs.readFileSync(path.join(source,'scripts/build.mjs'),'utf8');for(const x of ['check-toolchain.mjs','check-syntax.mjs','check-bundle.mjs'])assert.ok(s.includes(x));assert.doesNotMatch(s,/runSplitDeployment|safe-upgrade\.mjs/);
});
test('bundle child environment cannot inherit production credentials, preloads or run capability',()=>{
 const e=bundleEnvironment({...validEnv,PATH:'/synthetic/bin',NODE_OPTIONS:'--import=unsafe',NODE_PATH:'unsafe',npm_config_registry:'unsafe',AWS_SECRET_ACCESS_KEY:'secret',SUBSTRACKER_SAFE_DEPLOY_RUN:'do-not-forward'});
 assert.equal(e.PATH,'/synthetic/bin');for(const k of ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','SUBSTRACKER_BACKUP_PASSWORD','SUBSTRACKER_SAFE_DEPLOY_RUN','NODE_OPTIONS','NODE_PATH','AWS_SECRET_ACCESS_KEY','WORKERS_CI'])assert.equal(e[k],undefined);assert.equal(e.WRANGLER_SEND_METRICS,'false');
});
test('bundle wrapper forces --dry-run and never hands it live resource IDs (FAKE executable only)',t=>{
 const root=fixture(t),bin=localWrangler(root).entry;
 fs.writeFileSync(bin,`const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');const a=process.argv.slice(2);assert.equal(a[0],'deploy');assert.ok(a.includes('--dry-run'));assert.equal(process.env.CLOUDFLARE_API_TOKEN,undefined);assert.equal(process.env.NODE_OPTIONS,undefined);const cfg=JSON.parse(fs.readFileSync(a[a.indexOf('--config')+1]));if(cfg.kv_namespaces.length){assert.equal(cfg.kv_namespaces[0].id,'0'.repeat(32));}else{assert.deepEqual(cfg.d1_databases,[]);}assert.equal(cfg.workers_dev,false);assert.equal(cfg.build,undefined);const out=a[a.indexOf('--outdir')+1];fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'index.js'),'// synthetic test output, not a real bundle');`);
 assert.doesNotThrow(()=>checkBundle(root));
});
test('bundle check rejects a tool that returns zero but produced no bundle (FAKE executable only)',t=>{
 const root=fixture(t);fs.writeFileSync(localWrangler(root).entry,'process.exit(0);');assert.throws(()=>checkBundle(root),/未生成 JS bundle/);
});
test('bundle child failure is propagated, not presented as successful build (FAKE executable only)',t=>{
 const root=fixture(t);fs.writeFileSync(localWrangler(root).entry,'process.exit(9);');assert.throws(()=>checkBundle(root),/exit 9/);
});
test('release list retains ALL original checks and adds toolchain + actual bundle',()=>{
 assert.deepEqual(RELEASE_CHECKS,['test:runtime','test:toolchain','lint','test','test:context','test:syntax','test:bundle','test:storage','test:deploy','test:upgrade','test:web-init','test:table-contract','test:workflow']);
 assert.throws(()=>verifyReleaseChecks(source,Date.now()-1),/ST_SPLIT_BUDGET/);
 const safe=fs.readFileSync(path.join(source,'scripts/safe-upgrade.mjs'),'utf8');assert.match(safe,/cmd==='all'\).*verifyReleaseChecks\(ROOT/);assert.doesNotMatch(safe,/spawnSync\(npx/);
});
test('GitHub publisher retains required bundle/toolchain checks without skipping previous tests',()=>{
 const yaml=fs.readFileSync(path.join(source,'.github/workflows/deploy.yml'),'utf8');for(const command of ['npm run test:toolchain','npm run test:bundle','npm run lint','npm test','npm run upgrade:prepare'])assert.ok(yaml.includes(command));assert.ok(yaml.indexOf('npm run test:bundle')<yaml.indexOf('npm run upgrade:prepare'));assert.doesNotMatch(yaml,/continue-on-error: true/);
});
test('retry source digest includes test/config changes but excludes generated result files',t=>{
 const root=fixture(t);fs.mkdirSync(path.join(root,'tests/results'),{recursive:true});fs.writeFileSync(path.join(root,'tests/fixture.mjs'),'test original');fs.writeFileSync(path.join(root,'wrangler.toml'),'name="original"');const a=sourceFingerprint(root);
 fs.writeFileSync(path.join(root,'tests/results/one.log'),'temporary result');assert.equal(sourceFingerprint(root),a);
 fs.writeFileSync(path.join(root,'tests/fixture.mjs'),'test modified');const b=sourceFingerprint(root);assert.notEqual(b,a);
 fs.writeFileSync(path.join(root,'wrangler.toml'),'name="wrong"');assert.notEqual(sourceFingerprint(root),b);
});

test('deploy --help never starts a deployment and works from another working directory',()=>{
 const r=spawnSync(process.execPath,[path.join(source,'scripts/deploy.mjs'),'--help'],{cwd:os.tmpdir(),env:{...process.env,...validEnv},encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/無 D1\/KV 綁定時先部署 \/init/);assert.doesNotMatch(r.stdout,/ST_DEPLOY_ENTRY|release:check/);
});
test('unknown deployment arguments are not silently ignored before deploying',()=>{
 const bad=spawnSync(process.execPath,['scripts/deploy.mjs','--env','wrong-target'],{cwd:source,env:{...process.env,...validEnv},encoding:'utf8',timeout:10000});assert.equal(bad.status,2);assert.match(bad.stderr,/ST_DEPLOY_ARGS/);assert.doesNotMatch(bad.stdout,/ST_DEPLOY_ENTRY/);
});
