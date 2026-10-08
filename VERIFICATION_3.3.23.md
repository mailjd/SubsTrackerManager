# SubsTracker v3.3.23｜D1＋KV限定：修改與驗證報告

日期：2026-10-08。基礎：實際 `SubsTracker-GitHub-Cloudflare-Ready_v3.3.22_CloudflareSplitDeployFix_20261008.zip`。本次測試全部使用合成資料／本機環境；沒有登入、發布或改寫使用者正式 Cloudflare。

## 1. 原版結論與此次修改範圍

原 v3.3.22 的業務、加密備份分片與部署協調已使用 D1／KV，沒有 R2 bucket 綁定、R2 金鑰或直接 R2 SDK 依賴。但是 `scripts/upgrade/cloudflare.mjs:exportSQL()` 仍透過 D1 `/export` 取得 `signed_url`，再下載 SQL。

這是 D1 官方匯出介面的簽名下載路徑，不足以證明原專案使用了使用者自建 R2；也不能從本地來源得知某次正式返回網址的主機。為避免依賴此環節，本版移除 `/export` 工作與簽名檔案下載，改成 D1 `/query` 分頁讀取並在建置機內產生 SQL。沒有改用另一個物件儲存服務。

本版的 Cloudflare 持久資料依賴限定為原 D1＋KV；Worker 執行、ASSETS、瀏覽器／本機暫存不屬於額外資料庫。選用 GitHub Actions 的加密 CI 附件不是 R2。這不宣稱控制 Cloudflare 產品內部基礎設施。

## 2. 實際程式變更

| 範圍 | 實際變更 |
|---|---|
| D1備份 | 新增 `scripts/upgrade/d1-query-snapshot.mjs`，只用 SELECT／PRAGMA query，重建表／資料／索引／view／trigger／sequence。普通表使用rowid游標；WITHOUT ROWID依複合主鍵排序。 |
| 精度與大欄位 | SQLite端將數值與二進位編碼成SQL字面值；每頁最多32列，大文字／BLOB按24KiB切片，避免JSON int64精度與NUL截斷。 |
| 完整性 | 核對每頁筆數、游標前進、分片長度、前後行數與結構；保留原兩次獨立來源掃描、加密還原驗證及維護期原資料驗收。 |
| 儲存限制 | 新增 `storage-policy.mjs`，檢查根TOML、命名環境、線上綁定、加密狀態及產生的Wrangler配置；拒絕R2／不支援的額外儲存，不自動刪除任何資源。 |
| 傳輸限制 | Cloudflare REST只允許原Worker控制、D1 query與KV必要路徑；拒絕D1 export/import、R2、絕對網址及路徑逃逸。API重導向不跟隨。 |
| 發布檢查 | 新增 `npm run test:storage`，正式Cloudflare split及GitHub發布流程均要求通過；原備份／測試／guard不移除。 |
| 版本 | 3.3.23，表格保存協議仍2。原升級物件及schema_meta協議前綴保留，不因版號重命名。 |

方法名稱 `exportSQL` 為相容保留，不表示仍呼叫 D1 export API。正式 `src/upgrade-release.js` 隨包為未授權、預設關閉的值，不能直接繞過備份部署。

## 3. 已保留功能與實測內容

訂閱新增／導入／表格保存、取消／暫存、帳號庫、公私序號、基礎資料、顯示模板、訂閱歷史分流／累計、提醒預設、續訂與備份還原驗收均未改寫資料模型。`src/data`、`src/api`、`src/core`、`src/services`、`migrations`、`public` 共 **67個檔案**與原3.3.22位元組相同；逐檔SHA-256在 `tests/results/3.3.23/business-source-comparison.json`。

本次還實際重跑以下驗證，而不是只以「來源不變」代替功能測試。

