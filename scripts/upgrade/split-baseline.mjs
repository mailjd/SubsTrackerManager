/** Allow only append-only deployment bookkeeping between a backup and migration.
 * All original rows are still compared byte-for-byte. No ordinary key/table is ignored.
 */
import {assertOriginalsPreserved} from './archive.mjs';
import {stableJSON} from '../../src/data/upgrade-reconcile.js';
export function assertSameBaseline(before, after, original, current, controlPrefix) {
  assertOriginalsPreserved(before, after, original.image, current.image);
  if (original.summary.kvDigest !== current.summary.kvDigest || original.summary.sourceDigest !== current.summary.sourceDigest) {
    throw new Error('备份后原 KV / 订阅来源发生变化；保留资料并停止');
  }
  if (!controlPrefix) {
    if (original.summary.sqlDigest !== current.summary.sqlDigest) throw new Error('备份后 SQL 发生变化；保留资料并停止');
    return;
  }
  if (!/^upgrade:3322:cloudflare:[a-f0-9]{32}:$/.test(controlPrefix)) throw new Error('无效内部检查点前缀');
  const normalize = image => Object.fromEntries(Object.entries(image).map(([name,table])=>[name,
    name === 'schema_meta' ? {...table,rows:table.rows.filter(row=>!String(row.key).startsWith(controlPrefix))} : table
  ]));
  if (stableJSON(normalize(original.image)) !== stableJSON(normalize(current.image))) throw new Error('备份后业务 SQL 发生变化；不会将其误认为构建检查点');
}
