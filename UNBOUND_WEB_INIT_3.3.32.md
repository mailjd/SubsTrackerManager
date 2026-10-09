# SubsTracker v3.3.32｜先部署程式，綁回原資源，再執行網頁 init

基準：完整 v3.3.31 DirectUpgrade，延續使用者提供的完整 v3.3.29。日期：2026-10-09。

本版修改原 repository；不是獨立升級輔助工具。Cloudflare Git 連接、原 Worker、原網域不需要更換。

**使用流程：手動解綁原 D1/KV → 單次部署新版程式 → 手動綁回相同資源 ID → /init 驗證與升級 → 原網站及 Cron 恢復。**

## 1. 解綁前

先停止其他發布器及寫入這兩個資源的 Worker／排程／管理操作，安排維護時段。先獨立備份原 D1、原 KV 及必要的密鑰／還原資料，確認備份可用；記下原 Cloudflare Account、Worker 名稱、Database ID、Namespace ID 及綁定名稱。

只移除 **Worker 的 Binding 連接**，不要刪除 D1 database、KV namespace、Worker 或原 Secrets。解綁後舊站可能暫時出錯或無法使用，屬於這個流程的停機時段。

**無綁定部署階段不讀寫原資料，也無法替你備份已解綁的原資源。init 的備份確認只是操作者確認，不是程式已替你建立或驗證備份的證明。**

原 `JWT_SECRET`、`CREDENTIALS_ENCRYPTION_KEY` 和 KV `config` 不得刪除或重設。沿用原 Cloudflare 部署憑證；本版無綁定路徑不要求 `SUBSTRACKER_BACKUP_PASSWORD`，但原先保存的備份密碼仍要保留，否則舊加密備份可能無法還原。

## 2. 套用程式

現有 repository 使用累積差異包，將 ZIP 內容合併到 **原 package.json 所在的根目錄**，覆蓋同路徑檔案；不要整包放入 scripts，也不要造成 scripts/src 或 scripts/scripts 的錯誤巢狀。

`package.json` 與 `package-lock.json` 一起更新。修補包不含 `wrangler.toml`；保留自己的 Worker 名稱、帳戶、命名環境、網域、一般變數及 Secrets。完整包的 `wrangler.toml` 只是原版範本，不能用它覆蓋線上自訂設定。

這份累積包包含 v3.3.30、v3.3.31 的必要修正。不要再套用舊 CodeOnlySafetyGate 或升級輔助工具。正式命令仍是：

```text
Build command:  npm run build
Deploy command: npm run deploy:cloudflare
```

不要串接 `deploy:code-only:check`，也不要改成直接執行 `wrangler deploy`。本版不是略過編譯或測試；部署前必須完成原有檢查及新增 init 測試。

## 3. 解綁兩個儲存 Binding，部署程式

在原 Worker 的 Bindings 移除 D1 與 KV 的連接，儲存並部署這次設定變更，確認現行版本已無這兩種綁定。再提交／推送本版更新，讓原 Cloudflare Git 連接執行部署。

部署器會核對 Worker settings 和 **現行已部署版本**，不是最新上傳但未生效的版本。只有兩處確認都沒有 D1/KV，才進入無綁定模式。讀取失敗、綁定清單缺失、只移除 KV 但仍有 D1、設定尚未生效或出現不支援的其他綁定，都不當成「已解綁」。工具不會代替你解除綁定。

核對成功後，產生臨時發布設定，明確使用空的 D1/KV 清單，避免把本地過期 ID 綁回或建立新儲存資源。沿用原一般變數、Secret 名稱、Cron 與 workers.dev 設定；不先要求已解綁的舊站健康檢查成功。

程式發布並核對同一 runId 成功後，日誌應出現：

```text
ST_CODE_DEPLOYED_AWAITING_BINDINGS
codeDeployed: true
applicationReady: false
phase: bindings_required
```

此時部署命令成功結束，網頁可顯示等待／init 頁。**這只表示程式部署成功，資料尚未升級，不能當作整個升級已完成。** 不需要先發布維護版本、等待 16 分鐘或執行舊第二階段。

若兩個資料資源仍綁定，預設入口保留 v3.3.31 直接相容升級行為；它不是本指南的延後 init 路徑。請按本指南先解綁兩者。

## 4. 綁回原 D1 與 KV

在同一 Worker 加回這兩個 Binding，務必選取解綁前記下的相同資源 ID：

| 類型 | Worker 變數／綁定名稱 | 選取的資源 |
|---|---|---|
| Workers KV | `SUBSCRIPTIONS_KV` | 原 Namespace ID |
| D1 | `SUBSCRIPTIONS_DB` | 原 Database ID |

儲存並部署 **Binding 設定變更**，保留剛發布的程式。這一步不要求再次推送 Git 或重新執行整個程式升級命令。不要新建空 KV 或以同名的新資料庫代替。

Worker 的執行時 binding 物件不能自行證明解綁前的歷史資源 ID。本版會驗證內容、密鑰、檢查點及收據，但操作者仍須在 Cloudflare 控制台核對原 ID；不能只依靠綁定名稱相同。

