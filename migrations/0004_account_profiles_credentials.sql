-- SubsTracker D1：账号资料扩展 + 分工具凭据
-- 账号主表新增实名人、账号类型；密码改为按工具独立保存。
PRAGMA foreign_keys = ON;

ALTER TABLE accounts ADD COLUMN real_name TEXT NOT NULL DEFAULT '';
ALTER TABLE accounts ADD COLUMN account_type TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_accounts_real_name
  ON accounts(real_name);
CREATE INDEX IF NOT EXISTS idx_accounts_account_type
  ON accounts(account_type);

CREATE TABLE IF NOT EXISTS account_credentials (
  account_serial TEXT NOT NULL,
  credential_type TEXT NOT NULL,
  password_encrypted TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_serial, credential_type),
  FOREIGN KEY (account_serial) REFERENCES accounts(account_serial)
    ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_account_credentials_type
  ON account_credentials(credential_type);

-- 旧版单一密码无法自动判断属于哪个工具，因此迁入 legacy 槽位保留，
-- 由用户在 SuperAdmin 下查看后手工归类，不会丢失旧密码。
INSERT OR IGNORE INTO account_credentials (
  account_serial, credential_type, password_encrypted, created_at, updated_at
)
SELECT account_serial, 'legacy', password_encrypted, created_at, updated_at
FROM accounts
WHERE password_encrypted <> '';
