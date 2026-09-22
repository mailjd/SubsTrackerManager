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

首次初始化时必须提供 `SUBSTRACKER_ADMIN_PASSWORD`。已有环境再次部署时会保留 KV 中现有管理员配置和加密密钥。

## Cloudflare 资源

部署脚本自动使用：

- Worker：`subscription-manager`
- KV：`SUBSCRIPTIONS_KV` / `SUBSCRIPTIONS_KV_PREVIEW`
- D1：`subscription-manager-db`，Worker binding 为 `SUBSCRIPTIONS_DB`
- D1 migrations：`migrations/0001_subscription_history.sql`、`migrations/0002_accounts_database.sql`
- Cron：每小时一次

## 不应提交

不要提交 API Token、管理员密码、`.dev.vars`、`.env*`、`.wrangler/` 或 `node_modules/`。
