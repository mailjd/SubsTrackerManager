/** Additive-only schema for web init. Definitions are pinned to the supplied
 * v3.3.31 application's modern schema. NEVER calls legacy DROP/REPLACE migrations.
 */
export const WEB_SCHEMA_OBJECTS=Object.freeze([
  {
    "type": "table",
    "name": "account_credentials",
    "tbl_name": "account_credentials",
    "sql": "CREATE TABLE IF NOT EXISTS account_credentials (\n        account TEXT NOT NULL,\n        credential_type TEXT NOT NULL,\n        password_encrypted TEXT NOT NULL DEFAULT '',\n        created_at TEXT NOT NULL,\n        updated_at TEXT NOT NULL,\n        PRIMARY KEY (account, credential_type),\n        FOREIGN KEY (account) REFERENCES accounts(account) ON UPDATE CASCADE ON DELETE CASCADE\n      )",
    "columns": [
      {
        "cid": 0,
        "name": "account",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": null,
        "pk": 1
      },
      {
        "cid": 1,
        "name": "credential_type",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": null,
        "pk": 2
      },
      {
        "cid": 2,
        "name": "password_encrypted",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": "''",
        "pk": 0
      },
      {
        "cid": 3,
        "name": "created_at",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 4,
        "name": "updated_at",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": null,
        "pk": 0
      }
    ]
  },
  {
    "type": "table",
    "name": "account_database_backups",
    "tbl_name": "account_database_backups",
    "sql": "CREATE TABLE IF NOT EXISTS account_database_backups (\n        backup_id INTEGER PRIMARY KEY AUTOINCREMENT,\n        created_at TEXT NOT NULL,\n        reason TEXT NOT NULL DEFAULT 'full_overwrite_import',\n        account_count INTEGER NOT NULL DEFAULT 0,\n        source_filename TEXT NOT NULL DEFAULT '',\n        snapshot_json TEXT NOT NULL\n      )",
    "columns": [
      {
        "cid": 0,
        "name": "backup_id",
        "type": "INTEGER",
        "notnull": 0,
        "dflt_value": null,
        "pk": 1
      },
      {
        "cid": 1,
        "name": "created_at",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 2,
        "name": "reason",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": "'full_overwrite_import'",
        "pk": 0
      },
      {
        "cid": 3,
        "name": "account_count",
        "type": "INTEGER",
        "notnull": 1,
        "dflt_value": "0",
        "pk": 0
      },
      {
        "cid": 4,
        "name": "source_filename",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": "''",
        "pk": 0
      },
      {
        "cid": 5,
        "name": "snapshot_json",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": null,
        "pk": 0
      }
    ]
  },
  {
    "type": "table",
    "name": "account_history",
    "tbl_name": "account_history",
    "sql": "CREATE TABLE IF NOT EXISTS account_history (\n        history_id INTEGER PRIMARY KEY AUTOINCREMENT,\n        account_serial TEXT NOT NULL,\n        action TEXT NOT NULL,\n        changed_at TEXT NOT NULL,\n        account TEXT NOT NULL,\n        has_password INTEGER NOT NULL DEFAULT 0,\n        metadata_json TEXT\n      )",
    "columns": [
      {
        "cid": 0,
        "name": "history_id",
        "type": "INTEGER",
        "notnull": 0,
        "dflt_value": null,
        "pk": 1
      },
      {
        "cid": 1,
        "name": "account_serial",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 2,
        "name": "action",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 3,
        "name": "changed_at",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 4,
        "name": "account",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 5,
        "name": "has_password",
        "type": "INTEGER",
        "notnull": 1,
        "dflt_value": "0",
        "pk": 0
      },
      {
        "cid": 6,
        "name": "metadata_json",
        "type": "TEXT",
        "notnull": 0,
        "dflt_value": null,
        "pk": 0
      }
    ]
  },
  {
    "type": "table",
    "name": "accounts",
    "tbl_name": "accounts",
    "sql": "CREATE TABLE IF NOT EXISTS accounts (\n        account TEXT PRIMARY KEY,\n        account_serial TEXT NOT NULL,\n        password_encrypted TEXT NOT NULL DEFAULT '',\n        source_subscription_id TEXT,\n        created_at TEXT NOT NULL,\n        updated_at TEXT NOT NULL,\n        real_name TEXT NOT NULL DEFAULT '',\n        account_type TEXT NOT NULL DEFAULT ''\n      , owner_type TEXT NOT NULL DEFAULT '')",
    "columns": [
      {
        "cid": 0,
        "name": "account",
        "type": "TEXT",
        "notnull": 0,
        "dflt_value": null,
        "pk": 1
      },
      {
        "cid": 1,
        "name": "account_serial",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 2,
        "name": "password_encrypted",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": "''",
        "pk": 0
      },
      {
        "cid": 3,
        "name": "source_subscription_id",
        "type": "TEXT",
        "notnull": 0,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 4,
        "name": "created_at",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 5,
        "name": "updated_at",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 6,
        "name": "real_name",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": "''",
        "pk": 0
      },
      {
        "cid": 7,
        "name": "account_type",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": "''",
        "pk": 0
      },
      {
        "cid": 8,
        "name": "owner_type",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": "''",
        "pk": 0
      }
    ]
  },
  {
    "type": "table",
    "name": "menu_option_groups",
    "tbl_name": "menu_option_groups",
    "sql": "CREATE TABLE IF NOT EXISTS menu_option_groups (\n        group_key TEXT PRIMARY KEY,\n        initialized_at TEXT NOT NULL,\n        updated_at TEXT NOT NULL\n      )",
    "columns": [
      {
        "cid": 0,
        "name": "group_key",
        "type": "TEXT",
        "notnull": 0,
        "dflt_value": null,
        "pk": 1
      },
      {
        "cid": 1,
        "name": "initialized_at",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 2,
        "name": "updated_at",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": null,
        "pk": 0
      }
    ]
  },
  {
    "type": "table",
    "name": "menu_options",
    "tbl_name": "menu_options",
    "sql": "CREATE TABLE IF NOT EXISTS menu_options (\n        group_key TEXT NOT NULL,\n        value TEXT NOT NULL,\n        sort_order INTEGER NOT NULL DEFAULT 0,\n        created_at TEXT NOT NULL,\n        updated_at TEXT NOT NULL,\n        PRIMARY KEY (group_key, value),\n        FOREIGN KEY (group_key) REFERENCES menu_option_groups(group_key) ON DELETE CASCADE\n      )",
    "columns": [
      {
        "cid": 0,
        "name": "group_key",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": null,
        "pk": 1
      },
      {
        "cid": 1,
        "name": "value",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": null,
        "pk": 2
      },
      {
        "cid": 2,
        "name": "sort_order",
        "type": "INTEGER",
        "notnull": 1,
        "dflt_value": "0",
        "pk": 0
      },
      {
        "cid": 3,
        "name": "created_at",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 4,
        "name": "updated_at",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": null,
        "pk": 0
      }
    ]
  },
  {
    "type": "table",
    "name": "schema_meta",
    "tbl_name": "schema_meta",
    "sql": "CREATE TABLE IF NOT EXISTS schema_meta (\n        key TEXT PRIMARY KEY,\n        value TEXT NOT NULL,\n        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))\n      )",
    "columns": [
      {
        "cid": 0,
        "name": "key",
        "type": "TEXT",
        "notnull": 0,
        "dflt_value": null,
        "pk": 1
      },
      {
        "cid": 1,
        "name": "value",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 2,
        "name": "updated_at",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": "strftime('%Y-%m-%dT%H:%M:%fZ','now')",
        "pk": 0
      }
    ]
  },
  {
    "type": "table",
    "name": "subscription_history",
    "tbl_name": "subscription_history",
    "sql": "CREATE TABLE IF NOT EXISTS subscription_history (\n        history_id INTEGER PRIMARY KEY AUTOINCREMENT,\n        subscription_id TEXT NOT NULL,\n        action TEXT NOT NULL,\n        changed_at TEXT NOT NULL,\n        name TEXT,\n        account TEXT,\n        account_serial TEXT,\n        snapshot_json TEXT NOT NULL,\n        metadata_json TEXT\n      )",
    "columns": [
      {
        "cid": 0,
        "name": "history_id",
        "type": "INTEGER",
        "notnull": 0,
        "dflt_value": null,
        "pk": 1
      },
      {
        "cid": 1,
        "name": "subscription_id",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 2,
        "name": "action",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 3,
        "name": "changed_at",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 4,
        "name": "name",
        "type": "TEXT",
        "notnull": 0,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 5,
        "name": "account",
        "type": "TEXT",
        "notnull": 0,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 6,
        "name": "account_serial",
        "type": "TEXT",
        "notnull": 0,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 7,
        "name": "snapshot_json",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 8,
        "name": "metadata_json",
        "type": "TEXT",
        "notnull": 0,
        "dflt_value": null,
        "pk": 0
      }
    ]
  },
  {
    "type": "table",
    "name": "subscription_ledger",
    "tbl_name": "subscription_ledger",
    "sql": "CREATE TABLE IF NOT EXISTS subscription_ledger (\n        entry_id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, source TEXT NOT NULL,\n        occurred_at TEXT NOT NULL, created_at TEXT NOT NULL, snapshot_json TEXT NOT NULL,\n        input_hash TEXT NOT NULL DEFAULT ''\n      )",
    "columns": [
      {
        "cid": 0,
        "name": "entry_id",
        "type": "TEXT",
        "notnull": 0,
        "dflt_value": null,
        "pk": 1
      },
      {
        "cid": 1,
        "name": "subscription_id",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 2,
        "name": "source",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 3,
        "name": "occurred_at",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 4,
        "name": "created_at",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 5,
        "name": "snapshot_json",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 6,
        "name": "input_hash",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": "''",
        "pk": 0
      }
    ]
  },
  {
    "type": "table",
    "name": "subscriptions_current",
    "tbl_name": "subscriptions_current",
    "sql": "CREATE TABLE IF NOT EXISTS subscriptions_current (\n        id TEXT PRIMARY KEY,\n        name TEXT NOT NULL,\n        custom_type TEXT,\n        category TEXT,\n        member_level TEXT,\n        points REAL,\n        account TEXT,\n        account_serial TEXT,\n        users TEXT,\n        amount REAL,\n        currency TEXT,\n        period_value REAL,\n        period_unit TEXT,\n        expiry_date TEXT,\n        is_active INTEGER NOT NULL DEFAULT 1,\n        auto_renew INTEGER NOT NULL DEFAULT 1,\n        has_password INTEGER NOT NULL DEFAULT 0,\n        data_json TEXT NOT NULL,\n        created_at TEXT,\n        updated_at TEXT,\n        synced_at TEXT NOT NULL\n      )",
    "columns": [
      {
        "cid": 0,
        "name": "id",
        "type": "TEXT",
        "notnull": 0,
        "dflt_value": null,
        "pk": 1
      },
      {
        "cid": 1,
        "name": "name",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 2,
        "name": "custom_type",
        "type": "TEXT",
        "notnull": 0,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 3,
        "name": "category",
        "type": "TEXT",
        "notnull": 0,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 4,
        "name": "member_level",
        "type": "TEXT",
        "notnull": 0,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 5,
        "name": "points",
        "type": "REAL",
        "notnull": 0,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 6,
        "name": "account",
        "type": "TEXT",
        "notnull": 0,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 7,
        "name": "account_serial",
        "type": "TEXT",
        "notnull": 0,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 8,
        "name": "users",
        "type": "TEXT",
        "notnull": 0,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 9,
        "name": "amount",
        "type": "REAL",
        "notnull": 0,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 10,
        "name": "currency",
        "type": "TEXT",
        "notnull": 0,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 11,
        "name": "period_value",
        "type": "REAL",
        "notnull": 0,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 12,
        "name": "period_unit",
        "type": "TEXT",
        "notnull": 0,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 13,
        "name": "expiry_date",
        "type": "TEXT",
        "notnull": 0,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 14,
        "name": "is_active",
        "type": "INTEGER",
        "notnull": 1,
        "dflt_value": "1",
        "pk": 0
      },
      {
        "cid": 15,
        "name": "auto_renew",
        "type": "INTEGER",
        "notnull": 1,
        "dflt_value": "1",
        "pk": 0
      },
      {
        "cid": 16,
        "name": "has_password",
        "type": "INTEGER",
        "notnull": 1,
        "dflt_value": "0",
        "pk": 0
      },
      {
        "cid": 17,
        "name": "data_json",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 18,
        "name": "created_at",
        "type": "TEXT",
        "notnull": 0,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 19,
        "name": "updated_at",
        "type": "TEXT",
        "notnull": 0,
        "dflt_value": null,
        "pk": 0
      },
      {
        "cid": 20,
        "name": "synced_at",
        "type": "TEXT",
        "notnull": 1,
        "dflt_value": null,
        "pk": 0
      }
    ]
  },
  {
    "type": "index",
    "name": "idx_account_credentials_type",
    "tbl_name": "account_credentials",
    "sql": "CREATE INDEX IF NOT EXISTS idx_account_credentials_type ON account_credentials(credential_type)"
  },
  {
    "type": "index",
    "name": "idx_account_database_backups_created_at",
    "tbl_name": "account_database_backups",
    "sql": "CREATE INDEX IF NOT EXISTS idx_account_database_backups_created_at ON account_database_backups(created_at DESC)"
  },
  {
    "type": "index",
    "name": "idx_account_history_serial_time",
    "tbl_name": "account_history",
    "sql": "CREATE INDEX IF NOT EXISTS idx_account_history_serial_time ON account_history(account_serial, changed_at DESC)"
  },
  {
    "type": "index",
    "name": "idx_accounts_account",
    "tbl_name": "accounts",
    "sql": "CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_account ON accounts(account)"
  },
  {
    "type": "index",
    "name": "idx_accounts_account_serial",
    "tbl_name": "accounts",
    "sql": "CREATE INDEX IF NOT EXISTS idx_accounts_account_serial ON accounts(account_serial)"
  },
  {
    "type": "index",
    "name": "idx_accounts_account_type",
    "tbl_name": "accounts",
    "sql": "CREATE INDEX IF NOT EXISTS idx_accounts_account_type ON accounts(account_type)"
  },
  {
    "type": "index",
    "name": "idx_accounts_real_name",
    "tbl_name": "accounts",
    "sql": "CREATE INDEX IF NOT EXISTS idx_accounts_real_name ON accounts(real_name)"
  },
  {
    "type": "index",
    "name": "idx_accounts_serial_unique_except_voice_supplier",
    "tbl_name": "accounts",
    "sql": "CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_serial_unique_except_voice_supplier ON accounts(account_serial) WHERE account_serial <> '配音供应商'"
  },
  {
    "type": "index",
    "name": "idx_accounts_updated_at",
    "tbl_name": "accounts",
    "sql": "CREATE INDEX IF NOT EXISTS idx_accounts_updated_at ON accounts(updated_at DESC)"
  },
  {
    "type": "index",
    "name": "idx_menu_options_group_sort",
    "tbl_name": "menu_options",
    "sql": "CREATE INDEX IF NOT EXISTS idx_menu_options_group_sort ON menu_options(group_key, sort_order ASC)"
  },
  {
    "type": "index",
    "name": "idx_subscription_history_action_time",
    "tbl_name": "subscription_history",
    "sql": "CREATE INDEX IF NOT EXISTS idx_subscription_history_action_time ON subscription_history(action, changed_at DESC)"
  },
  {
    "type": "index",
    "name": "idx_subscription_history_sub_time",
    "tbl_name": "subscription_history",
    "sql": "CREATE INDEX IF NOT EXISTS idx_subscription_history_sub_time ON subscription_history(subscription_id, changed_at DESC)"
  },
  {
    "type": "index",
    "name": "idx_subscription_ledger_sub",
    "tbl_name": "subscription_ledger",
    "sql": "CREATE INDEX IF NOT EXISTS idx_subscription_ledger_sub ON subscription_ledger(subscription_id)"
  },
  {
    "type": "index",
    "name": "idx_subscription_ledger_time",
    "tbl_name": "subscription_ledger",
    "sql": "CREATE INDEX IF NOT EXISTS idx_subscription_ledger_time ON subscription_ledger(occurred_at DESC, entry_id)"
  },
  {
    "type": "index",
    "name": "idx_subscriptions_current_account",
    "tbl_name": "subscriptions_current",
    "sql": "CREATE INDEX IF NOT EXISTS idx_subscriptions_current_account ON subscriptions_current(account)"
  },
  {
    "type": "index",
    "name": "idx_subscriptions_current_account_serial",
    "tbl_name": "subscriptions_current",
    "sql": "CREATE INDEX IF NOT EXISTS idx_subscriptions_current_account_serial ON subscriptions_current(account_serial)"
  },
  {
    "type": "index",
    "name": "idx_subscriptions_current_expiry_date",
    "tbl_name": "subscriptions_current",
    "sql": "CREATE INDEX IF NOT EXISTS idx_subscriptions_current_expiry_date ON subscriptions_current(expiry_date)"
  },
  {
    "type": "index",
    "name": "idx_subscriptions_current_name",
    "tbl_name": "subscriptions_current",
    "sql": "CREATE INDEX IF NOT EXISTS idx_subscriptions_current_name ON subscriptions_current(name)"
  }
]);