## 5. 執行 /init

在原站網址後加上 `/init`。頁面不依赖 D1/KV 就能顯示；未綁齊時執行按鈕停用。綁回後按「重新檢查綁定」。GET 開頁、重整或重新綁定本身都不會初始化資料。

init 使用 Worker **執行時** Secret `SUBSTRACKER_SUPERADMIN_PASSWORD`。原本有設定就沿用；沒有時，在原 Worker 的 Settings → Variables and Secrets 加入獨立的強密碼，儲存並部署設定。若已存在 `SUBSTRACKER_SUPERADMIN_USERNAME`，同時輸入原名稱。

這不是普通網站登入密碼、Cloudflare API Token 或備份密碼，也不是只填在 Builds 的 Secrets。不要把憑證寫入 repository 或網址。頁面每次受保護操作都驗證此憑證，不存入 localStorage/sessionStorage；成功後清除密碼輸入框。

先按「檢查原資料（不寫入）」，核對原資料數量、待補結構與歷史。確認原資源 ID、備份及沒有其他寫入者後，勾選兩個確認項，再按「執行／繼續 init」。

執行時採分批追加與 D1 檢查點：補齊結構 → 補齊缺失歷史 → 寫入本次 KV 收據 → 回讀驗證。關閉頁面或請求超時不會自動刪除已完成的批次；重新開同一版 /init、驗證後可續跑。不需重新部署或重建資料庫。

真正完成時頁面紀錄出現：

```text
ST_WEB_INIT_COMPLETE
applicationReady: true
maintenance: false
```

此時顯示原管理頁連結，原登入／業務 API／Cron 才恢復。驗證原登入、訂閱數量、帳號、歷史與範本後，再恢復其他外部寫入者。

## 6. init 實際更新範圍

| 項目 | 本版處理 |
|---|---|
| D1 表、索引 | 依既有 v3.3.31 現行結構，僅建立缺失項目；不 DROP／重建已有表。 |
| D1 欄位 | 對相容帳號表，僅補允許缺少的 real_name、account_type、owner_type；不覆寫已有帳號。 |
| 訂閱歷史 | 保存原 KV/D1 不可變歷史；僅向 D1 補入缺失的原歷史／legacy receipts，重跑不重複追加。 |
| D1 升級狀態 | 本次發布專用檢查點；原歷史種子標記缺失時才寫入，已有標記不覆蓋。 |
| KV | 核驗既有 v3 結構、原 config 與密鑰；僅增加本次發布專用收據，不改寫 config、schema_version 或業務鍵。 |
| 原業務資料 | 不覆蓋原訂閱、帳號、密碼、憑據、既有歷史或範本；也不以 init 強制重建業務鏡像表的內容。 |

本版是既有 v3.3.29+ 資料的升級入口，不是空庫首次安裝。KV 空白、v2 結構、原密鑰缺失、無法解析的資料、舊 account_serial 主鍵、同名但定義衝突的索引等都會停止，不能用建立預設帳號或回傳假成功掩蓋。

## 7. 中斷與安全界線

- KV 最終一致，包含「查無此鍵」的快取；寫入收據後可能需等待可見。本版會停在 verify_kv 繼續回讀，不反覆寫入或提前開站。其他地區在收據可讀前仍會保持門禁，不承諾固定等待秒數。
- D1 單批交易不代表 D1 與 KV 有跨服務交易。本流程沒有全域一致快照或可阻止其他 Worker 的全域鎖。init 前請自行停掉外部寫入者；偵測原 config／訂閱／舊歷史改变時會停止。
- 每批至多新增 8 個結構操作／歷史項目。驗證清單的單筆檢查點上限為 900,000 bytes；超出會在該寫入前停止。本版未以你的實際資料量作容量驗證，不聲稱無限資料量均可一輪完成。
- 登入失敗有單 isolate 的盡力節流，不是全域 rate limit；應使用強 SuperAdmin 密碼。頁面不需要向瀏覽器交出 Cloudflare Token。
- 不要同時啟動其他發布器，或在 init 期間把 Worker 回滾到會寫入的舊程式。尚未完成的舊版升級批次不能被本版冒充驗收完成。
- 再次解綁後重跑整個程式發布會建立新的 runId；既有資料保留，但新發布需重新 init，不能沿用另一發布的批准。

## 平台依據與本地驗證

Cloudflare 官方 Bindings 文件說明 binding 是 Worker 的資源存取介面，且只改綁定時可能重用 isolate，因此本版不把資料升級成功狀態永久快取於全域。

參考文件（2026-10-09 查閱）：
- Bindings：`https://developers.cloudflare.com/workers/runtime-apis/bindings/`
- Runtime Secrets：`https://developers.cloudflare.com/workers/configuration/secrets/`
- KV 一致性：`https://developers.cloudflare.com/kv/concepts/how-kv-works/`
- D1 batch / Sessions：`https://developers.cloudflare.com/d1/worker-api/d1-database/`

本地實測與未完成項目見 `VERIFICATION_3.3.32.md`。本包沒有替使用者執行真實 Cloudflare 部署，也沒有讀取或修改使用者線上資料。