| 測試組 | 通過／總數 | 本次實際邊界／證據檔 |
|---|---:|---|
| 新D1 query備份＋儲存限制 | 36／36 | 真正SQLite、正式snapshot／client；REST用限制路徑的本機假傳輸。`storage.tap` |
| 部署入口與跨Build分段接續 | 35／35 | 真正runner／guard／加密／SQLite；CloudflareREST及Wrangler上傳由明確假傳輸代替。`deploy-final.tap` |
| 完整安全升級與備份 | 57／57 | 含「已有真正備份後注入R2配置仍拒絕」。`upgrade-final.tap` |
| 輸入／提醒／排程契約 | 8／8 | 正式模組Node測試。`contract.tap` |
| 訂閱表格保存與重啟回讀 | 37／37 | 正式API＋磁碟KV／SQLite。`api-results.json` |
| Database／歷史工作流 | 69／69 | 正式API本機資料；新增／導入分流、續訂歷史、模板、序號、批量刪除、衝突與還原。`workflow-results.json` |
| 訂閱表格瀏覽器 | 16／16 | Chromium真實DOM事件＋loopback橋接本機API，不是正式站CDN逐像素或原生OS剪貼簿測試。`browser-results.json` |
| Database／歷史瀏覽器 | 27／27 | Tab、篩選、模板、公私、暗色選格、歷史頁及儀表板。`db-browser-results.json` |

**合計285項通過，無skip。** 另完成 **99項JavaScript／HTML內嵌腳本語法檢查**，3份TOML及2份Workflow YAML解析通過。匯總：`verification-summary.json`；不重複計入重跑或中途輸出。

### D1直接備份涵蓋的案例

空資料庫結構、137行跨頁與游標前進、一般／複合主鍵表、隱含rowid、刪除過資料後的自增序列、generated column、引號標識符、索引與view、trigger不重複寫入、中文／Unicode／NUL、NULL／空字串／空BLOB區分、int64與REAL、長文字與BLOB分片均有往返比對。管理表排除、缺頁、重複頁、分片短少、結構改動、API非完整回應、虛擬／影子表及大小超限均有拒絕測試。

int64測試證明新SQL擷取器可精確保留整數，不代表本應用所有舊業務驗收器對任意SQLite數值都放行；遇到既有驗收器不支援的值仍保守停止。

### 跨Build流程的實際核對

本機第一次Build執行正式備份、正式guard及發布維護的編排；全新目錄提早重試仍WAIT；另一全新目錄跨等待後COMPLETE；完成後再重試不重複發布。覆蓋錯密碼、維護中換來源、密文損壞、上傳／apply／commit回應遺失、SQL被外部改寫、必要測試失敗先停止、全新目錄下載加密附件。

本次假傳輸記錄只允許 Cloudflare API與合成Worker測試源站；斷言沒有 D1 `/export`／`/import`／R2呼叫或簽名下載主機。假npm/npx只用來驗證編排順序與guard，**不能當成真實完整npm測試、Wrangler打包或上傳通過**。16分鐘時鐘跨越只存在測試假環境，正式碼沒有縮短等待的開關。

### 額外7組真實旧版來源情境

從實際原v3.3.18、v3.3.19包解壓啟動舊程式，建立合成資料，再以本次v3.3.23程式做升級／驗收／重啟讀取。涵蓋原KV／帳號密文／模板／config不變、歷史不重複、D1部分缺失補齊、舊支付補齊、備份最新值一致、v3.3.19原歷史所有欄位保留、篡改JSON備份拒絕且未改原值。

結果在 `old-version-results.json`／`old-version.log`。最後的 `all_upgrade_assertions_passed` 是總結，不算第8組。`actual_3319_to_3320`等名稱及遷移metadata中的3.3.20為沿用的歷史協議標籤；目標來源實際載入本次工作目錄的3.3.23，不是舊結果改名。

## 4. 未完成的檢查與限制

本環境嘗試 `npm ci --ignore-scripts --no-audit --no-fund --fetch-retries=0 --fetch-timeout=20000`，registry DNS返回EAI_AGAIN，npm退出1。`npm-ci.log`與`npm-registry-failure-excerpt.log`保留實際證據。隨後：

