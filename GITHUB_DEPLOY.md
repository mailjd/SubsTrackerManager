# SubsTracker GitHub → Cloudflare Pages 部署指南

这个版本默认面向 **GitHub + Cloudflare Pages**。将 ZIP 解压后的全部内容提交到原 GitHub 仓库根目录，包括隐藏目录 `.github/`。

## 1. 仓库根目录必须包含

- `.github/workflows/`
- `functions/`
- `public/`
- `src/`
- `migrations/`
- `scripts/`
- `templates/`
- `package.json` / `package-lock.json`
- `wrangler.toml`（Pages）
- `wrangler.worker.toml`（Workers 兼容部署）

## 2. GitHub Actions Secrets

在 `Settings → Secrets and variables → Actions` 创建：

| Secret | 用途 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Pages / Workers / KV / D1 的部署与资源管理 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID |

Admin / SuperAdmin 登录凭据不要放 GitHub Secret。

可选：在 GitHub `Settings → Secrets and variables → Actions → Variables` 设置 `SUBSTRACKER_PAGES_PROJECT_NAME`，可覆盖默认 Pages 项目名 `substracker-manager-pages`。

## 3. Push 后自动执行

`.github/workflows/deploy.yml` 会：

1. 安装依赖
2. lint + test
3. 检查 Pages 构建结构
4. 创建/复用 Pages、KV、D1
5. 应用 migrations
6. 发布 Pages Functions + 静态资源
7. 部署每小时 Cron Bridge Worker

## 4. 设置 Cloudflare Runtime 凭据

Cloudflare Dashboard：

`Workers & Pages → substracker-manager-pages → Settings → Variables and Secrets → Add`

建议配置：

- `SUBSTRACKER_ADMIN_PASSWORD`：可选，首次部署/应急回退 Admin 密码
- `SUBSTRACKER_SUPERADMIN_USERNAME`：SuperAdmin 用户名
- `SUBSTRACKER_SUPERADMIN_PASSWORD`：SuperAdmin 二级密码，建议 Secret

登录 Admin 后，到「系统配置」直接修改正式管理员用户名 / 密码。系统配置中的密码优先于 `SUBSTRACKER_ADMIN_PASSWORD`。

## 5. 默认地址

```text
https://substracker-manager-pages.pages.dev
```

如果绑定自定义域名，可在 Pages 项目 `Custom domains` 设置。

## 6. 更新版本

以后继续 Push 到同一个 GitHub 仓库即可；KV 和 D1 会复用，不会重新清空数据。

## 7. Workers 兼容模式

如果以后想切回 Worker：

```bash
npm run setup:worker
npm run deploy:worker
```

完整 Pages 说明见 `CLOUDFLARE_PAGES_DEPLOY.md`。
