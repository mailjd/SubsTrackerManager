import test from 'node:test';
import {VERSION} from '../../src/version.js';
import {UPGRADE_RUN} from '../../src/upgrade-release.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {detectDeploymentHost,assertSupportedDeploymentHost,assertNodeRuntime,validateDeploymentSecrets,readWranglerConfig,checkDeploymentEnvironment} from '../../scripts/upgrade/deploy-environment.mjs';
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const validEnv = () => ({CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'sensitive-test-token-no-network',SUBSTRACKER_BACKUP_PASSWORD:'sensitive-test-backup-password'});
function rootFixture(t, toml = 'name="custom-existing-worker"\n') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'subs-deploy-config-'));
  fs.writeFileSync(path.join(root,'wrangler.toml'),toml);
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return root;
}
function node(script, extra={}) {
  // Ensure inherited CI flags cannot make these tests ambiguous.
  const env = {...process.env,WORKERS_CI:'',WORKERS_CI_BUILD_UUID:'',CF_PAGES:'',GITHUB_ACTIONS:'',SUBSTRACKER_BACKUP_PASSWORD:'',SUBSTRACKER_SAFE_DEPLOY_RUN:'',...extra};
  return spawnSync(process.execPath,[script],{cwd:source,env,encoding:'utf8',timeout:15000});
}

test('Workers Builds is detected before generic CI or Actions flags',()=>{
  assert.equal(detectDeploymentHost({CI:'true',WORKERS_CI:'1',GITHUB_ACTIONS:'true'}),'cloudflare-workers-builds');
  assert.equal(detectDeploymentHost({WORKERS_CI_BUILD_UUID:'a-build'}),'cloudflare-workers-builds');
});
test('Pages is explicitly rejected; local / GitHub Actions remain supported',()=>{
  assert.throws(()=>assertSupportedDeploymentHost({CF_PAGES:'1'}),{code:'ST_DEPLOY_ROUTE'});
  assert.equal(assertSupportedDeploymentHost({GITHUB_ACTIONS:'true'}),'github-actions');
  assert.equal(assertSupportedDeploymentHost({WORKERS_CI:'false',CF_PAGES:'0'}),'local-or-external-ci');
});
test('unsupported Node stops before any backup or remote API',()=>{
  for(const v of ['18.20.1','20.19.0','22.12.0','23.3.0','invalid'])assert.throws(()=>assertNodeRuntime(v),{code:'ST_DEPLOY_NODE'});
  for(const v of ['22.13.0','22.16.0','23.4.0','24.0.0'])assert.doesNotThrow(()=>assertNodeRuntime(v));
});
test('preflight aggregates missing secret NAMES without printing configured values',()=>{
  const e=validEnv();e.CLOUDFLARE_ACCOUNT_ID='bad';e.SUBSTRACKER_BACKUP_PASSWORD='private';
  assert.throws(()=>validateDeploymentSecrets(e),error=>error.code==='ST_DEPLOY_CONFIG'&&!error.message.includes('private')&&!error.message.includes(e.CLOUDFLARE_API_TOKEN));
  assert.doesNotThrow(()=>validateDeploymentSecrets(validEnv()));
});
test('successful preflight reads but never mutates original TOML or creates state',t=>{
  const root=rootFixture(t),file=path.join(root,'wrangler.toml'),before=fs.readFileSync(file);
  const result=checkDeploymentEnvironment(root,{...validEnv(),GITHUB_ACTIONS:'true'});
  assert.equal(result.worker,'custom-existing-worker');assert.equal(result.remoteAccessChecked,false);
  assert.deepEqual(fs.readFileSync(file),before);assert.deepEqual(fs.readdirSync(root),['wrangler.toml']);
  const out=JSON.stringify(result);assert.ok(!out.includes(validEnv().CLOUDFLARE_API_TOKEN));assert.ok(!out.includes(validEnv().SUBSTRACKER_BACKUP_PASSWORD));
});
test('Cloudflare preflight rejects even if secrets are configured, before reading any file',()=>{
  assert.throws(()=>checkDeploymentEnvironment('/does-not-exist',{...validEnv(),WORKERS_CI:'1'}),{code:'ST_DEPLOY_ROUTE'});
});
test('explicit original Worker name overrides template, environment is preserved',t=>{
  const root=rootFixture(t,'name="template"\n[env.production]\nname="original-production"\n');
  assert.equal(readWranglerConfig(root,{...validEnv(),SUBSTRACKER_ENVIRONMENT:'production'}).name,'original-production');
  assert.equal(readWranglerConfig(root,{...validEnv(),SUBSTRACKER_WORKER_NAME:'my-real-worker'}).name,'my-real-worker');
  assert.throws(()=>readWranglerConfig(root,{...validEnv(),SUBSTRACKER_ENVIRONMENT:'missing'}),{code:'ST_DEPLOY_ENV'});
});
test('wrong account ID rejects rather than rewriting to another account',t=>{
  const root=rootFixture(t,`name="original"\naccount_id="${'b'.repeat(32)}"\n`);
  const original=fs.readFileSync(path.join(root,'wrangler.toml'),'utf8');
  assert.throws(()=>readWranglerConfig(root,validEnv()),{code:'ST_DEPLOY_ACCOUNT'});
  assert.equal(fs.readFileSync(path.join(root,'wrangler.toml'),'utf8'),original);
});
test('Worker URL is an HTTPS origin, not /admin or credentialed URL',t=>{
  const root=rootFixture(t);
  for(const url of ['https://example.invalid/admin','http://example.invalid','https://a:b@example.invalid','https://example.invalid/?token=private','not-url'])assert.throws(()=>readWranglerConfig(root,{...validEnv(),SUBSTRACKER_WORKER_URL:url}),{code:'ST_DEPLOY_URL'});
  assert.doesNotThrow(()=>readWranglerConfig(root,{...validEnv(),SUBSTRACKER_WORKER_URL:'https://example.invalid'}));
});
test('missing Python produces actionable failure, not guessed config',t=>{
  const root=rootFixture(t);assert.throws(()=>readWranglerConfig(root,{...validEnv(),PYTHON:'/missing/python'}),{code:'ST_DEPLOY_PYTHON'});
});
test('raw Cloudflare command explains the supported split route, not a mandatory disconnect',()=>{
  const r=node('scripts/require-safe-upgrade.mjs',{WORKERS_CI:'1'});
  assert.equal(r.status,1);assert.match(r.stderr,/ST_DEPLOY_COMMAND/);assert.match(r.stderr,/deploy:cloudflare/);assert.match(r.stderr,/不必 Disconnect/);
  assert.doesNotMatch(r.stderr,/ExperimentalWarning/);assert.doesNotMatch(r.stderr,/node:sqlite/);
});
test('ordinary raw Wrangler guard still fails closed without SQLite warning',()=>{
  const r=node('scripts/require-safe-upgrade.mjs');
  assert.equal(r.status,1);assert.match(r.stderr,/ST_DEPLOY_UNPREPARED/);assert.doesNotMatch(r.stderr,/ExperimentalWarning/);
});
test('setting a fake run ID cannot unlock guard',()=>{
  const r=node('scripts/require-safe-upgrade.mjs',{SUBSTRACKER_SAFE_DEPLOY_RUN:'fake',SUBSTRACKER_BACKUP_PASSWORD:'fake-password-long-enough'});
  assert.equal(r.status,1);assert.match(r.stderr,/ST_DEPLOY_GUARD|ST_DEPLOY_BACKUP/);
});
test('preflight CLI succeeds locally with synthetic config and leaks no secrets',()=>{
  const env={...validEnv(),SUBSTRACKER_WORKER_NAME:'synthetic-original',GITHUB_ACTIONS:'true'};
  const r=node('scripts/check-deploy-environment.mjs',env);assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/尚未部署/);assert.ok(!r.stdout.includes(env.CLOUDFLARE_API_TOKEN));assert.ok(!r.stdout.includes(env.SUBSTRACKER_BACKUP_PASSWORD));
});
test('CLI rejects Workers Builds before prepare and does not create state',()=>{
  const marker=path.join(source,'.upgrade/state.stbackup');
  const before=fs.existsSync(marker)?fs.readFileSync(marker):null;
  const r=spawnSync(process.execPath,['scripts/safe-upgrade.mjs','all'],{cwd:source,env:{...process.env,...validEnv(),WORKERS_CI:'1'},encoding:'utf8',timeout:10000});
  assert.equal(r.status,1);assert.match(r.stderr,/ST_DEPLOY_ROUTE/);assert.deepEqual(fs.existsSync(marker)?fs.readFileSync(marker):null,before);
});

