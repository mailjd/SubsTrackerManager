# SubsTracker v3.3.23｜D1＋KV 儲存限定版

日期：2026-10-08。基於實際 v3.3.22 CloudflareSplitDeployFix ZIP。本文的驗證指本機測試，不是你的正式 Cloudflare 帳戶驗收。

## 結論及原版查核

v3.3.22 的業務資料、加密備份分片、跨 Build 恢復原本已使用既有 D1＋KV，沒有專案 R2 bucket 綁定，也沒有要求 R2 Access Key／Secret Key 或 R2 SDK。

不過 `scripts/upgrade/cloudflare.mjs` 的 `exportSQL()` 原本呼叫 D1 `/export`，再取得 `signed_url` 下載 SQL。這是 D1 的匯出介面，不等於專案有綁定自己的 R2；僅憑程式碼也不能斷言你帳戶那次返回的網址實際是哪個主機。為連這個外部檔案下載環節也不依賴，本版已完全移除該路徑。

**v3.3.23 不呼叫 D1 `/export`／`/import`，不取得 `signed_url`，不建立、綁定或呼叫 R2 bucket。D1 備份直接透過 D1 `/query` 讀取，SQL 在建置程序內產生。** 無 R2 fallback；遇到異常停止保留資料。

## 儲存分工

| 範圍 | 使用位置 |
|---|---|
| 訂閱、帳號資料、基礎選單、歷史、設定與模板 | 沿用原有 D1／KV 資料模型及鍵名；不搬到新庫 |
| 訂閱表格儲存、提醒／自動續訂／歷史累計 | 原業務程式不變，仍使用原 D1／KV |
| 完整備份的 D1 來源 | D1 query：結構、欄位、數值及資料分頁讀取 |
| 完整備份的 KV 來源 | 原 KV 分頁 key／value，保留 bytes、metadata、expiration |
| 跨 Build 加密備份、恢復附件 | 原 KV 專用 `__substracker_upgrade_artifacts_v1__:` 前綴 |
| 部署互斥鎖、檢查點指標 | 原 D1 的 `schema_meta`，沿用追加式協調 |
| 本機保管 | `npm run upgrade:download` 下載加密附件，不發布、不解鎖 |

「D1＋KV」指本工具的 Cloudflare 資料與恢復儲存依賴。Cloudflare Workers 仍執行程式，`ASSETS` 仍提供前端靜態檔案；本機／瀏覽器暫存不是 R2。選用的 GitHub Actions 長流程仍可將加密附件保存在 GitHub Actions artifacts，那是 CI 附件，不是應用資料庫，也不需要 R2。主要的 Cloudflare 分階段入口只把遠端恢復資料放在 D1＋KV。

本程式不能控制 Cloudflare 在 D1／KV 產品內部採用的基礎設施；「不使用 R2」是對本專案的綁定、權限、客戶端請求及應用儲存依賴的承諾，不是對供應商內部實作的猜測。

## 本版修改

1. 新增 `scripts/upgrade/d1-query-snapshot.mjs`：直接查詢原 D1，重建完整應用 SQL 邏輯備份。`exportSQL` 保留方法名稱供既有呼叫相容，但內部已改為 query-only。
2. 一般資料以每頁最多32筆、rowid 游標前進；WITHOUT ROWID 表使用穩定主鍵順序。文字、NULL、BLOB 和 int64 先在 SQLite 編碼，避免 JSON 數字精度或字串 NUL 截斷。
3. 大欄位使用每片24KiB有界讀取，不把整個大 BLOB／文字塞進單次回應。計數不符、分片少 bytes、重複頁、结构變動或查詢回應不完整，一律中止。
4. 先建立表並還原資料，再建立索引／view／trigger，避免還原時觸發器再次產生歷史；保留自增序列、隱含 rowid、一般生成欄位的表定義。
5. 新增 `storage-policy.mjs`：Wrangler 本機配置（含命名環境）、線上綁定、產生後的部署配置都核對只使用 D1／KV。發現 R2 或其他額外儲存不自動移除、不猜測搬遷；停止並明確提示。
6. Cloudflare 升級 REST 客戶端增加路徑白名單，只接受本工具所需的 Worker 控制、D1 query、KV 介面。D1 匯出／匯入工作、物件儲存 API、異常跨主機路徑在發送前拒絕。
7. 新增 `npm run test:storage`；Cloudflare 原生分階段部署與 GitHub Actions 發布前均要求通過，不提供跳過選項。

