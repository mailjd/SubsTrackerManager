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
        account_serial TEXT PRIMARY KEY,
        account TEXT NOT NULL UNIQUE,
        password_encrypted TEXT NOT NULL DEFAULT '',
        source_subscription_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`),
      db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_account ON accounts(account)'),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_accounts_updated_at ON accounts(updated_at DESC)'),
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
      db.prepare('CREATE INDEX IF NOT EXISTS idx_menu_options_group_sort ON menu_options(group_key, sort_order ASC)')
    ];

    await db.batch(statements);
    return true;
  })().catch((error) => {
    schemaReadyPromise = null;
    console.error('[d1] 运行时初始化数据库结构失败:', error);
    throw error;
  });

  return schemaReadyPromise;
}
