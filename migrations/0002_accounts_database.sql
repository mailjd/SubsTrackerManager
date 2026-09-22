-- SubsTracker D1：独立账号数据库
-- 每个账号序号只对应一个账号；密码使用应用层 AES-GCM 加密后保存。
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  account_serial TEXT PRIMARY KEY,
  account TEXT NOT NULL UNIQUE,
  password_encrypted TEXT NOT NULL DEFAULT '',
  source_subscription_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_account
  ON accounts(account);
CREATE INDEX IF NOT EXISTS idx_accounts_updated_at
  ON accounts(updated_at DESC);

CREATE TABLE IF NOT EXISTS account_history (
  history_id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_serial TEXT NOT NULL,
  action TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  account TEXT NOT NULL,
  has_password INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_account_history_serial_time
  ON account_history(account_serial, changed_at DESC);
