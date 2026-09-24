# SubsTracker GitHub 直接部署指南

## v3.3.18 必查：确认真正部署到新版

本版请提交完整发布包（包括 `.github/`、`tests/`、`src/version.js`、package.json 和 package-lock.json），不要只复制 adminPage.html。
旧版 tests/data/reminders.test.js 的“缺失值=7天”断言与当前业务返回的 1 天不一致，会使 `npm test` 失败；部署工作流执行测试成功后才会运行 Deploy Worker。此版将断言修正为 1 天，7/3 天预建但停用的预设保持不变。
确认 GitHub Actions 的部署步骤成功；重新打开页面后，“保存诊断”中的页面版本与保存时检查的服务器版本都应为 3.3.18，协议为 2。不匹配时禁止提交并保留暂存，不能将上传 ZIP 等同于线上部署成功。
继续绑定原有 SUBSCRIPTIONS_KV / SUBSCRIPTIONS_DB；不要为升级新建存储空间。此版不清空订阅、账号、历史或显示模板。


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

必须建立以下 3 个 Secret：

| Secret | 用途 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token。建议至少具备 Workers 部署权限、Workers KV Storage Write、D1 Edit；首次创建 Worker 时需要可创建 Worker 的权限 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID |
| `SUBSTRACKER_ADMIN_PASSWORD` | SubsTracker 首次管理员密码，只在首次初始化 KV 配置时写入，不写入仓库 |

API Token、管理员密码和 SuperAdmin 二级密码不要写进 `wrangler.toml`、源码、README 或任何 Git 提交。

## 3. 推送并自动部署

推送到 `main` / `master` 后，`.github/workflows/deploy.yml` 会自动执行：

1. `npm ci`
2. `npm run lint`
3. `npm test`
4. 自动创建或复用 `SUBSCRIPTIONS_KV`
5. 自动创建或复用 `subscription-manager-db` D1
6. `wrangler d1 migrations apply` 初始化/升级数据库
7. 首次部署初始化管理员密码、JWT Secret、凭据加密密钥；SuperAdmin 密码由 Cloudflare Worker Runtime Secret 独立提供
8. 使用 Cloudflare 官方 `wrangler-action@v4` 执行 `wrangler deploy` 发布 Worker

也可以在 GitHub 的 `Actions → Deploy → Run workflow` 手动触发。

## 4. 首次登录

- 用户名：`admin`
- 密码：GitHub Secret `SUBSTRACKER_ADMIN_PASSWORD` 中设置的值

首次部署完成后，即使以后修改 GitHub Secret，部署脚本也不会覆盖 KV 中已经存在的管理员配置。首次创建新环境时 `SUBSTRACKER_ADMIN_PASSWORD` 为必填，不会回退到默认弱密码。密码请在系统配置中维护。

## 5. D1 数据库

自动创建并应用：

- `0001_subscription_history.sql`：订阅当前镜像 + 历史记录
- `0002_accounts_database.sql`：独立 Database 账号库（账号序号 / 账号 / AES-GCM 加密密码）
- `0003_menu_options_database.sql`：五组订阅菜单（名称 / 类型 / 分类 / 会员级别 / 使用人）
- `0004_account_profiles_credentials.sql`：账号实名人 / 账号类型 + Tapnow / 即梦 / 微信 / QQ 分工具凭据
- `0005_account_database_backups.sql`：Database 全覆盖导入最近两版自动备份
- `0006_voice_supplier_duplicate_serial.sql`：允许特殊账号序号 `配音供应商` 重复，同时保持普通序号和账号唯一

后续新增 migration，只需继续放进 `migrations/`，部署时会按 Wrangler migration 记录只执行未应用的版本。

## 6. 更新版本

以后把修改后的源码 push 到同一仓库即可。部署脚本会复用现有 KV / D1，不会重新创建业务数据库，也不会覆盖已存在的管理员密码。

## 7. 本地部署（可选）

如果不用 GitHub Actions，可以在项目根目录设置：

```bash
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
export SUBSTRACKER_ADMIN_PASSWORD=...
npm ci
npm run deploy:safe
```

Windows PowerShell 使用 `$env:变量名="值"`。


## 配置 SuperAdmin Worker Secret

SuperAdmin 密码不再放在 GitHub Secrets，也不会写入 KV。首次 Worker 部署成功后，在 Cloudflare Dashboard：

**Workers & Pages → subscription-manager → Settings → Variables and Secrets → Add**

```text
Name: SUBSTRACKER_SUPERADMIN_PASSWORD
Type: Secret（推荐）
Value: 你的 SuperAdmin 密码
```

或在本地执行：

```bash
npx wrangler secret put SUBSTRACKER_SUPERADMIN_PASSWORD
```

登录页使用管理员用户名配合此密码即可直接以 SuperAdmin 登录。


### v3.3.2 批量导入说明

订阅 Excel 导入已自动按 4 条/请求分批，服务端单次最多接收 6 条，并通过 D1 当前镜像做轻量重复检测。
无需修改 Cloudflare Worker `limits.subrequests`。如果之前有部分数据已成功写入，重新导入同一份表格时已存在记录会按“只新增、不覆盖”自动跳过。
