#!/usr/bin/env node
/** Local test-fixture I/O, NOT an HTTP endpoint or a Cloudflare storage client.
 * Reads an existing SQLite file using the same Node runtime as the upgrade tool.
 * The Python test coordinator never imports sqlite3 or installs native packages.
 */
import fs from 'node:fs';
import path from 'node:path';
const LIMIT = 16 * 1024 * 1024;
function fail(message) { throw new Error(message); }
function decode(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Invalid typed SQL parameter');
  switch (value.type) {
    case 'null': return null;
    case 'text': if (typeof value.value === 'string') return value.value; break;
    case 'integer':
      if (typeof value.value === 'string' && /^-?\d+$/.test(value.value)) {
        const n = BigInt(value.value);
        if (n >= -(2n**63n) && n < 2n**63n) return n;
      }
      break;
    case 'real': if (typeof value.value === 'number' && Number.isFinite(value.value)) return value.value; break;
    case 'blob':
      if (typeof value.value === 'string') {
        const b = Buffer.from(value.value, 'base64');
        if (b.toString('base64') === value.value) return b;
      }
      break;
  }
  fail('Unsupported or out-of-range SQL parameter');
}
function encode(value) {
  if (value === null) return {type:'null'};
  if (typeof value === 'bigint') return {type:'integer',value:value.toString()};
  if (typeof value === 'string') return {type:'text',value};
  if (typeof value === 'number' && Number.isFinite(value)) return {type:'real',value};
  if (value instanceof Uint8Array) return {type:'blob',value:Buffer.from(value).toString('base64')};
  fail('Unsupported SQLite result type');
}
let db;
try {
  // No external SQLite package, Python extension, shell, or network fallback.
  const {DatabaseSync} = await import('node:sqlite');
  const raw = fs.readFileSync(0, 'utf8');
  if (Buffer.byteLength(raw) > LIMIT) fail('Local test request exceeds size limit');
  const input = JSON.parse(raw);
  if (input.protocol !== 1 || !['read','fixture-transaction'].includes(input.mode)) fail('Invalid local test protocol');
  if (typeof input.database !== 'string' || !path.isAbsolute(input.database)) fail('Existing absolute fixture path required');
  const stat = fs.lstatSync(input.database);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('Database must be an existing regular local fixture, not a link');
  if (!Array.isArray(input.statements) || input.statements.length < 1 || input.statements.length > 64) fail('Invalid statement count');
  const writing = input.mode === 'fixture-transaction';
  if (writing && input.fixtureWrites !== true) fail('Fixture writes require explicit acknowledgement');
  db = new DatabaseSync(input.database, {readOnly:!writing,enableForeignKeyConstraints:false});
  db.exec('PRAGMA busy_timeout=5000');
  if (!writing) { db.exec('PRAGMA query_only=ON'); db.exec('BEGIN'); }
  else db.exec('BEGIN IMMEDIATE');
  const results = [];
  try {
    for (const operation of input.statements) {
      if (!operation || typeof operation.sql !== 'string' || !Array.isArray(operation.params)) fail('Invalid statement');
      // Only fixture DML is needed by the cross-version audit. Do not accept DDL,
      // ATTACH, PRAGMA writes or multi-statement scripts in this test bridge.
      if (writing && !/^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(operation.sql)) fail('Only fixture DML is supported');
      if (!writing && !/^\s*(?:SELECT|WITH|PRAGMA\s+(?:table_info|table_xinfo|integrity_check|quick_check|foreign_key_check)\b)/i.test(operation.sql)) fail('Only read queries are supported');
      const stmt = db.prepare(operation.sql);
      if (stmt.sourceSQL.trim() !== operation.sql.trim()) fail('Exactly one complete SQL statement is required');
      stmt.setReadBigInts(true);
      const params = operation.params.map(decode);
      if (writing) {
        const result = stmt.run(...params);
        results.push({changes:encode(result.changes),lastInsertRowid:encode(result.lastInsertRowid)});
      } else {
        // Some Node 22.x SQLite builds truncate TEXT at NUL on direct reads.
        // Encode text/blob in SQL before it crosses the SQLite->JS boundary.
        const columns = typeof stmt.columns === 'function' ? stmt.columns().map(c=>c.name) : Object.keys(stmt.get(...params) || {});
        if (new Set(columns).size !== columns.length) fail('Duplicate result columns require explicit aliases');
        let rows;
        if (/^\s*PRAGMA\b/i.test(operation.sql)) {
          // Only schema/health pragmas above are allowed, never application text.
          rows = stmt.all(...params).map(row=>columns.map(name=>encode(row[name])));
        } else if (!columns.length) {
          rows = [];
        } else {
          const quote=name=>'"'+name.replaceAll('"','""')+'"';
          const projection=columns.map((name,i)=>{
            const c=quote(name);
            return `typeof(${c}) AS "__t${i}", CASE WHEN typeof(${c}) IN ('text','blob') THEN hex(CAST(${c} AS BLOB)) ELSE ${c} END AS "__v${i}"`;
          }).join(',');
          const sql=operation.sql.trim().replace(/;$/, '');
          const safe=db.prepare(`SELECT ${projection} FROM (${sql}) AS "__st_read"`);
          safe.setReadBigInts(true);
          rows=safe.all(...params).map(row=>columns.map((_,i)=>{
            const type=row['__t'+i], value=row['__v'+i];
            if(type==='text') return {type:'text',value:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.from(value,'hex'))};
            if(type==='blob') return {type:'blob',value:Buffer.from(value,'hex').toString('base64')};
            return encode(value);
          }));
        }
        results.push({columns,rows});
      }
    }
    const output = JSON.stringify({protocol:1,ok:true,results});
    if (Buffer.byteLength(output) > LIMIT) fail('Local test response exceeds size limit');
    db.exec('COMMIT');
    db.close(); db = undefined;
    process.stdout.write(output+'\n');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
} catch (error) {
  // A real fixture read/SQL failure MUST fail its test. Never return an empty
  // success result or a synthetic storage value to let the release gate pass.
  process.stderr.write('[test-sqlite] ST_TEST_SQLITE '+error.message+'\n');
  process.exitCode = 1;
} finally {
  if (db) { try { db.close(); } catch {} }
}
