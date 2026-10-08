import test from 'node:test';
import assert from 'node:assert/strict';
import {getRuntimeSuperAdminCredentials, verifyRuntimeSuperAdminCredentials} from '../../src/core/superadmin.js';
const env = {SUBSTRACKER_SUPERADMIN_USERNAME:'root-admin', SUBSTRACKER_SUPERADMIN_PASSWORD:'second-secret'};

test('regression: extra repository test can read runtime.configured=true', () => {
  const runtime = getRuntimeSuperAdminCredentials(env);
  assert.equal(runtime.configured, true);
  assert.equal(runtime.username, 'root-admin');
});

test('backwards-compatible object shape for existing Workers suite', () => {
  const runtime = getRuntimeSuperAdminCredentials(env);
  assert.deepEqual(runtime, {username:'root-admin',password:'second-secret'});
  assert.deepEqual(Object.keys(runtime), ['username','password']);
  assert.equal(JSON.stringify(runtime), JSON.stringify({username:'root-admin',password:'second-secret'}));
  assert.equal(Object.getOwnPropertyDescriptor(runtime,'configured').writable,false);
});

test('partial, absent or blank runtime variables still deny elevated identity', () => {
  for (const config of [{}, {SUBSTRACKER_SUPERADMIN_PASSWORD:'second-secret'},
    {SUBSTRACKER_SUPERADMIN_USERNAME:'root-admin'}, {...env, SUBSTRACKER_SUPERADMIN_USERNAME:'  '},
    {...env, SUBSTRACKER_SUPERADMIN_PASSWORD:''}]) {
    assert.equal(getRuntimeSuperAdminCredentials(config), null);
  }
});

test('credential verification remains strict; no username or password fallback', async () => {
  assert.equal(await verifyRuntimeSuperAdminCredentials(env,'root-admin','second-secret'),true);
  assert.equal(await verifyRuntimeSuperAdminCredentials(env,'admin','second-secret'),false);
  assert.equal(await verifyRuntimeSuperAdminCredentials(env,'root-admin','wrong'),false);
  assert.equal(await verifyRuntimeSuperAdminCredentials({},'root-admin','second-secret'),false);
  assert.equal(await verifyRuntimeSuperAdminCredentials(env,null,'second-secret'),false);
});

test('password whitespace remains significant', async () => {
  const e={...env,SUBSTRACKER_SUPERADMIN_PASSWORD:' second-secret '};
  assert.equal(await verifyRuntimeSuperAdminCredentials(e,'root-admin',' second-secret '),true);
  assert.equal(await verifyRuntimeSuperAdminCredentials(e,'root-admin','second-secret'),false);
});