## 完整性保護仍然存在

原加密格式、密碼派生、KV分片、D1鎖、兩次獨立掃描、本機解密與還原驗證、16分鐘維護等待、逐項原記錄驗收與最終解鎖保持。加密備份不只檢查總數；原 key、值與 SQL 原記錄仍需符合驗收。

注意：D1 query 分頁不是跨 HTTP 請求的單一事務快照。因此仍保留兩次獨立掃描、維護停寫及原資料比對；本版沒有宣稱邊寫入邊分頁可獲得任意時刻的原子快照。外部有寫權限的腳本應先停止，發現變動不會繼續升級。

業務相關 `src/data`、`src/api`、`src/core`、`src/services`、`migrations`、`public` 共67個檔案與 v3.3.22 位元組相同。身份版本升為3.3.23，表格保存協議仍為2。沒有更名模板鍵、重設密鑰、清空歷史或重建帳號庫。

## 部署方式不變，不需開通 R2

在原 Worker 的 Builds：

- **Build command：留空**。
- **Deploy command：`npm run deploy:cloudflare`**。

沿用原 Account ID、原 Worker 名稱、原 KV／D1 ID。將解壓後的完整專案更新到原 Git 倉庫，合併保留原 `wrangler.toml` 專屬設定，不拿範例值覆蓋正式 ID。

Builds 必要設定沿用上一版：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`SUBSTRACKER_BACKUP_PASSWORD`（至少16字元）、`SUBSTRACKER_WORKER_NAME`，自訂源網址再設 `SUBSTRACKER_WORKER_URL`。Token 仍要有原 Worker、KV、D1 所需權限；**不需要新增 R2 權限、bucket 或任何 R2 金鑰**。

第一次執行 `ST_UPGRADE_WAIT` 後，依 `readyAfter` 時間重試同一提交。直到 `ST_UPGRADE_COMPLETE` 且 `/api/upgrade/status` 為 `version: 3.3.23`、`maintenance: false` 才是完成。只看到第一次 Build 綠燈不代表完成。

**若 v3.3.22 的某次部署已進入 WAIT／維護階段且未完成，先保留其原提交及恢復憑證，完成或按同版恢复指南處理該批次。不要在同一未完成批次中直接更換3.3.23程式；版本／來源校驗會拒絕混用。** 已完成的舊批次可再開始新版本的升級。

進階操作見 `CLOUDFLARE_SPLIT_DEPLOY_3.3.23.md` 與 `SAFE_UPGRADE_3.3.23.md`。

## 容量與支援邊界

D1 query-only SQL 邏輯備份設64MiB保護上限；跨 Build 加密恢復封裝仍為64MiB，包含多份附件，因此不等於每個原資料庫都可塞滿64MiB。各項 D1／KV 配額及每次 Build 時限仍需遵守，超限停止，絕不改用 R2。

本專案正常的資料表、索引、view、trigger、主鍵、BLOB、文字、NULL等備份路徑已測。D1管理的 `_cf_*` 和 SQLite內部最佳化表不是應用記錄，不嘗試讀取；如原庫另加了未支援的 FTS／虛擬／影子表，會明確拒絕，而不是漏備份後假成功。原有業務驗收器也會拒絕不支援的舊結構或不能精確核對的值。

備份還原驗證是在隔離本機 SQLite／KV 副本中進行，**不會自動拿SQL覆蓋正式D1**。不要另用遠端 `d1 execute --file` 來冒充本版query-only流程；那是另外的官方匯入工作，不在本工具的D1＋KV直接請求範圍內。

備份放在同一KV不等於獨立災難備份；請執行 `npm run upgrade:download` 另存本機，密碼分開保管。Worker 執行時 Secret 值不能經一般讀取API匯出；仍需保管原Secret。程式不會重新生成替代密鑰。

## 官方文件核對（2026-10-08）

- D1 query API：https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/
- D1 export API（舊版簽名下載路徑的介面，新版不使用）：https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/
- D1 支援的 PRAGMA／sqlite_master：https://developers.cloudflare.com/d1/sql-api/sql-statements/
- D1 限制：https://developers.cloudflare.com/d1/platform/limits/
- KV 限制：https://developers.cloudflare.com/kv/platform/limits/

本次沒有登入你的Cloudflare控制台，沒有修改線上資料、綁定或Token。
