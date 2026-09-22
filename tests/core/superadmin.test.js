// @ts-check
import { describe, it, expect } from 'vitest';
import { getRuntimeSuperAdminCredentials, verifyRuntimeSuperAdminCredentials } from '../../src/core/superadmin.js';

describe('SuperAdmin runtime credentials', () => {
  it('requires username and password from runtime variables', async () => {
    const runtime = getRuntimeSuperAdminCredentials({
      SUBSTRACKER_SUPERADMIN_USERNAME: 'root-admin',
      SUBSTRACKER_SUPERADMIN_PASSWORD: 'second-secret'
    });
    expect(runtime.configured).toBe(true);
    expect(runtime.username).toBe('root-admin');
    expect(await verifyRuntimeSuperAdminCredentials({
      SUBSTRACKER_SUPERADMIN_USERNAME: 'root-admin',
      SUBSTRACKER_SUPERADMIN_PASSWORD: 'second-secret'
    }, 'root-admin', 'second-secret')).toBe(true);
  });

  it('rejects wrong username or password', async () => {
    const env = {
      SUBSTRACKER_SUPERADMIN_USERNAME: 'root-admin',
      SUBSTRACKER_SUPERADMIN_PASSWORD: 'second-secret'
    };
    expect(await verifyRuntimeSuperAdminCredentials(env, 'other', 'second-secret')).toBe(false);
    expect(await verifyRuntimeSuperAdminCredentials(env, 'root-admin', 'wrong')).toBe(false);
  });
});
