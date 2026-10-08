/** Storage boundary: the application and upgrade runner use the existing KV/D1 only.
 * Static assets, variables, secrets and Worker control APIs are not an extra database.
 * Reject unsupported bindings instead of silently removing existing resources.
 */
const forbidden = ['r2_buckets','durable_objects','vectorize','hyperdrive','queues',
  'services','analytics_engine_datasets','pipelines','workflows','dispatch_namespaces'];
const present = value => Array.isArray(value) ? value.length > 0
  : value && typeof value === 'object' ? Object.keys(value).length > 0 : Boolean(value);
export function assertD1KVConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('ST_STORAGE_POLICY：無效的儲存配置');
  for (const key of forbidden) if (present(config[key])) {
    throw new Error('ST_STORAGE_POLICY：只允許原 D1＋KV；配置含不支援的 '+key+'。請核對原配置；不自動刪除或改綁資源。');
  }
  for (const child of Object.values(config.env || {})) assertD1KVConfig(child);
  return true;
}
export function assertD1KVRequest(path, method='GET') {
  const clean = typeof path === 'string' && path.startsWith('/') && !/[\\#\r\n]/.test(path) &&
    !path.split('?')[0].split('/').some(p => ['.','..'].includes(p) || /%(?:2e|2f|5c)/i.test(p));
  // KV keys may contain an encoded slash/dot. Only the values segment may be arbitrary.
  const kvValue = typeof path === 'string' && /^\/storage\/kv\/namespaces\/[a-fA-F0-9]{32}\/values\/[^?#\\\r\n]+$/.test(path);
  const allowed = (method === 'GET' && (
    /^\/workers\/scripts\/[a-zA-Z0-9_-]+(?:\/(?:settings|schedules|subdomain))?$/.test(path) ||
    path === '/workers/subdomain' ||
    /^\/storage\/kv\/namespaces\/[a-fA-F0-9]{32}(?:\/keys(?:\?[^#\\\r\n]*)?)?$/.test(path) || kvValue ||
    /^\/d1\/database\/[a-fA-F0-9-]{36}$/.test(path))) ||
    (method === 'PUT' && /^\/storage\/kv\/namespaces\/[a-fA-F0-9]{32}\/bulk$/.test(path)) ||
    (method === 'POST' && /^\/d1\/database\/[a-fA-F0-9-]{36}\/query$/.test(path));
  // Canonicalize and keep the account prefix intact even for deliberately crafted paths.
  const base = 'https://api.cloudflare.com/client/v4/accounts/'+'a'.repeat(32);
  const url = new URL(base + String(path));
  if ((!clean && !kvValue) || !allowed || url.origin !== 'https://api.cloudflare.com' ||
      url.pathname !== '/client/v4/accounts/'+'a'.repeat(32)+String(path).split('?')[0]) {
    throw new Error('ST_STORAGE_ROUTE：備份/部署工具只允許原 Worker 控制 API、D1 query 與 KV；不發送此請求。');
  }
  return true;
}
