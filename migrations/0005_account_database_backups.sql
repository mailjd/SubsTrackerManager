-- SubsTracker D1：Database 全覆盖导入自动备份
-- 每次全覆盖前保存当前账号库快照；运行时只保留最近 2 个版本。

CREATE TABLE IF NOT EXISTS account_database_backups (
  backup_id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'full_overwrite_import',
  account_count INTEGER NOT NULL DEFAULT 0,
  source_filename TEXT NOT NULL DEFAULT '',
  snapshot_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_account_database_backups_created_at
  ON account_database_backups(created_at DESC);