const optionalAccountColumns=new Set(['real_name','account_type','owner_type']);
function conflict(message){const e=new Error(message);e.code='INIT_SCHEMA_CONFLICT';throw e;}
/** Read-only plan. Unsupported existing layouts stop BEFORE any CREATE or ALTER. */
export async function inspectWebSchema(db){
  const response=await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all();
  if(response.success===false||!Array.isArray(response.results))conflict('D1 結構讀取不完整。');
  const objects=new Map(response.results.map(o=>[o.name,o]));
  if(response.results.some(o=>o.type==='trigger'&&['subscription_ledger','schema_meta','__substracker_web_init_v1'].includes(o.tbl_name)))conflict('待更新資料表含自訂 trigger；為避免連帶寫入，已停止。');
  const sql=[], changes=[],signature=[];
  for(const spec of WEB_SCHEMA_OBJECTS.filter(o=>o.type==='table')){
    const old=objects.get(spec.name);
    if(!old){sql.push(spec.sql);changes.push('新增缺少的資料表：'+spec.name);continue;}
    if(old.type!=='table')conflict(spec.name+' 不是資料表，不能覆蓋。');
    const info=await db.prepare('PRAGMA table_info("'+spec.name+'")').all();
    if(info.success===false||!Array.isArray(info.results))conflict('無法讀取欄位：'+spec.name);
    signature.push([spec.name,info.results]);
    const actual=new Map(info.results.map(c=>[c.name,c]));
    const expectedPk=spec.columns.filter(c=>c.pk).map(c=>[c.name,Number(c.pk)]).sort();
    const actualPk=info.results.filter(c=>c.pk).map(c=>[c.name,Number(c.pk)]).sort();
    if(JSON.stringify(actualPk)!==JSON.stringify(expectedPk))conflict(spec.name+' 主鍵與現行結構不符；本版不執行刪表重建。');
    for(const column of spec.columns){
      const found=actual.get(column.name);
      if(!found){
        if(spec.name==='accounts'&&optionalAccountColumns.has(column.name)){
          sql.push('ALTER TABLE accounts ADD COLUMN '+column.name+" TEXT NOT NULL DEFAULT ''");changes.push('新增帳號欄位：'+column.name);
        }else conflict(spec.name+' 缺少必要欄位 '+column.name+'，不能推測原資料格式。');
      }else if(String(found.type).toUpperCase()!==String(column.type).toUpperCase())conflict(spec.name+'.'+column.name+' 型別不符，未改寫原欄位。');
    }
    if(spec.name==='account_credentials'&&actual.has('account_serial'))conflict('舊 account_credentials 結構需改主鍵；本 init 不執行破壞性遷移。');
  }
  for(const spec of WEB_SCHEMA_OBJECTS.filter(o=>o.type==='index')){
    const old=objects.get(spec.name);
    if(old&&old.type!=='index')conflict('同名索引物件不符：'+spec.name);
    const norm=x=>String(x).replace(/IF NOT EXISTS/ig,'').replace(/[\s;]+/g,'').toLowerCase();
    if(old&&(old.tbl_name!==spec.tbl_name||norm(old.sql)!==norm(spec.sql)))conflict('原索引定義與現行結構不同：'+spec.name+'；沒有刪除或重建原索引。');
    if(!old){sql.push(spec.sql);changes.push('新增缺少的索引：'+spec.name);}
  }
  return {sql,changes,signature};
}