- `npm run lint`：TS2688，缺少 `@cloudflare/workers-types`，退出2。
- `npm test`：`vitest: not found`，退出127。

因此**完整Workers Vitest、完整專案型別檢查、真實Wrangler bundle／Cloudflare發布未完成**，不能說已在正式Cloudflare驗證所有功能。正式部署入口仍要求這些檢查，不刪除、跳過或以fake替代。依賴版本未更換。

D1 query分頁不是跨請求原子事務；沿用雙掃描、維護停寫與原值比對，外部直寫應停用。發現來源變更不保證可繼續，會停止。原庫額外FTS／虛擬／影子表不受本版快照支援；D1 `_cf_*`／SQLite內部最佳化表不是應用資料，不讀取。

直接SQL備份與整個加密恢復封裝分別有64MiB保護限制；後者包含多份附件，不能把兩個上限當作同一個可用資料庫大小。讀寫配額、SQL長度、單次Build時間及網路仍有實際限制；超限不轉R2。大量資料會增加D1 query與KV請求量。

本機SQL還原是在隔離SQLite副本中驗證，未把SQL灌回正式D1；舊版本的業務JSON還原邏輯維持。備份與恢復資料在同一KV方便續跑，不是獨立災難備份；應使用 `upgrade:download` 離線保管。Worker執行時Secret值不會被API匯出，須另行保管。

## 5. 部署與完成條件

沿用原Worker／KV／D1，不需R2服務、bucket、金鑰或R2權限。Cloudflare Builds的Build command留空，Deploy command仍是 **`npm run deploy:cloudflare`**。機密設定與兩階段WAIT→重試→COMPLETE操作不變。

若3.3.22已在WAIT／維護中，先用原提交及原恢復憑證完成／恢復原批次，不能混用3.3.23通過來源校驗。正式完成以 `ST_UPGRADE_COMPLETE`、`/api/upgrade/status` 中 `version:"3.3.23"`、`maintenance:false`，以及原資料逐項驗收通過為準。

詳細使用說明：`D1_KV_ONLY_3.3.23.md`、`CLOUDFLARE_SPLIT_DEPLOY_3.3.23.md`。

## 6. 封裝與可重跑證據

本包包含源碼、回歸程式、當次TAP／JSON與操作說明；不包含node_modules、正式Token、正式資料庫、本次臨時升級狀態、恢復密碼。`tests/results/3.3.23/intermediate/`是排查過程與中途失敗，未算入285項最終通過。

`FILE_MANIFEST_3.3.23.json`逐檔記錄SHA-256（不自含）；ZIP交付檢查CRC與全部manifest摘要。解壓後保持原資料庫ID及加密密鑰，不執行清庫／替代庫初始化。

重跑核心檢查：

```sh
npm run test:storage
npm run test:deploy
npm run test:upgrade
npm run test:table-contract
node scripts/check-syntax.mjs
python3 tests/regression/api-regression.py . /tmp/subs-api-new
python3 tests/regression/workflow3319.py . /tmp/subs-workflow-new
python3 tests/regression/browser-regression.py . /tmp/subs-browser-new
python3 tests/regression/workflow-browser3319.py . /tmp/subs-db-browser-new
```

完整Cloudflare型別／Workers測試仍需成功安裝專案依賴後執行 `npm run lint`、`npm test`。所有本機回歸應使用全新輸出目錄，不指向正式儲存。

## 官方文件（核對於2026-10-08）

- D1 query：https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/
- D1 export及signed_url（舊路徑，本版不使用）：https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/
- 支援SQL／PRAGMA：https://developers.cloudflare.com/d1/sql-api/sql-statements/
- D1配額：https://developers.cloudflare.com/d1/platform/limits/
- KV配額：https://developers.cloudflare.com/kv/platform/limits/
