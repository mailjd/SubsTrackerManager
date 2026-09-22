# SubsTracker GitHub 直接部署指南

这个目录已经整理为可直接提交到 GitHub 的完整仓库。不要只上传 `src/`，需要把本目录内的全部文件与隐藏目录 `.github/` 一起提交。

## 1. 创建 GitHub 仓库

新建空仓库，将本目录内容提交到仓库根目录。根目录必须能直接看到：

- `package.json` / `package-lock.json`
- `wrangler.toml` / `wrangler.dev.toml`
- `src/`
- `migrations/`
- `scripts/`
- `templates/`
- `.github/workflows/`

主分支使用 `main` 或 `master` 都可以。

## 2. 配置 GitHub Actions Secrets

进入：`Settings → Secrets and variables → Actions → New repository secret`。

必须建立以下 3 个 GitHub Actions Secret：

| Secret | 用途 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token。建议至少具备 Workers 部署权限、Workers KV Storage Write、D1 Edit；首次创建 Worker 时需要可创建 Worker 的权限 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID |
| `SUBSTRACKER_SUPERADMIN_PASSWORD` | Database SuperAdmin mode 二级密码；初始化脚本仅保存 PBKDF2 哈希，不保存明文 |

API Token、管理员密码和 SuperAdmin 二级密码不要写进 `wrangler.toml`、源码、README 或任何 Git 提交。管理员密码改为在 Cloudflare Worker 的 Variables and Secrets 中单独设置。

## 3. 推送并自动部署

推送到 `main` / `master` 后，`.github/workflows/deploy.yml` 会自动执行：

1. `npm ci`
2. `npm run lint`
3. `npm test`
4. 自动创建或复用 `SUBSCRIPTIONS_KV`
5. 自动创建或复用 `subscription-manager-db` D1
6. `wrangler d1 migrations apply` 初始化/升级数据库
7. 首次部署初始化 SuperAdmin 二级密码哈希、JWT Secret、凭据加密密钥
8. 使用 Cloudflare 官方 `wrangler-action@v4` 执行 `wrangler deploy` 发布 Worker

也可以在 GitHub 的 `Actions → Deploy → Run workflow` 手动触发。

## 4. 设置 Cloudflare Worker 管理员密码

GitHub Actions 部署成功后，在 Cloudflare Dashboard 打开：

`Workers & Pages → subscription-manager → Settings → Variables and Secrets → Add`

新增：

- Name：`SUBSTRACKER_ADMIN_PASSWORD`
- Type：推荐 **Secret**
- Value：你的管理员密码

首次登录：

- 用户名：`admin`
- 密码：上述 Worker `SUBSTRACKER_ADMIN_PASSWORD` 的值

运行时会优先读取 Cloudflare Worker Variable/Secret。旧环境 KV 中的 `ADMIN_PASSWORD` 只作为兼容回退；一旦 Worker 已配置 `SUBSTRACKER_ADMIN_PASSWORD`，旧 KV 密码不会再用于登录。

## 5. D1 数据库

自动创建并应用：

- `0001_subscription_history.sql`：订阅当前镜像 + 历史记录
- `0002_accounts_database.sql`：独立 Database 账号库（账号序号 / 账号 / AES-GCM 加密密码）
- `0003_menu_options_database.sql`：五组订阅菜单（名称 / 类型 / 分类 / 会员级别 / 使用人）

后续新增 migration，只需继续放进 `migrations/`，部署时会按 Wrangler migration 记录只执行未应用的版本。

## 6. 更新版本

以后把修改后的源码 push 到同一仓库即可。部署脚本会复用现有 KV / D1，不会重新创建业务数据库；Cloudflare Worker 中已有的 `SUBSTRACKER_ADMIN_PASSWORD` 会继续作为管理员登录密码。

## 7. 本地部署（可选）

如果不用 GitHub Actions，可以在项目根目录设置：

```bash
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
export SUBSTRACKER_SUPERADMIN_PASSWORD=...
npm ci
npm run deploy:safe

# Worker 已部署后，交互式设置管理员密码 Secret
npx wrangler secret put SUBSTRACKER_ADMIN_PASSWORD
```

Windows PowerShell 使用 `$env:变量名="值"`。
