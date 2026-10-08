-- v3.3.19: business history is separate from current records and the audit log.
-- This additive migration never deletes or rewrites existing financial history.
-- accounts.owner_type is added by ensureD1Schema after inspecting PRAGMA table_info,
-- so Dashboard-first and CLI-first upgrades both tolerate an already-added column.
CREATE TABLE IF NOT EXISTS subscription_ledger (
  entry_id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  source TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  input_hash TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_subscription_ledger_time
  ON subscription_ledger(occurred_at DESC, entry_id);
CREATE INDEX IF NOT EXISTS idx_subscription_ledger_sub
  ON subscription_ledger(subscription_id);
