# GitHub → Cloudflare Pages 部署检查清单

## GitHub

- [ ] ZIP 全部内容已提交到仓库根目录
- [ ] `.github/` 已提交
- [ ] `functions/` 已提交
- [ ] `public/_routes.json` 已提交
- [ ] `wrangler.toml` 已提交

## GitHub Secrets

- [ ] `CLOUDFLARE_API_TOKEN`
- [ ] `CLOUDFLARE_ACCOUNT_ID`

Cloudflare API Token 需要能管理本项目使用的 Pages、Workers、KV 和 D1。

## 自动部署

Push 后确认 GitHub Actions 依次完成：

- [ ] `npm ci`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run build:pages`
- [ ] `npm run setup:pages`
- [ ] `npm run deploy:pages`
- [ ] `npm run deploy:pages:cron`

## Cloudflare Pages

Pages 项目：`substracker-manager-pages`

- [ ] Pages deployment 成功
- [ ] KV binding：`SUBSCRIPTIONS_KV`
- [ ] D1 binding：`SUBSCRIPTIONS_DB`
- [ ] （新部署可选）`SUBSTRACKER_ADMIN_PASSWORD` 已设置为首次登录/应急回退密码
- [ ] `SUBSTRACKER_SUPERADMIN_USERNAME` 已在 Pages Variables and Secrets 设置
- [ ] `SUBSTRACKER_SUPERADMIN_PASSWORD` 已在 Pages Variables and Secrets 设置
- [ ] 登录页可打开
- [ ] Admin 页面可登录
- [ ] Database 页面可读取 D1

## 定时提醒

完整部署会额外创建 `substracker-pages-cron` Worker：

- [ ] Cron `0 * * * *` 已存在
- [ ] `SUBSTRACKER_CRON_SECRET` 已自动同步
- [ ] 通知历史/调度日志有正常执行记录

## 不应提交

- API Token
- Admin / SuperAdmin 密码
- `.env*`
- `.dev.vars`
- `.wrangler/`
- `node_modules/`
