// @ts-check
/**
 * D1 运行时兜底建表。
 *
 * 正常部署仍应执行 migrations；这里用于 Cloudflare Git 直连部署、
 * 手动 wrangler deploy 或迁移遗漏时自动补齐基础表，避免页面直接报
 * "no such table"。所有语句均为 CREATE ... IF NOT EXISTS，可重复执行。
 */

let schemaReadyPromise = null;

/** @param {any} env */
export function hasD1Binding(env) {
  return !!(env && env.SUBSCRIPTIONS_DB && typeof env.SUBSCRIPTIONS_DB.prepare === 'function');
}

/** @param {any} env */
export async function ensureD1Schema(env) {
  if (!hasD1Binding(env)) return false;
  if (schemaReadyPromise) return schemaReadyPromise;

  schemaReadyPromise = (async () => {
    const db = env.SUBSCRIPTIONS_DB;
    const statements = [
      db.prepare(`CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS subscriptions_current (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        custom_type TEXT,
        category TEXT,
        member_level TEXT,
        points REAL,
        account TEXT,
        account_serial TEXT,
        users TEXT,
        amount REAL,
        currency TEXT,
        period_value REAL,
        period_unit TEXT,
        expiry_date TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        auto_renew INTEGER NOT NULL DEFAULT 1,
        has_password INTEGER NOT NULL DEFAULT 0,
        data_json TEXT NOT NULL,
        created_at TEXT,
        updated_at TEXT,
        synced_at TEXT NOT NULL
      )`),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_subscriptions_current_name ON subscriptions_current(name)'),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_subscriptions_current_account ON subscriptions_current(account)'),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_subscriptions_current_account_serial ON subscriptions_current(account_serial)'),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_subscriptions_current_expiry_date ON subscriptions_current(expiry_date)'),
      db.prepare(`CREATE TABLE IF NOT EXISTS subscription_history (
        history_id INTEGER PRIMARY KEY AUTOINCREMENT,
        subscription_id TEXT NOT NULL,
        action TEXT NOT NULL,
        changed_at TEXT NOT NULL,
        name TEXT,
        account TEXT,
        account_serial TEXT,
        snapshot_json TEXT NOT NULL,
        metadata_json TEXT
      )`),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_subscription_history_sub_time ON subscription_history(subscription_id, changed_at DESC)'),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_subscription_history_action_time ON subscription_history(action, changed_at DESC)'),
      db.prepare(`CREATE TABLE IF NOT EXISTS accounts (
        account TEXT PRIMARY KEY,
        account_serial TEXT NOT NULL,
        password_encrypted TEXT NOT NULL DEFAULT '',
        source_subscription_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        real_name TEXT NOT NULL DEFAULT '',
        account_type TEXT NOT NULL DEFAULT ''
      )`),
      db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_account ON accounts(account)'),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_serial_unique_except_voice_supplier ON accounts(account_serial) WHERE account_serial <> '配音供应商'"),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_accounts_account_serial ON accounts(account_serial)'),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_accounts_updated_at ON accounts(updated_at DESC)'),
      db.prepare(`CREATE TABLE IF NOT EXISTS account_credentials (
        account TEXT NOT NULL,
        credential_type TEXT NOT NULL,
        password_encrypted TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account, credential_type),
        FOREIGN KEY (account) REFERENCES accounts(account) ON UPDATE CASCADE ON DELETE CASCADE
      )`),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_account_credentials_type ON account_credentials(credential_type)'),
      db.prepare(`CREATE TABLE IF NOT EXISTS account_history (
        history_id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_serial TEXT NOT NULL,
        action TEXT NOT NULL,
        changed_at TEXT NOT NULL,
        account TEXT NOT NULL,
        has_password INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT
      )`),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_account_history_serial_time ON account_history(account_serial, changed_at DESC)'),
      db.prepare(`CREATE TABLE IF NOT EXISTS menu_option_groups (
        group_key TEXT PRIMARY KEY,
        initialized_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS menu_options (
        group_key TEXT NOT NULL,
        value TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (group_key, value),
        FOREIGN KEY (group_key) REFERENCES menu_option_groups(group_key) ON DELETE CASCADE
      )`),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_menu_options_group_sort ON menu_options(group_key, sort_order ASC)'),
      db.prepare(`CREATE TABLE IF NOT EXISTS account_database_backups (
        backup_id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT 'full_overwrite_import',
        account_count INTEGER NOT NULL DEFAULT 0,
        source_filename TEXT NOT NULL DEFAULT '',
        snapshot_json TEXT NOT NULL
      )`),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_account_database_backups_created_at ON account_database_backups(created_at DESC)')
    ];

    await db.batch(statements);

    // 兼容旧版：v3.2.6 以前 accounts 以 account_serial 为主键，无法支持“配音供应商”重复。
    // 若检测到旧结构，运行时自动重建为 account 主键 + account_serial 条件唯一结构。
    let tableInfo = await db.prepare('PRAGMA table_info(accounts)').all();
    let columns = new Set((tableInfo.results || []).map((row) => String(row.name || '')));
    const serialPk = (tableInfo.results || []).some((row) => String(row.name || '') === 'account_serial' && Number(row.pk || 0) > 0);
    const credentialInfo = await db.prepare('PRAGMA table_info(account_credentials)').all();
    const credentialColumns = new Set((credentialInfo.results || []).map((row) => String(row.name || '')));
    if (serialPk || credentialColumns.has('account_serial')) {
      await db.batch([
        db.prepare(`CREATE TABLE IF NOT EXISTS accounts_v327 (
          account TEXT PRIMARY KEY,
          account_serial TEXT NOT NULL,
          password_encrypted TEXT NOT NULL DEFAULT '',
          source_subscription_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          real_name TEXT NOT NULL DEFAULT '',
          account_type TEXT NOT NULL DEFAULT ''
        )`),
        db.prepare(`INSERT OR REPLACE INTO accounts_v327 (
          account, account_serial, password_encrypted, source_subscription_id,
          created_at, updated_at, real_name, account_type
        )
        SELECT account, account_serial, password_encrypted, source_subscription_id,
               created_at, updated_at,
               COALESCE(real_name,''), COALESCE(account_type,'')
        FROM accounts`),
        db.prepare(`CREATE TABLE IF NOT EXISTS account_credentials_v327 (
          account TEXT NOT NULL,
          credential_type TEXT NOT NULL,
          password_encrypted TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (account, credential_type),
          FOREIGN KEY (account) REFERENCES accounts_v327(account) ON UPDATE CASCADE ON DELETE CASCADE
        )`),
        db.prepare(`INSERT OR REPLACE INTO account_credentials_v327 (
          account, credential_type, password_encrypted, created_at, updated_at
        )
        SELECT a.account, c.credential_type, c.password_encrypted, c.created_at, c.updated_at
        FROM account_credentials c
        JOIN accounts a ON a.account_serial = c.account_serial`),
        db.prepare('DROP TABLE account_credentials'),
        db.prepare('DROP TABLE accounts'),
        db.prepare('ALTER TABLE accounts_v327 RENAME TO accounts'),
        db.prepare('ALTER TABLE account_credentials_v327 RENAME TO account_credentials')
      ]);
      tableInfo = await db.prepare('PRAGMA table_info(accounts)').all();
      columns = new Set((tableInfo.results || []).map((row) => String(row.name || '')));
    }

    if (!columns.has('real_name')) {
      try { await db.prepare("ALTER TABLE accounts ADD COLUMN real_name TEXT NOT NULL DEFAULT ''").run(); }
      catch (error) { if (!String(error?.message || error).toLowerCase().includes('duplicate column')) throw error; }
    }
    if (!columns.has('account_type')) {
      try { await db.prepare("ALTER TABLE accounts ADD COLUMN account_type TEXT NOT NULL DEFAULT ''").run(); }
      catch (error) { if (!String(error?.message || error).toLowerCase().includes('duplicate column')) throw error; }
    }
    await db.batch([
      db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_account ON accounts(account)'),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_serial_unique_except_voice_supplier ON accounts(account_serial) WHERE account_serial <> '配音供应商'"),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_accounts_account_serial ON accounts(account_serial)'),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_accounts_real_name ON accounts(real_name)'),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_accounts_account_type ON accounts(account_type)'),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_account_credentials_type ON account_credentials(credential_type)'),
      db.prepare(`INSERT OR IGNORE INTO account_credentials (
        account, credential_type, password_encrypted, created_at, updated_at
      ) SELECT account, 'legacy', password_encrypted, created_at, updated_at
        FROM accounts WHERE password_encrypted <> ''`)
    ]);
    return true;
  })().catch((error) => {
    schemaReadyPromise = null;
    console.error('[d1] 运行时初始化数据库结构失败:', error);
    throw error;
  });

  return schemaReadyPromise;
}
