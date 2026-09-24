-- SubsTracker D1：允许账号序号“配音供应商”重复
-- v3.2.7：账号(account)改为账号库实体主键；account_serial 改为条件唯一。
-- 除“配音供应商”外，其他账号序号仍保持唯一。
PRAGMA foreign_keys = ON;

CREATE TABLE accounts_v327 (
  account TEXT PRIMARY KEY,
  account_serial TEXT NOT NULL,
  password_encrypted TEXT NOT NULL DEFAULT '',
  source_subscription_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  real_name TEXT NOT NULL DEFAULT '',
  account_type TEXT NOT NULL DEFAULT ''
);

INSERT INTO accounts_v327 (
  account, account_serial, password_encrypted, source_subscription_id,
  created_at, updated_at, real_name, account_type
)
SELECT account, account_serial, password_encrypted, source_subscription_id,
       created_at, updated_at, COALESCE(real_name,''), COALESCE(account_type,'')
FROM accounts;

CREATE TABLE account_credentials_v327 (
  account TEXT NOT NULL,
  credential_type TEXT NOT NULL,
  password_encrypted TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account, credential_type),
  FOREIGN KEY (account) REFERENCES accounts_v327(account)
    ON UPDATE CASCADE ON DELETE CASCADE
);

INSERT INTO account_credentials_v327 (
  account, credential_type, password_encrypted, created_at, updated_at
)
SELECT a.account, c.credential_type, c.password_encrypted, c.created_at, c.updated_at
FROM account_credentials c
JOIN accounts a ON a.account_serial = c.account_serial;

DROP TABLE account_credentials;
DROP TABLE accounts;

ALTER TABLE accounts_v327 RENAME TO accounts;
ALTER TABLE account_credentials_v327 RENAME TO account_credentials;

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_account
  ON accounts(account);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_serial_unique_except_voice_supplier
  ON accounts(account_serial)
  WHERE account_serial <> '配音供应商';
CREATE INDEX IF NOT EXISTS idx_accounts_account_serial
  ON accounts(account_serial);
CREATE INDEX IF NOT EXISTS idx_accounts_updated_at
  ON accounts(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_accounts_real_name
  ON accounts(real_name);
CREATE INDEX IF NOT EXISTS idx_accounts_account_type
  ON accounts(account_type);
CREATE INDEX IF NOT EXISTS idx_account_credentials_type
  ON account_credentials(credential_type);
