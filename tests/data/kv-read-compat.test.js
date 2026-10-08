/** Uses the real KV binding provided by pinned workerd/Miniflare, not the Node adapter. */
import {it,expect,beforeEach} from 'vitest';
import {env} from 'cloudflare:test';
import {readKVTexts,KV_READ_CACHE_TTL_SECONDS} from '../../src/data/upgrade-reconcile.js';
beforeEach(async()=>{const rows=await env.SUBSCRIPTIONS_KV.list();await Promise.all(rows.keys.map(k=>env.SUBSCRIPTIONS_KV.delete(k.name)));});
it('compatible 60s option works against the actual pinned KV binding',async()=>{expect(KV_READ_CACHE_TTL_SECONDS).toBe(60);await env.SUBSCRIPTIONS_KV.put('a','中文');await env.SUBSCRIPTIONS_KV.put('b','');const out=await readKVTexts(env.SUBSCRIPTIONS_KV,['a','b','missing']);expect([...out]).toEqual([['a','中文'],['b',''],['missing',null]]);});
it('empty inventory does not manufacture records',async()=>{expect((await readKVTexts(env.SUBSCRIPTIONS_KV,[])).size).toBe(0);});
it('single-key fallback never hides a real permission error',async()=>{let calls=0;await expect(readKVTexts({async get(){calls++;throw new Error('403 permission denied');}},['a'])).rejects.toThrow('403');expect(calls).toBe(1);});
it('supports legacy array-overload rejection without returning missing data as empty',async()=>{const kv={async get(k){if(Array.isArray(k))throw new TypeError('key must be a string');return 'value:'+k;}};expect([...await readKVTexts(kv,['a','b'])]).toEqual([['a','value:a'],['b','value:b']]);});
it('missing bulk response entries are rejected',async()=>{await expect(readKVTexts({async get(){return new Map();}},['a'])).rejects.toThrow('缺少响应项');});
