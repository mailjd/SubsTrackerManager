/**
 * SQL backup through the D1 query API only. No export/import job, signed URL,
 * bucket, or object-storage SDK. Values are encoded by SQLite before JSON
 * serialization, so int64, TEXT with NUL, and BLOB bytes are not rounded/lost.
 *
 * This is a bounded logical scan, not a transaction spanning HTTP requests.
 * The caller must retain stableBackup's independent double scan and the
 * maintenance gate. Any incomplete page, schema/count change or unknown
 * virtual table fails closed; there is no alternate storage fallback.
 */
const qi = value => '"' + String(value).replaceAll('"', '""') + '"';
const qs = value => "'" + String(value).replaceAll("'", "''") + "'";
const ROWS = 32;
const INLINE_BYTES = 24 * 1024;
const CHUNK_BYTES = 24 * 1024;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const fail = (code, text) => { throw new Error(code + '：' + text); };
const managed = name => name.startsWith('_cf_') || (name.startsWith('sqlite_') && name !== 'sqlite_sequence');

function valueSQL(column) {
  return `CASE typeof(${column})
    WHEN 'null' THEN 'NULL'
    WHEN 'integer' THEN CAST(${column} AS TEXT)
    WHEN 'real' THEN CASE
      WHEN ${column} > 1.7976931348623157e308 THEN '9.0e999'
      WHEN ${column} < -1.7976931348623157e308 THEN '-9.0e999'
      ELSE printf('%!.26g', ${column}) END
    WHEN 'text' THEN ${qs("CAST(X'")} || hex(CAST(${column} AS BLOB)) || ${qs("' AS TEXT)")}
    WHEN 'blob' THEN ${qs("X'")} || hex(${column}) || ${qs("'")}
    ELSE NULL END`;
}
function integerCount(text) {
  if (typeof text !== 'string' || !/^(0|[1-9][0-9]*)$/.test(text) || !Number.isSafeInteger(Number(text))) {
    fail('ST_D1_SNAPSHOT_RESPONSE', '無效的 D1 筆數或位元組數，未建立不完整備份');
  }
  return Number(text);
}
function schemaObject(row) {
  if (!row || !['table', 'index', 'view', 'trigger'].includes(row.type) ||
      typeof row.name !== 'string' || typeof row.tbl_name !== 'string' ||
      !(row.sql === null || typeof row.sql === 'string')) {
    fail('ST_D1_SNAPSHOT_SCHEMA', 'D1 結構回應不完整');
  }
  return {type:row.type, name:row.name, tbl_name:row.tbl_name, sql:row.sql};
}
const terminate = sql => sql.trimEnd().replace(/;\s*$/, '') + ';';

