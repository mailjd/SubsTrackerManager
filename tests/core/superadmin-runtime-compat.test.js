/** Native Workers compatibility tests. The older repository's superadmin.test.js
 * remains discoverable and is NOT overwritten or excluded by this file. */
import {describe,it,expect,beforeEach} from 'vitest';
import {env} from 'cloudflare:test';
import * as auth from '../../src/core/superadmin.js';
import {handleLogin} from '../../src/api/handlers/auth.js';
const pair={SUBSTRACKER_SUPERADMIN_USERNAME:'root-admin',SUBSTRACKER_SUPERADMIN_PASSWORD:'second-secret'};
beforeEach(async()=>{const rows=await env.SUBSCRIPTIONS_KV.list();await Promise.all(rows.keys.map(k=>env.SUBSCRIPTIONS_KV.delete(k.name)));await env.SUBSCRIPTIONS_KV.put('config',JSON.stringify({ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'normal-only',JWT_SECRET:'local-jwt',CREDENTIALS_ENCRYPTION_KEY:'local-credentials'}));});
function login(bindings,username,password){return handleLogin(new Request('https://unit.invalid/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})}),bindings);}
describe('runtime SuperAdmin exported contract and actual login',()=>{
 it('returns only the configured runtime identity pair',()=>{expect(auth.getRuntimeSuperAdminCredentials(pair)).toEqual({username:'root-admin',password:'second-secret'});});
 it('requires both runtime fields and never supplies default credentials',()=>{for(const e of [{},{SUBSTRACKER_SUPERADMIN_USERNAME:'root'}, {SUBSTRACKER_SUPERADMIN_PASSWORD:'secret'}, {...pair,SUBSTRACKER_SUPERADMIN_USERNAME:''}])expect(auth.getRuntimeSuperAdminCredentials(e)).toBeNull();});
 it('rejects either wrong component',async()=>{expect(await auth.verifyRuntimeSuperAdminCredentials(pair,'root-admin','second-secret')).toBe(true);expect(await auth.verifyRuntimeSuperAdminCredentials(pair,'other','second-secret')).toBe(false);expect(await auth.verifyRuntimeSuperAdminCredentials(pair,'root-admin','wrong')).toBe(false);});
 it('rejects invalid inputs without a type coercion',async()=>{expect(await auth.verifyRuntimeSuperAdminCredentials(pair,null,'second-secret')).toBe(false);expect(await auth.verifyRuntimeSuperAdminCredentials(pair,'root-admin',{})).toBe(false);});
 it('does not strip whitespace from passwords',async()=>{const e={...pair,SUBSTRACKER_SUPERADMIN_PASSWORD:' secret '};expect(await auth.verifyRuntimeSuperAdminCredentials(e,'root-admin',' secret ')).toBe(true);expect(await auth.verifyRuntimeSuperAdminCredentials(e,'root-admin','secret')).toBe(false);});
 it('actual login accepts independently configured username',async()=>{const r=await login({...env,...pair},'root-admin','second-secret');expect(await r.json()).toMatchObject({success:true,superAdmin:true});expect(r.headers.get('set-cookie')).toContain('superadmin_token=');});
 it('cannot reuse ordinary username with the elevated password when a separate username is configured',async()=>{const r=await login({...env,...pair},'admin','second-secret');expect((await r.json()).success).toBe(false);});
 it('keeps normal admin login and clears an older elevated cookie',async()=>{const r=await login({...env,...pair},'admin','normal-only');expect(await r.json()).toEqual({success:true,superAdmin:false});expect(r.headers.get('set-cookie')).toContain('superadmin_token=;');});
 it('preserves password-only legacy login when no runtime username is configured',async()=>{const r=await login({...env,SUBSTRACKER_SUPERADMIN_PASSWORD:'legacy-secret'},'admin','legacy-secret');expect((await r.json()).superAdmin).toBe(true);});
 it('an explicitly empty username does not open legacy fallback',async()=>{const r=await login({...env,...pair,SUBSTRACKER_SUPERADMIN_USERNAME:''},'admin','second-secret');expect((await r.json()).success).toBe(false);});
});
