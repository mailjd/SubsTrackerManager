-- 将订阅名称 / 订阅类型 / 分类标签 / 会员级别 / 使用人菜单正式迁移到 D1。
-- 实际默认值与旧 KV 自定义值由应用首次读取时写入，避免覆盖用户已经维护的菜单。
CREATE TABLE IF NOT EXISTS menu_option_groups (
  group_key TEXT PRIMARY KEY,
  initialized_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS menu_options (
  group_key TEXT NOT NULL,
  value TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (group_key, value),
  FOREIGN KEY (group_key) REFERENCES menu_option_groups(group_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_menu_options_group_sort
ON menu_options(group_key, sort_order ASC);
