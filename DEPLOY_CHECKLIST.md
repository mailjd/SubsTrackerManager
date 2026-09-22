# GitHub → Cloudflare 部署检查清单

这个发布包同时面向 GitHub 仓库和 Cloudflare Workers 部署。

## GitHub 仓库

将 ZIP 解压后的**全部内容**提交到仓库根目录，包括隐藏目录 `.github/`。不要只上传 `src/`。

## GitHub Secrets

在 `Settings → Secrets and variables → Actions` 创建：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `SUBSTRACKER_ADMIN_PASSWORD`

API Token 需要允许自动创建/复用并访问本项目使用的 Worker、KV 和 D1。建议包含 Workers 部署权限、Workers KV Storage Write、D1 Edit；若 Worker 尚不存在，Token 还需要允许创建 Worker。

## 自动部署

推送到 `main` 或 `master` 后，Deploy workflow 会执行：

1. `npm ci`
2. `npm run lint`
3. `npm test`
4. `npm run setup`：创建/复用 KV、D1，写入绑定并应用 D1 migrations
5. `cloudflare/wrangler-action@v4`：发布 Worker

首次初始化时必须提供 `SUBSTRACKER_ADMIN_PASSWORD`。已有环境再次部署时会保留 KV 中现有管理员配置和加密密钥。SuperAdmin 密码改由 Cloudflare Worker 的 `SUBSTRACKER_SUPERADMIN_PASSWORD` Variable / Secret 在运行时提供，不写入 KV。

## Cloudflare 资源

部署脚本自动使用：

- Worker：`subscription-manager`
- KV：`SUBSCRIPTIONS_KV` / `SUBSCRIPTIONS_KV_PREVIEW`
- D1：`subscription-manager-db`，Worker binding 为 `SUBSCRIPTIONS_DB`
- D1 migrations：`migrations/0001_subscription_history.sql`、`migrations/0002_accounts_database.sql`、`migrations/0003_menu_options_database.sql`、`migrations/0004_account_profiles_credentials.sql`、`migrations/0005_account_database_backups.sql`、`migrations/0006_voice_supplier_duplicate_serial.sql`
- Cron：每小时一次

## 不应提交

不要提交 API Token、管理员密码、`.dev.vars`、`.env*`、`.wrangler/` 或 `node_modules/`。


## Cloudflare Worker Variables and Secrets

部署 Worker 后确认已配置：

- `SUBSTRACKER_SUPERADMIN_PASSWORD`（推荐 Secret）

登录页可以使用管理员用户名 + 该密码直接进入 SuperAdmin。

- [ ] 确认 D1 migration `0005_account_database_backups.sql` 已应用（全覆盖导入最近两版备份）
- [ ] 确认 D1 migration `0006_voice_supplier_duplicate_serial.sql` 已应用（仅 `配音供应商` 序号允许重复）


## v3.2.8 订阅批量管理检查
- [ ] 订阅记录 Excel 文件直接导入可用，重复记录只跳过、不覆盖。
- [ ] 表格/卡片显示模式切换正常。
- [ ] 多选、选择当前筛选、批量修改正常。
- [ ] 批量导出选中/筛选/全部为 XLSX 正常。


## v3.2.9 显示模式检查

- [ ] 原始模式只显示历史摘要表格，不显示卡片
- [ ] 表格模式显示 Excel 风格宽表，一行一条订阅
- [ ] 卡片模式只显示卡片，不显示原始/Excel 表格
- [ ] 三种模式切换后刷新页面仍保持当前选择
- [ ] 选择记录在三种模式间同步


## v3.3.0 分页与布局检查

- [ ] 订阅记录分页可切换 10 / 20 / 50 / 100 / 全部。
- [ ] 上一页 / 下一页可遍历当前筛选后的全部记录。
- [ ] 原始模式、Excel 表格模式、卡片模式共用同一分页结果。
- [ ] 系统配置可保存页面内容对齐模式：居中 / 左贴边 / 右贴边 / 左右贴边宽屏。
- [ ] 系统配置可设置 1200–2560px 最大内容宽度。
- [ ] 订阅记录与 Database 页面均应用相同内容布局设置。


## v3.3.1 订阅批量导入稳定性检查

- [ ] Excel 批量导入前端每批最多 4 条
- [ ] `/api/subscriptions/import` 单次最多接收 6 条
- [ ] 重复检测优先使用 D1 `subscriptions_current` 轻量字段查询
- [ ] 导入时不再读取所有订阅的 reminder rules
- [ ] 创建后提醒规则不再重复执行 legacy 回写
- [ ] 大批量导入不会出现 `Too many API requests by single Worker invocation`
