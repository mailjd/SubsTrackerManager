# SubsTracker — 订阅管理与提醒系统

基于 **Cloudflare Workers + KV + D1** 的轻量级订阅到期提醒。在网页里管理订阅，到点通过 Telegram / Bark / 企业微信 / ntfy 等 **10 种渠道** 推送，并自带发送与调度日志方便排查。

**适合**：个人自托管、域名/会员/账单到期提醒。  
**不适合**：多用户协作、复杂企业审批流。

---

## 目录

1. [5 分钟上手](#-5-分钟上手)
2. [部署](#-部署)
3. [第一次必做配置](#-第一次必做配置)
4. [日常怎么用](#-日常怎么用)
5. [通知到底怎么工作](#-通知到底怎么工作重点必读)
6. [功能一览](#-功能一览)
7. [常见问题 FAQ](#-常见问题-faq)
8. [升级 / 开发 / 第三方 API](#-升级--开发--第三方-api)
9. [安全提醒](#-安全提醒)

---

## 🚀 5 分钟上手

```text
部署 Worker
  → 用首次部署时设置的管理员账号/密码登录
  → 系统配置：选时区（中国选 Asia/Shanghai）
  → 系统配置：允许发送的小时（例如只想早上 8 点发就填 08）
  → 勾选至少一种通知渠道并填好 Token，点「测试」直到成功
  → 订阅记录：添加订阅（可用默认提醒预设 7/3/1 天 + 当天）
  → 到点后去「通知历史」看是否发送 / 为何跳过
```

若中途卡住，先看下方 [常见问题 FAQ](#-常见问题-faq)。

---

## 📦 部署

> **GitHub 直接部署版**：如果你使用本发布包，推荐先阅读根目录 [`GITHUB_DEPLOY.md`](GITHUB_DEPLOY.md)。仓库根目录应直接看到 `package.json`、`wrangler.toml`、`src/`、`migrations/` 和 `.github/`。

### 方式一：命令行（推荐）

```bash
git clone https://github.com/mailjd/SubsTrackerManager.git
cd SubsTrackerManager
npm install

# Linux / macOS
export CLOUDFLARE_API_TOKEN=你的token
export CLOUDFLARE_ACCOUNT_ID=你的AccountID
export SUBSTRACKER_SUPERADMIN_PASSWORD=你的SuperAdmin二级密码
# Windows PowerShell
# $env:CLOUDFLARE_API_TOKEN="你的token"
# $env:CLOUDFLARE_ACCOUNT_ID="你的AccountID"
# $env:SUBSTRACKER_SUPERADMIN_PASSWORD="你的SuperAdmin二级密码"

npm run deploy:safe

# Worker 首次部署完成后，再设置管理员密码（推荐 Secret）
npx wrangler secret put SUBSTRACKER_ADMIN_PASSWORD
```

`deploy:safe` 会：

1. `npm run setup` — 自动创建 / 绑定 KV（`SUBSCRIPTIONS_KV`）与 D1（`SUBSCRIPTIONS_DB`），并初始化 D1 数据表
2. `npm run deploy` — 部署 Worker

部署成功后，终端会打印类似：

`https://subscription-manager.<你的子域>.workers.dev`

### D1 数据库：订阅记录与账号 Database

`npm run setup` 会自动创建 D1 数据库 `subscription-manager-db`，绑定为 `SUBSCRIPTIONS_DB`，并通过 `wrangler d1 migrations apply` 按顺序执行：

- `migrations/0001_subscription_history.sql`：订阅当前镜像与历史。
- `migrations/0002_accounts_database.sql`：独立账号 Database。
- `migrations/0003_menu_options_database.sql`：订阅名称、类型、分类、会员级别、使用人等可配置菜单。

D1 现在分成三个业务区域：

- **订阅记录**：`subscriptions_current` 保存当前订阅结构化镜像，`subscription_history` 保存创建、编辑、续订、支付、启停、删除、备份恢复等不可变历史。
- **Database / 账号数据库**：`accounts` 独立保存 `账号序号 / 账号 / 密码密文`，`account_history` 保存账号变更审计（只记录是否有密码，不保存密码内容）。
- **订阅菜单数据库**：`menu_option_groups / menu_options` 保存订阅名称、订阅类型、分类标签、会员级别、使用人五组菜单；D1 是主存储，旧 KV 菜单只在升级时迁移或在没有 D1 时兼容回退。

`accounts.account_serial` 与 `accounts.account` 都具有唯一约束，一个账号可被多条订阅引用。Database 页面位于 `/admin/database`，可分页搜索、新增、编辑、批量导入和删除账号；普通 Admin 只能看到密码“已设置/未设置”，不会收到或显示已保存密码。输入独立的 SuperAdmin 二级密码解锁后，当前分页会自动显示账号明文密码，并可单独隐藏/再次查看；30 分钟后自动锁定。仍被订阅引用的账号禁止删除。

正常部署仍会执行 D1 migrations；同时 Worker 运行时增加了幂等的 `CREATE TABLE IF NOT EXISTS` 兜底初始化。如果使用 Cloudflare Git 直连部署、手动 `wrangler deploy` 或曾遗漏 migration，首次访问也会自动补齐 `subscriptions_current / subscription_history / accounts / account_history / menu_option_groups / menu_options` 等基础表，避免出现 `no such table: accounts`。

账号密码使用部署环境的 `CREDENTIALS_ENCRYPTION_KEY` 通过 AES-GCM 加密后保存到 D1。普通 Admin 不下发明文密码；只有 SuperAdmin 二级认证通过后，单条查看接口才会解密返回。已有部署升级后，首次访问会自动从现有 KV 订阅抽取账号序号、账号与已有密码密文到 `accounts`，最新有效映射优先。

单条订阅历史可通过 `GET /api/subscriptions/{id}/history?limit=100` 查询。账号 API 为 `/api/accounts`，订阅编辑页的账号/序号联动优先使用该账号库。

本地开发首次使用 D1 时，可执行：

```bash
npm run setup:local-d1
```

### 方式二：GitHub Actions

1. Fork 本仓库  
2. 仓库 **Settings → Secrets and variables → Actions** 增加：

| Secret | 说明 |
|--------|------|
| `CLOUDFLARE_API_TOKEN` | **必填**。建议至少具备 Workers 部署权限、Workers KV Storage Write、D1 Edit；首次创建 Worker 时需要可创建 Worker 的权限 |
| `CLOUDFLARE_ACCOUNT_ID` | **必填**，Cloudflare Account ID |
| `SUBSTRACKER_SUPERADMIN_PASSWORD` | **必填**，Database SuperAdmin mode 的二级密码；部署脚本只保存 PBKDF2 哈希，不保存明文 |

3. 推送到 `master` / `main` 或手动运行 **Deploy** workflow  

### 默认登录

| 项 | 值 |
|----|-----|
| 项 | 值 |
|---|---|
| 用户名 | `admin`（可通过本地部署环境变量 `SUBSTRACKER_ADMIN_USERNAME` 调整） |
| 密码 | Cloudflare Worker → **Settings → Variables and Secrets** 中的 `SUBSTRACKER_ADMIN_PASSWORD` |

管理员密码现在以 Cloudflare Worker 运行时变量为最高优先级来源。推荐把 `SUBSTRACKER_ADMIN_PASSWORD` 建立为 **Secret**，不要写入 `wrangler.toml`、GitHub 仓库或 KV。旧部署若 KV 里仍有 `ADMIN_PASSWORD`，只会在 Worker 尚未配置 `SUBSTRACKER_ADMIN_PASSWORD` 时作为兼容回退。

### 设置 / 修改管理员密码

Cloudflare Dashboard → **Workers & Pages → subscription-manager → Settings → Variables and Secrets → Add**：

- Name：`SUBSTRACKER_ADMIN_PASSWORD`
- Type：建议 **Secret**
- Value：你的管理员密码

保存后新密码立即作为登录密码来源。命令行也可以在 Worker 已部署后执行：

```bash
npx wrangler secret put SUBSTRACKER_ADMIN_PASSWORD
```

---

## ✅ 第一次必做配置

打开 **系统配置**，建议按顺序做完：

### 1. 配置管理员密码

在 Cloudflare Worker 的 **Settings → Variables and Secrets** 中设置 `SUBSTRACKER_ADMIN_PASSWORD`。系统配置页只显示配置状态，不会读取、回显或保存密码明文。

### 2. 时区

- 中国大陆用户：**`Asia/Shanghai`（北京时间）**
- 所有「到期还有几天」「几点发通知」都以这里为准

### 3. 允许发送的小时

| 你填什么 | 含义 |
|----------|------|
| `08` | **仅**北京时间 **8 点那一小时**会发（约 8:00–8:59 的那次整点检查） |
| `08, 20` | 早上 8 点、晚上 8 点各可能发一次 |
| **留空** 或 `*` | **每个整点**都可以发 |

要点：

- 系统大约 **每小时整点** 检查一次（Cron：`0 * * * *`，按 UTC 触发，但判断用你配置的时区）。
- 填了 `08`、现在是 19 点：**不会发**。通知历史里出现「不在允许发送的小时」是 **正常跳过**，不是坏了。
- 配置页下方有实时预览（会显示「当前会发 / 不会发」）。**改完要点保存**，预览才与服务器一致。

### 4. 打开至少一种通知渠道

勾选渠道 → 填 Token / Chat ID 等 → 点 **测试 xxx 通知**，确认手机/群里能收到。

常用渠道简表：

| 渠道 | 你需要准备 |
|------|------------|
| Telegram | Bot Token + Chat ID；Forum 群可选 Topic ID |
| Bark | Device Key；自建可填 Server |
| 企业微信 | 群机器人 Webhook |
| ntfy | Server（默认 ntfy.sh）+ Topic；可选 Token |
| 邮件 | Resend API Key + 收发邮箱 |
| Webhook | 任意 HTTP 地址 + 可选模板 |

### 5. 加一条测试订阅

- 到期日设近一点，提醒规则可用 **「应用预设 7/3/1/当天」**
- 或临时加一条「到期前 0 天 / 到期当天」，并把「允许发送的小时」改成当前小时做联调（测完改回）

---

## 📋 日常怎么用

### 订阅记录

| 操作 | 说明 |
|------|------|
| 添加 / 编辑 | 名称、周期、金额、分类、农历等 |
| **克隆** | 复制一条（名称带「副本」），适合 esim 保号等同构订阅 |
| 续订 | 手动延长周期并记支付 |
| 停用 / 启用 | 停用后不再提醒（本地刷新，不必整页重载） |
| 测试 | 立刻对该订阅发一条测试通知 |
| 历史 | 支付记录 |
| 筛选 | 关键词、循环/重置模式、**状态**（正常/即将到期/已过期/已停用）、分类 |


### 可配置订阅菜单

订阅编辑窗口中的 **订阅名称 / 订阅类型 / 分类标签 / 会员级别 / 使用人** 都支持下拉选择和自定义输入，并提供“管理菜单”入口，可新增、删除或恢复默认菜单。五组菜单统一保存在 D1 的 `menu_option_groups / menu_options` 中；删除菜单项只影响后续可选列表，不会删除或修改已有订阅记录。

当前默认菜单包括：

- 订阅名称：`Tapnow / LibTV / 即梦 / 豆包 / 小云雀 / SUNO / 剪映 / AdobeCC / ChatGPT / Gemini / higgsfield / LovArt / Askgo / Midjourney / TopazLabs / ClaudeCode(CC) / 19584618860 / 19042608266 / 配音 / 千问办公`
- 订阅类型：`开会员 / 充积分 / 充话费 / 服务费用 / 配音费用`
- 分类标签：`未完成 / 钉钉报销中 / 已完成 / 未还代支付`
- 会员级别：内置 `高级会员 / 豪华版VIP会员 / 专业版会员 / Ultimate会员 / Ultra会员 / Pro会员 / Plus会员 / Pro5X会员 / 摄影计划（1 TB） / 团队会员 / TopazStudio / 至尊版VIP会员(升级) / 个人标准版 / Standard Plan`。
- 使用人：内置当前人员名单，并支持多人选择；保存时统一使用英文逗号 `,` 分隔并去重。

直接输入新的名称、类型、分类、会员级别或使用人并保存订阅时，该值会自动加入对应 D1 菜单。分类标签仍支持用 `/` 分隔多个标签；使用人支持用 `,` 分隔多人。备份会同时保存五组菜单。

### Database / 账号数据库

导航栏中的 **Database** 专门维护账号资料：

- 账号序号：唯一，例如 `001`、`A-001`。
- 账号：唯一，例如邮箱、用户名或手机号。
- 密码：AES-GCM 加密保存。Admin mode 不显示已保存密码；进入 SuperAdmin mode 并输入二级密码后，当前分页会自动显示明文密码，30 分钟后自动锁定。
- 修改账号序号或账号后，会同步所有引用该账号的订阅记录；账号密码只保存在 Database，不再复制到订阅记录。
- 如果账号仍被订阅引用，系统会阻止删除。
- 订阅编辑页选择已有账号或账号序号时会自动双向切换；订阅新增/编辑表单不再挂载密码字段。
- 页面提供独立的 **下载模板 / 批量导入 / 新增账号** 工具栏，支持直接从 Excel 复制粘贴。

账号 Database 批量导入默认 3 列：`账号序号、账号、密码`。可带表头，也可按默认顺序直接粘贴。相同“账号序号 + 账号”会视为同一账号：密码非空时更新密码，密码留空时保留原密码；账号序号或账号与现有一对一关系冲突时，该行会拒绝导入并显示 Excel 行号。单次 API 最多 200 条，前端按每批 100 条提交。

仓库内附带账号模板：`templates/SubsTracker_账号数据库批量导入模板.xlsx`。

### Excel 批量录入

订阅记录顶部提供 **「下载Excel模板」** 与 **「批量录入」**。

推荐流程：

1. 下载默认 `.xlsx` 模板。
2. 在 `订阅导入` 工作表填写数据。模板包含全部 21 个订阅业务字段（不含账号密码）。
3. 在 Excel 中复制包含表头的数据区域。
4. 打开「批量录入」，直接粘贴并点击「解析并预览」。
5. 系统逐行校验后，仅导入有效行；错误行会显示具体 Excel 行号和原因。

默认字段顺序：

`订阅名称、账号、账号序号、会员级别、积分、使用人、订阅类型、分类标签、费用、币种、订阅模式、开始日期、周期数值、周期单位、到期日期、农历周期、每月最后一天、提醒规则、启用订阅、自动续订、备注`。

常用填写规则：

- 使用人：多人用英文逗号 `,` 分隔。
- 分类标签：多个标签用 `/` 分隔。
- 周期单位：`单次 / 天 / 月 / 年`。
- 布尔项：推荐填写 `是 / 否`，也兼容 `1/0`、`true/false`。
- 提醒规则：例如 `7天,3天,1天,当天`，也支持 `24小时`、`到期后每24小时`。
- Excel 日期可直接复制；系统会转换成 `YYYY-MM-DD`。
- 单次导入最多 100 条；前端会自动按每批 50 条提交。
- 导入记录会正常写入 KV、D1 当前镜像，并在 D1 历史中标记为 `import`。

**密码归属：**订阅模板不再包含密码列。账号密码请使用 Database 页单独新增或使用 `templates/SubsTracker_账号数据库批量导入模板.xlsx` 批量维护，写入 D1 前会使用 AES-GCM 加密。

仓库内也附带一份模板：`templates/SubsTracker_订阅批量导入模板.xlsx`。

### 提醒规则（每条订阅可多条）

默认预设：**到期前 7 天、3 天、1 天 + 到期当天**。

**重要语义（很多人误解这里）：**

> 「到期前 N 天」= **剩余天数正好等于 N 的那一天发一次**  
> **不会**从第 N 天起每天连发。

若要 7、6、5… 都提醒，需要多条规则，或使用预设 7/3/1/当天。

其它类型：

- **到期当天**
- **到期后**：每隔 X 小时提醒，直到你续费（受「允许发送的小时」约束）

### 订阅模式：循环 vs 到期重置

| 模式 | 一句话 | 例子 |
|------|--------|------|
| **循环订阅** | 未过期就从**当前到期日**往后接 | 会员 6/15 到期，6/3 续费 → 新到期约 7/15 |
| **到期重置** | 从**支付日**重新算一整段周期 | 保号卡充值日重新起算 180 天 |

### 周期快捷

表单里可用 **季度 / 半年 / 一年** 快捷（本质是 3 个月 / 6 个月 / 1 年）。  
公历可勾选 **「每月最后一天」**（适合「每月月末提醒」；农历下不用这个）。

### 备份与迁移

在 **系统配置** 最下方：

1. **导出备份** → 下载 JSON（默认可不含密钥）
2. 换账号 / 重装后 **导入**  
   - **合并**：按订阅 ID 覆盖同名，保留其它  
   - **覆盖**：先清空再整包导入（危险，先导出当前数据）

升级大版本或迁移 CF 账号前，**先导出一份**。

---

## 🔔 通知到底怎么工作（重点必读）

```text
每小时整点 Cron
  → 看现在是否在「允许发送的小时」（按时区）
  → 看每条启用中的订阅是否命中某条提醒规则（精确日/小时）
  → 去重（同一天同一规则不重复刷）
  → 发到你启用的渠道
  → 写入「通知历史」+「调度日志」
```

| 现象 | 通常原因 |
|------|----------|
| 任务历史：不在允许发送的小时 | 当前整点不在你填的 `08` 等列表里 → **正常** |
| 在窗口内但 sentCount=0 | 今天没有规则被命中（还没到「正好 N 天」） |
| 有 failed 记录 | 渠道配置错 / Token 失效 / 网络拒绝 → 看错误详情 |
| 一天只在 8 点附近收到 | 你只配置了 `08`，符合预期 |
| 希望一天提醒多次 | 把允许小时写成多个，如 `08, 12, 20`，或留空 |

**列表上的「提醒」列**：显示该订阅真实多规则摘要（如 `提前 7/3/1 天 · 到期当天`），与后台 `reminder_rules` 一致。

---

## ✨ 功能一览

### 订阅

- 增删改查、启用/停用、克隆、筛选  
- 多规则提醒、农历周期、自动/手动续订、支付历史  
- 季/半年快捷、公历月末选项  

### 通知渠道（10）

Telegram · NotifyX · Webhook · 企业微信 · Resend 邮件 · Bark · Gotify · Server酱 · PushPlus · **ntfy**

### 可观测

- `/admin/notify-logs`：发送成功/失败明细  
- 调度日志：命中/去重/跳过原因  
- `/debug`：时区与通知窗口诊断（需登录）  

### 财务

多币种、仪表盘支出统计（依赖支付记录与汇率；汇率接口失败时有兜底）

---

## ❓ 常见问题 FAQ

### 1. 为什么没收到通知？

按顺序查：

1. **系统配置**是否启用了渠道？「测试」能否收到？  
2. **允许发送的小时**是否包含「现在」？（填了 `08` 则只有 8 点）  
3. **时区**是否是 `Asia/Shanghai`？  
4. 该订阅是否 **启用**？提醒规则是否启用？  
5. 今天是否正好命中「到期前 N 天 / 当天」？  
6. 打开 **通知历史**：  
   - 有 failed → 看渠道报错  
   - 只有跳过、写着不在允许小时 → 等到配置的小时  
   - 完全没有相关记录 → 可能还没到整点检查，或规则未命中  

### 2. 任务历史写「不在允许发送的小时 / 不在配置时段」？

说明定时任务跑了，但当前小时不允许发。  
例如只允许 `08`，晚上 19 点跳过 → **正常**。  
到北京时间 8 点再看是否发送。

### 3. 设置了「到期前 7 天」，为什么第 6～1 天没有通知？

这是 **精确日** 设计：只在剩余 **正好 7 天** 那天发。  
需要多天提醒请加多条规则，或用预设 **7/3/1/当天**。

### 4. 列表提醒一直显示「提前 7 天」？

当前版本列表会读真实规则摘要。请 **强制刷新**（Ctrl+Shift+R）。  
若仍不对，打开浏览器开发者工具 → Network → `subscriptions`，看返回里是否有 `reminderRulesSummary`。

### 5. 克隆按钮看不见或没颜色？

操作列有 **克隆**（青色）。强制刷新；按钮在「编辑」后面。  
若只有灰字，确认已部署含主题样式的最新版本。

### 6. 循环订阅和到期重置有啥区别？

见上文表格：会员续费用 **循环**；按充值日重算周期用 **重置**。

### 7. 如何备份 / 换 Cloudflare 账号？

系统配置 → **导出备份** → 新环境部署后 **导入**。  
覆盖模式会清空现有订阅，操作前再导出一次当前数据。

### 8. Telegram 如何发到群话题（Topic）？

系统配置 → Telegram → 填写可选 **Topic ID**（对应 `message_thread_id`）。  
普通私聊/普通群可留空。

### 9. ntfy 怎么配？

启用 ntfy → Server 默认 `https://ntfy.sh` → 填自己的 Topic → 手机 ntfy App 订阅同一 Topic → 点测试。

### 10. 控制台里 `beacon.min.js` / cloudflareinsights 报错？

那是 **Cloudflare 统计脚本**，不是本项目业务代码。一般可忽略，与订阅列表无关。

### 11. Authentication error [code: 10000]（部署时）

Token 权限不足或 Wrangler 缓存问题：检查 API Token 权限，必要时删 `.wrangler/` 后重试。

### 12. 第三方系统想调通知接口？

在系统配置生成 **第三方 API 令牌** 后：

```bash
curl -X POST "https://你的域名.workers.dev/api/notify/你的令牌" \
  -H "Content-Type: application/json" \
  -d '{"title":"标题","content":"正文"}'
```

也可用请求头：`Authorization: Bearer 你的令牌`。

---

## 🔄 升级

```bash
git pull
npm install
npm run deploy:safe
```

首次访问会自动做 KV 结构迁移、同步订阅到 D1，并把已有账号序号/账号/密码密文抽取到独立账号 Database。升级前建议 **导出备份**。

> 若很久以前按 **UTC** 理解「通知小时」，现在请一律按配置里的 **时区**（如北京时间）理解，并到配置页看预览。

---

## 🛠 开发

```bash
npm install
npm test           # 单元 / 集成测试
npm run lint
npx wrangler dev --config wrangler.dev.toml --local
# http://127.0.0.1:8787  使用当前本地配置中的管理员账号/密码登录
```

```text
src/
├── index.js           # fetch + scheduled 入口
├── app.js             # Hono
├── core/              # 时间、农历、货币、JWT
├── data/              # KV、D1 订阅镜像/历史、账号 Database 与迁移
├── services/          # 调度器 + 通知渠道
├── api/               # 路由与 handler
└── views/             # 管理端 HTML
public/                # 静态资源（如 api-client.js）
tests/                 # Vitest + workerd
```

---

## 🔐 安全提醒

1. 管理员密码请放在 Cloudflare Worker **Variables and Secrets** 的 `SUBSTRACKER_ADMIN_PASSWORD`，推荐使用 Secret  
2. 不要把 API Token、Bot Token、管理员密码提交进 Git  
3. 备份 JSON 若勾选「包含敏感配置」，请当密码一样保管  
4. 对话、截图里不要长期暴露 Cloudflare API Token；泄露请到 Dashboard **轮换 Token**

---

## 🤝 贡献与协议

欢迎 Issue / PR。业务逻辑变更请尽量带测试。  
MIT License。

---

## 关注作者

![image](https://github.com/user-attachments/assets/96bae085-4299-4377-9958-9a3a11294efc)

CDN 加速由 Tencent EdgeOne 赞助。
