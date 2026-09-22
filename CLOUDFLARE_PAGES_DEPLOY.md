# SubsTracker Cloudflare Pages 部署指南

SubsTracker v3.2.1 默认支持部署到 **Cloudflare Pages + Pages Functions + KV + D1**。

网站、登录页、管理后台和 API 都运行在 Pages Functions；静态资源由 Pages 提供。由于 Pages Functions 本身没有 Cron Trigger，完整提醒功能会额外部署一个极小的 `substracker-pages-cron` Worker，只负责每小时调用 Pages 的内部调度端点，不承载网页或业务 API。

## 架构

```text
GitHub
  ↓ GitHub Actions
Cloudflare Pages: substracker-manager-pages
  ├─ Pages Functions：登录 / Admin / API
  ├─ Static Assets：public/
  ├─ KV：SUBSCRIPTIONS_KV
  └─ D1：subscription-manager-db

Cloudflare Worker: substracker-pages-cron
  └─ 每小时调用 Pages /api/internal/scheduler
```

## GitHub Secrets

仓库 `Settings → Secrets and variables → Actions` 需要：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Admin / SuperAdmin 登录凭据不写入 GitHub。

可选：在 GitHub `Settings → Secrets and variables → Actions → Variables` 设置 `SUBSTRACKER_PAGES_PROJECT_NAME`，可覆盖默认 Pages 项目名 `substracker-manager-pages`。Pages 部署成功后，在 Cloudflare Pages 项目的 Variables and Secrets 设置：

- `SUBSTRACKER_ADMIN_PASSWORD`：可选，Admin 首次部署/应急回退密码
- `SUBSTRACKER_SUPERADMIN_USERNAME`：SuperAdmin 用户名
- `SUBSTRACKER_SUPERADMIN_PASSWORD`：SuperAdmin 二级密码（建议 Secret）

路径：`Workers & Pages → substracker-manager-pages → Settings → Variables and Secrets`。

## 自动部署

Push 到 `main` 或 `master` 后，GitHub Actions 会：

1. `npm ci`
2. `npm run lint`
3. `npm test`
4. `npm run build:pages`
5. `npm run setup:pages`
   - 创建/复用 Pages 项目
   - 创建/复用生产 KV / D1
   - 创建/复用 Preview KV / D1
   - 应用 D1 migrations
   - 初始化 JWT / 凭据加密密钥
6. `npm run deploy:pages`
7. `npm run deploy:pages:cron`
   - 部署轻量 Cron Bridge Worker
   - 自动生成并同步 `SUBSTRACKER_CRON_SECRET`

默认 Pages 地址：

```text
https://substracker-manager-pages.pages.dev
```

## CMD / PowerShell 手动部署

先配置 Cloudflare 登录或环境变量，然后：

```bash
npm ci
npm run setup:pages
npm run build:pages
npm run deploy:pages
npm run deploy:pages:cron
```

首次部署可选设置 Admin 回退密码：

```bash
npx wrangler pages secret put SUBSTRACKER_ADMIN_PASSWORD --project-name substracker-manager-pages
```

SuperAdmin 用户名/二级密码请在 Cloudflare Pages / Worker 的 Variables and Secrets 中设置 `SUBSTRACKER_SUPERADMIN_USERNAME` 与 `SUBSTRACKER_SUPERADMIN_PASSWORD`。

本地开发：

```bash
npm run dev:pages
```

## Cloudflare 资源

生产：

- Pages Project：`substracker-manager-pages`
- KV：`SUBSCRIPTIONS_KV`
- D1：`subscription-manager-db`
- D1 Binding：`SUBSCRIPTIONS_DB`

Preview：

- KV：`SUBSCRIPTIONS_KV_PREVIEW`
- D1：`subscription-manager-preview-db`

调度桥接：

- Worker：`substracker-pages-cron`
- Cron：`0 * * * *`
- Secret：`SUBSTRACKER_CRON_SECRET`（部署脚本自动生成并同步，不需要手动保存）

## 如果只想使用纯 Pages，不部署 Cron Worker

可以只执行：

```bash
npm run setup:pages
npm run deploy:pages
```

页面、Database、D1、KV、Excel 导入等功能都可以正常使用，但**自动到期检查、自动续订和定时通知不会每小时自动执行**。如果需要完整提醒功能，请保留 `npm run deploy:pages:cron`。

## 保留 Workers 部署方式

v3.2.1 仍保留原 Workers 方式：

```bash
npm run setup:worker
npm run deploy:worker
```

Workers 配置文件为：

```text
wrangler.worker.toml
wrangler.worker.dev.toml
```

因此同一份代码可以二选一：Pages 为默认部署目标，Workers 作为兼容部署目标。
