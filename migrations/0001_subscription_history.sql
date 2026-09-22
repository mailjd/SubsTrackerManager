-- SubsTracker D1：当前订阅镜像 + 不可变历史记录
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS subscriptions_current (
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
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_current_name
  ON subscriptions_current(name);
CREATE INDEX IF NOT EXISTS idx_subscriptions_current_account
  ON subscriptions_current(account);
CREATE INDEX IF NOT EXISTS idx_subscriptions_current_account_serial
  ON subscriptions_current(account_serial);
CREATE INDEX IF NOT EXISTS idx_subscriptions_current_expiry_date
  ON subscriptions_current(expiry_date);

CREATE TABLE IF NOT EXISTS subscription_history (
  history_id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id TEXT NOT NULL,
  action TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  name TEXT,
  account TEXT,
  account_serial TEXT,
  snapshot_json TEXT NOT NULL,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_subscription_history_sub_time
  ON subscription_history(subscription_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscription_history_action_time
  ON subscription_history(action, changed_at DESC);