test('safe workflow retains required tests, both uploaded backups, recovery, and long timeout',()=>{
  const text=fs.readFileSync(path.join(source,'.github/workflows/deploy.yml'),'utf8');
  for(const pattern of [/timeout-minutes: 90/,/cancel-in-progress: false/,/npm run deploy:check/,/npm run lint/,/npm test/,/npm run test:deploy/,/if: always\(\)/])assert.match(text,pattern);
  assert.ok(text.indexOf('npm run deploy:check')<text.indexOf('npm ci'));
  assert.ok(text.indexOf('upgrade-before-deploy-')<text.indexOf('run: npm run upgrade:stage'));
  assert.ok(text.indexOf('upgrade-maintenance-')<text.indexOf('run: npm run upgrade:finish'));
  assert.doesNotMatch(text,/continue-on-error: true|wrangler deploy --no-bundle|SUBSTRACKER_SAFE_DEPLOY_RUN:/);
});
test('Vitest uses isolated local configuration, never real production binding IDs',()=>{
  const cfg=fs.readFileSync(path.join(source,'vitest.config.js'),'utf8');assert.match(cfg,/configPath: '\.\/wrangler.test.toml'/);
  const toml=fs.readFileSync(path.join(source,'wrangler.test.toml'),'utf8');assert.doesNotMatch(toml,/\[build\]|^\[\[kv_namespaces\]\]|^\[\[d1_databases\]\]/m);
  assert.match(fs.readFileSync(path.join(source,'wrangler.toml'),'utf8'),/command = "node scripts\/require-safe-upgrade.mjs"/);
});
test('build version and upgrade runner stay consistent, and drain is not shortened',()=>{
  const pkg=JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8'));
  assert.equal(pkg.version,VERSION);assert.equal(UPGRADE_RUN.version,VERSION);
  const runner=fs.readFileSync(path.join(source,'scripts/safe-upgrade.mjs'),'utf8');assert.match(runner,/import \{VERSION\} from '\.\.\/src\/version.js'/);assert.match(runner,/16\*60\*1000/);
});