export async function snapshotD1WithQueries(cf, id, {pageSize=ROWS, maxBytes=DEFAULT_MAX_BYTES}={}) {
  if (!/^[a-fA-F0-9-]{36}$/.test(id || '')) fail('ST_D1_SNAPSHOT_CONFIG', '無效的原 D1 ID');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > ROWS ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1) fail('ST_D1_SNAPSHOT_CONFIG', '無效的備份限制');
  const endpoint = '/d1/database/' + encodeURIComponent(id) + '/query';
  let usedBytes = 0;
  const lines = [];
  const add = line => {
    usedBytes += Buffer.byteLength(line, 'utf8') + 1;
    if (usedBytes > maxBytes) fail('ST_D1_SNAPSHOT_SIZE', 'SQL 邏輯備份超過64MiB保護上限；保留原資料，不轉用其他儲存');
    lines.push(line);
  };
  async function query(sql, params=[]) {
    if (Buffer.byteLength(sql, 'utf8') > 100000 || params.length > 100) fail('ST_D1_SNAPSHOT_SIZE', '查詢超過 D1 語句限制');
    const data = await cf.request(endpoint, {method:'POST', body:{sql, params}});
    if (!Array.isArray(data?.result) || data.result.length !== 1 ||
        data.result[0]?.success !== true || !Array.isArray(data.result[0]?.results)) {
      fail('ST_D1_SNAPSHOT_RESPONSE', 'D1 查詢失敗或回傳不完整，未继续備份');
    }
    return data.result[0].results;
  }
  async function schema() {
    return (await query('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type COLLATE BINARY,name COLLATE BINARY'))
      .map(schemaObject).filter(row => !managed(row.name) && !managed(row.tbl_name));
  }
  async function count(name) {
    const rows = await query(`SELECT CAST(COUNT(*) AS TEXT) AS n FROM ${qi(name)}`);
    if (rows.length !== 1) fail('ST_D1_SNAPSHOT_RESPONSE', '無效的資料表計數');
    return integerCount(rows[0].n);
  }
  const beforeSchema = await schema();
  const allTableRows = await query('PRAGMA table_list');
  const tableList = new Map(allTableRows.filter(r => r.schema === 'main').map(r => [r.name,r]));
  const tables = beforeSchema.filter(r => r.type === 'table' && r.name !== 'sqlite_sequence');
  const sequence = beforeSchema.find(r => r.type === 'table' && r.name === 'sqlite_sequence');
  const catalog = [];
  // Validate the entire schema before reading any row. Never silently omit FTS/virtual content.
  for (const table of [...tables, ...(sequence ? [sequence] : [])]) {
    const info = tableList.get(table.name);
    if (!info || info.type !== 'table' || ![0,1].includes(info.wr) || !table.sql ||
        /^\s*CREATE\s+VIRTUAL\b/i.test(table.sql)) {
      fail('ST_D1_SCHEMA_UNSUPPORTED', '原 D1 含虛擬表、影子表或未知結構；不省略資料、不改寫原表');
    }
    const columns = await query(`PRAGMA table_xinfo(${qi(table.name)})`);
    if (!columns.length || columns.length !== info.ncol || columns.some(c => typeof c.name !== 'string' ||
        !Number.isInteger(c.cid) || ![0,2,3].includes(c.hidden))) {
      fail('ST_D1_SCHEMA_UNSUPPORTED', 'D1 欄位結構無法完整讀取');
    }
    const plain = columns.filter(c => c.hidden === 0).sort((a,b) => a.cid-b.cid);
    if (!plain.length) fail('ST_D1_SCHEMA_UNSUPPORTED', '資料表沒有可還原欄位');
    let rowid = null;
    if (!info.wr) {
      const names = new Set(columns.map(c => c.name.toLowerCase()));
      rowid = ['_rowid_', 'rowid', 'oid'].find(c => !names.has(c));
      if (!rowid) fail('ST_D1_SCHEMA_UNSUPPORTED', '三種 rowid 別名均被遮蔽，無法保證逐列完整還原');
    }
    const pk = columns.filter(c => c.pk > 0).sort((a,b) => a.pk-b.pk);
    if (info.wr && !pk.length) fail('ST_D1_SCHEMA_UNSUPPORTED', 'WITHOUT ROWID 資料表缺少穩定主鍵');
    const names = [...(rowid ? [rowid] : []), ...plain.map(c => c.name)];
    const order = rowid ? qi(rowid) : pk.map(c => qi(c.name)).join(',');
    const total = await count(table.name);
    catalog.push({table, names, rowid, order, total});
  }
  add('-- SubsTracker D1 query-only logical snapshot v1; no external download.');
  add('-- D1-managed _cf_* and SQLite optimizer tables are not application records.');
  add('PRAGMA foreign_keys=OFF;');
  add('BEGIN TRANSACTION;');
  for (const table of tables) add(terminate(table.sql));
  for (const {table,names,rowid,order,total} of catalog) {
    const from = qi(table.name);
    if (table.name === 'sqlite_sequence') add('DELETE FROM sqlite_sequence;');
    const prefix = `INSERT INTO ${from}(${names.map(qi).join(',')}) VALUES(`;
    const rowSQL = [qs(prefix), ...names.flatMap((name,i) => [i ? qs(',') : qs(''), valueSQL(qi(name))]), qs(');')].join(' || ');
    const sizeSQL = names.map(name => `coalesce(length(CAST(${qi(name)} AS BLOB)),0)`).join(' + ');
    const rowidSQL = rowid ? `CAST(${qi(rowid)} AS TEXT)` : 'NULL';
    let lastRowid = null;
    for (let offset=0; offset<total; offset+=pageSize) {
      const limit = Math.min(pageSize, total-offset);
      // Ordinary application tables use the indexed rowid cursor rather than rereading
      // all preceding pages. WITHOUT ROWID tables retain explicit stable PK ordering.
      const paging = rowid
        ? `${lastRowid === null ? '' : `WHERE ${qi(rowid)}>CAST(? AS INTEGER)`} ORDER BY ${order} LIMIT ?`
        : `ORDER BY ${order} LIMIT ? OFFSET ?`;
      const params = rowid ? (lastRowid === null ? [limit] : [lastRowid.toString(),limit]) : [limit,offset];
      const rows = await query(`SELECT ${rowidSQL} AS st_rowid,
        CASE WHEN (${sizeSQL}) <= ${INLINE_BYTES} THEN (${rowSQL}) ELSE NULL END AS st_insert
        FROM ${from} ${paging}`, params);
      if (rows.length !== limit) fail('ST_D1_SNAPSHOT_CHANGED', 'D1 分頁缺少資料；原資料仍在變動或回應遭截斷');
      for (let i=0; i<rows.length; i++) {
        const row = rows[i];
        if (rowid) {
          if (typeof row.st_rowid !== 'string' || !/^-?(0|[1-9][0-9]*)$/.test(row.st_rowid)) fail('ST_D1_SNAPSHOT_RESPONSE', '資料列定位不完整');
          const current = BigInt(row.st_rowid);
          if (lastRowid !== null && current <= lastRowid) fail('ST_D1_SNAPSHOT_CHANGED', 'D1 分頁重複或未前進');
          lastRowid = current;
        }
        if (typeof row.st_insert === 'string' && row.st_insert.startsWith(prefix) && row.st_insert.endsWith(');')) {
          add(row.st_insert);
        } else if (row.st_insert === null) {
          // Bounded reads for large TEXT/BLOB: each response contains <=24KiB raw bytes per cell chunk.
          const locator = rowid ? `WHERE ${qi(rowid)}=CAST(? AS INTEGER)` : `ORDER BY ${order} LIMIT 1 OFFSET ?`;
          const locateParams = [rowid ? row.st_rowid : offset+i];
          const values = [];
          for (const name of names) {
            const col = qi(name);
            const meta = await query(`SELECT typeof(${col}) AS kind,
              CAST(coalesce(length(CAST(${col} AS BLOB)),0) AS TEXT) AS n,
              CASE WHEN typeof(${col}) IN ('integer','real','null') THEN ${valueSQL(col)} ELSE NULL END AS literal
              FROM ${from} ${locator}`, locateParams);
            if (meta.length !== 1) fail('ST_D1_SNAPSHOT_CHANGED', '讀取大型資料列時原列消失');
            const {kind,n,literal} = meta[0];
            if (['integer','real','null'].includes(kind)) {
              if (typeof literal !== 'string' || !/^(?:NULL|[-+0-9.eE]+)$/.test(literal)) fail('ST_D1_SNAPSHOT_RESPONSE', '數字型別回應不完整');
              values.push(literal);
            } else if (kind === 'text' || kind === 'blob') {
              const length = integerCount(n);
              if (length * 2 + usedBytes > maxBytes) fail('ST_D1_SNAPSHOT_SIZE', '大型欄位超過備份保護上限');
              let hex = '';
              for (let pos=0; pos<length; pos+=CHUNK_BYTES) {
                const bytes = Math.min(CHUNK_BYTES,length-pos);
                const parts = await query(`SELECT hex(substr(CAST(${col} AS BLOB),?,?)) AS chunk,
                  typeof(${col}) AS kind, CAST(length(CAST(${col} AS BLOB)) AS TEXT) AS n
                  FROM ${from} ${locator}`, [pos+1,bytes,...locateParams]);
                if (parts.length !== 1 || parts[0].kind !== kind || parts[0].n !== n ||
                    typeof parts[0].chunk !== 'string' || !/^[0-9A-F]*$/.test(parts[0].chunk) || parts[0].chunk.length !== bytes*2) {
                  fail('ST_D1_SNAPSHOT_CHANGED', '大型欄位分片不完整或讀取期间變更');
                }
                hex += parts[0].chunk;
              }
              values.push(kind === 'text' ? `CAST(X'${hex}' AS TEXT)` : `X'${hex}'`);
            } else fail('ST_D1_SNAPSHOT_RESPONSE', '未知 SQLite 值型別');
          }
          add(prefix + values.join(',') + ');');
        } else fail('ST_D1_SNAPSHOT_RESPONSE', 'D1 資料列編碼不完整');
      }
    }
    if (await count(table.name) !== total) fail('ST_D1_SNAPSHOT_CHANGED', '備份期間 D1 筆數變更，已停止');
  }
  // Create triggers after data, so restore cannot duplicate audit/history rows.
  for (const type of ['index','view','trigger']) {
    for (const row of beforeSchema.filter(r => r.type === type && r.sql !== null)) add(terminate(row.sql));
  }
  if (JSON.stringify(beforeSchema) !== JSON.stringify(await schema())) fail('ST_D1_SNAPSHOT_CHANGED', '備份期間 D1 結構變更，已停止');
  add('COMMIT;');
  return lines.join('\n') + '\n';
}
