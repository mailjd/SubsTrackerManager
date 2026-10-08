# SubsTracker v3.3.21｜部署入口修正與驗證報告

日期：2026-10-08。基礎：`SubsTracker-GitHub-Cloudflare-Ready_v3.3.20_SafeUpgrade_20260928.zip`。

## 1. 此次錯誤的實際根因

對原 3.3.20 ZIP 解壓後，直接執行 `node scripts/require-safe-upgrade.mjs`，重現 exit code 1 與「禁止直接 wrangler deploy；使用 deploy:safe 或 Safe upgrade」訊息。原檔要求本次 `SUBSTRACKER_SAFE_DEPLOY_RUN`、加密狀態、已還原驗證的升級前備份和一致的原綁定；一般 Cloudflare Git 直連沒有建立這些狀態，因此被拒絕。

SQLite ExperimentalWarning 來自保護腳本頂層載入備份模組，不是這份截圖中的中止原因。該次 build 沒有通過，不是資料庫損壞的證據，也不能用截圖判定帳戶內其他工作流的狀態。

原工作流設計本來要求改用 GitHub Actions；這次修正是讓入口、預檢、錯誤訊息和操作文件一致，不把資料保護移除來讓直接部署變綠。

## 2. 實際修改

- 新增無網路的 `npm run deploy:check`，檢查執行平台、Node、Python、三個設定名稱、原 Worker 名稱／TOML／HTTPS 源網址；不列出 Token 或備份密碼的值。
- Cloudflare Workers Builds／Pages 明確回報 `ST_DEPLOY_ROUTE`，在發送 API 或修改本次升級狀態前停止，指引至原 GitHub repo 的 Safe upgrade。不能把長流程放進20分鐘的 Workers Builds。
- 保留正式 Wrangler build guard 的加密備份、狀態、原 KV/D1 ID 及檔案雜湊核對；未備妥時先報實際入口問題，不預先載入 SQLite 模組。
- GitHub 工作流在安裝依賴／所有遠端操作前執行本機設定預檢，加入部署回歸及工作流結果說明；必要型別、Vitest、兩次備份 Artifact、16分鐘等待、90分鐘工作流上限與失败恢復附件保留。
- Vitest 使用獨立本機 `wrangler.test.toml`，避免把正式環境的儲存 ID、assets、build 設定帶入測試。正式 guard 由獨立 Node 測試覆蓋；沒有在正式應用新增測試解鎖開關。
- 安全升級 runner 的離線測試使用自己的合成 Wrangler 設定，不再因原儲存庫有真實生產 ID 或環境變數而錯用正式配置。
- 建置身份統一為3.3.21；runner 讀取 `src/version.js`，避免發布工具和網站版本字串各自漂移。表格保存協議維持2。

**此包不讓一般 Cloudflare Git 直連直接完成安全升級。仍須依 `CLOUDFLARE_DEPLOY_FIX_3.3.21.md` 斷開直連，使用 GitHub Actions。只替換檔案再按相同 Retry 不會完成部署。**

## 3. 沒有改動的資料相關程式

逐檔比對原 3.3.20，以下67個檔案位元組完全相同：

| 目錄 | 檔案數 |
|---|---:|
| `src/data` | 21 |
| `src/api` | 14 |
| `src/core` | 7 |
| `src/services` | 16 |
| `migrations` | 7 |
| `public` | 2 |

帳號密鑰、模板儲存鍵、歷史分流、SQL migrations、完整備份加密算法與原資料逐項比對算法未改。只有網站版本標記等身份檔案更新。沒有連接或修改使用者正式資料。

此項原碼比較不能代替正式升級验收；最終是否可放行仍須由原帳戶中本次備份、原 ID 及原記錄逐項驗證決定。

## 4. 本次實際執行結果

| 測試組 | 通過／總數 | 實際邊界 |
|---|---:|---|
| 新增部署入口／設定／工作流測試 | 18／18 | 真實 Node 子程序；錯誤入口拒絕、假 runId 拒絕、設定不洩露密碼、未產生升級狀態、工作流順序。 |
| 原安全升級保護與 runner 測試 | 56／56 | 合成 KV／SQLite、假 Cloudflare REST 傳輸。prepare → guard → stage → finish，以及回應遺失恢復均執行。外網沒有 fallback；不是正式 Wrangler 上傳。 |
| 表格輸入／提醒契約 | 8／8 | Node 正式模組。 |
| 表格保存 API／磁碟回讀 | 37／37 | 本機服務、磁碟 KV＋SQLite；新程序讀回與模板保存。 |
| Database／訂閱歷史工作流 | 69／69 | 本機 API；新增、續訂、歷史、模板、批量刪除、備份衝突拒絕等。 |

合計 **188 項通過**。另完成 **93 項來源／內嵌腳本語法檢查**，兩份 Workflow YAML 與三份 TOML 的解析檢查。

本次沒有重跑瀏覽器 UI 渲染；除了版本 meta 外未修改表格 UI。ZIP 另做CRC完整性及逐檔SHA-256核對。

結果位於 `tests/results/3.3.21/`。`tests/results/3.3.20/` 是原包的歷史證據，不計入此次188項。

## 5. 未完成與限制

實際嘗試 `npm ci --ignore-scripts --no-audit --no-fund --fetch-retries=0 --fetch-timeout=25000`，registry DNS 返回 EAI_AGAIN，npm 最終錯誤退出。隨後：

- `npm run lint`：TS2688，缺 `@cloudflare/workers-types`，退出2。
- `npm test`：`vitest: not found`，退出127。

因此本環境**完整 TypeScript／Workers Vitest 沒有通過，也沒有完成真實 Wrangler bundle／Cloudflare 發布**。GitHub 工作流仍將它們列為發布前必要檢查，沒有跳過失敗測試來部署。npm lock 中的依賴版本未升級。

沒有取得或使用正式 Cloudflare／GitHub 存取權限；本次沒有修改線上 Git Builds 設定。使用者仍需按操作說明切換發布入口並執行正式環境驗收。GitHub 權限、平台配額、網路、D1原結構、資料衝突等仍可能在正式預檢時阻止升級，不能保證任何環境一次成功。

若舊3.3.20的另一次安全升級已經進入維護，應先使用同版來源及該次加密附件恢復，不混用3.3.21和舊runId。

## 6. 如何使用

先完成 `CLOUDFLARE_DEPLOY_FIX_3.3.21.md` 中的一次性介面設定，再執行原repo的 **Actions → Safe upgrade**。部署仍在原Worker，沿用原儲存；最後以驗收成功、`/api/upgrade/status` 為3.3.21且 `maintenance:false` 為準。

官方文件：

- https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
- https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/
- https://developers.cloudflare.com/workers/ci-cd/builds/#disconnecting-builds
- https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/
- https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow
