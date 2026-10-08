# SubsTracker v3.3.22｜部署阻斷修正與驗證報告

日期：2026-10-08。來源：實際 v3.3.21 DeploymentEntryFix ZIP。這是本機驗證報告，不是正式 Cloudflare 發布驗收。

## 1. 原因與修改範圍

原 v3.3.21 的 `require-safe-upgrade.mjs`／host 檢查拒絕 Workers Builds，且執行時門禁需要本次已驗證的升級狀態。原 guard 在 WORKERS_CI 下重現exit1。上一版只增加錯誤訊息，沒有提供使用者現有Cloudflare Git入口可執行的升級流程。

本次新增 `npm run deploy:cloudflare`：將16分鐘維護等待移到兩次Build之間，跨全新建置環境恢復同批加密狀態。未刪除guard、未縮短等待、未用環境旗標繞過驗證，也沒有自動重建資料庫。

修改主體：部署路由／原guard合法證明檢查、prepare-stage-finish分段接續、Cloudflare KV讀取與D1原子協調、全量備份的內部升級前綴隔離、控制台操作說明、版本標記。應用門禁只修改提示文字，驗證／解鎖算法保持。表格、訂閱、帳號、歷史、提醒與業務SQL migrations未重寫。

## 2. 主要保護

- 每次發布前保留型別、語法、部署／升級／契約／workflow／Workers Vitest的必需檢查。沒有SKIP_TESTS入口。
- 原Worker实际绑定ID重新核對，原Token／backupPassword不寫進程式或日誌；不建立替代KV／D1。
- 第一階段先建立原資料全量加密備份並驗證還原；遠端分片全部回讀解密驗證後才發布維護版本。
- 恢復狀態和附件使用原加密封裝，原KV專用前綴不可變物件，原D1既有schema_meta追加指標及鎖。D1原子條件插入拒絕並發；無刪表／改名／覆寫原業務key。
- 確定維護後仍等待16分鐘；第二次Build不重新計算正常已確認等待起點。丟失首次發布回應時保守以確認觀察時間重算。
- 執行期一致性與原資料逐項檢查保持；只容許本批控制前綴的**新metadata列**出現在基線之後，不容許改寫任何原metadata／業務列。
- 遷移前、驗收前、解鎖前保存可恢復加密檢查點；只接續原run，變更程式來源／版本／密碼／儲存ID會停止。
- GitHub正式發布工作流改為僅手動，減少與CF自動發布競跑。單次命令預算15分鐘、協調鎖25分鐘、恢復封裝上限64MiB；超出停止而非降低核驗。

## 3. 實際測試結果

| 測試組 | 通過 | 執行與邊界 |
|---|---:|---|
| 部署入口／設定／基線／分段接續 | 35/35 | 真實Node子程序、正式runner／guard／加解密／SQLite；CloudflareREST及Wrangler上傳採隔離假傳輸。 |
| 原完整安全升級／備份／runner | 56/56 | 保留舊長流程回歸，正式模組＋合成KV／SQLite／假REST。 |
| 表格輸入／提醒契約 | 8/8 | Node正式模組。 |
| 原表格保存API／磁碟重新讀取 | 37/37 | 正式API＋本機磁碟KV／SQLite，不是Cloudflare正式資料。 |
| Database／歷史工作流 | 69/69 | 正式API本機資料；新增／續訂／歷史／模板／批量刪除／備份衝突等。 |

**合計205項回歸通過。** 證據在 `tests/results/3.3.22/`：`deploy-all.tap`、`upgrade-final.tap`、`contract.tap`、`api-results.json`、`workflow-results.json`。其他中途TAP檔是重跑／子集，不重複計數。

另通過97項來源與HTML內嵌script語法檢查（`syntax.json`）。沒有重跑瀏覽器逐像素／原生剪貼簿測試，未將舊UI測試結果冒充本次結果。

### 10項分段runner端到端情境

第一次Build實際正式guard放行並發布維護（上傳本身mock）；全新本機目錄提早Retry仍WAIT；再次全新目錄等待後驗收COMPLETE；再次Retry不重複發布；release test失敗先停止；錯密碼、維護中改src、密文損壞拒絕；apply／commit／Wrangler回應遺失後恢復；基線有外部SQL變動拒絕；本機下載加密附件不改遠端。

各測試可同時涵蓋多個斷言，上表10個runner用例已包含在35中，不能再加一次。測試入口對npm release tests與npx Wrangler上傳使用明確fake執行檔，並實際啟動正式build guard；只證明編排會要求所有測試以及guard驗證，不代表npm完整測試／真實Wrangler上傳已通過。測試時鐘偏移只存在於tests中的假傳輸，用來跨越16分鐘；正式程式沒有縮短等待開關。

### 舊版實際來源升級：額外7組情境

從原v3.3.18／v3.3.19 ZIP解壓啟動本機舊程式、寫入合成資料，再用**本次v3.3.22來源**升級。包含原始KV／帳號密文／模板／設定保留；重啟不重複；部分D1漏歷史補齊；舊支付補齊；備份取最新內容；v3.3.19原4條ledger所有既有欄位與KV保留；篡改備份拒絕且原值不變。

`old-version-results.json` 和 `old-version.log` 保存本次輸出。測試程式中沿用的case標籤 `actual_3319_to_3320` 和個別schema遷移標記3.3.20是歷史標籤，不是本次發布版本；目的端實際載入目前ROOT之3.3.22，未改名舊輸出冒充新測試。

## 4. 未完成／不可宣稱通過

實際嘗試安裝依賴，npm registry DNS返回EAI_AGAIN，並以Exit handler never called退出。`npm-ci.log`及`npm-registry-failure-excerpt.log`保存失敗證據。`npm run lint`因缺@cloudflare/workers-types（TS2688）失敗；`npm test`因vitest未安裝失敗。對應log隨包附上。

因此 **完整Workers Vitest、完整專案型別檢查、真實Wrangler bundle／上傳未完成**。正式分段入口仍把它們列為必要檢查，若正式環境測試失败會停止，不會假綠燈繼續。此次未升級npm依賴版本以避開未知兼容變化。

没有取得或操作使用者Cloudflare／GitHub權限，沒有修改控制台Deploy command、Token、資料或發布線上Worker。本機測試不能證明所有Cloudflare地域一致性／CPU／限額／依賴組合都一定成功。

## 5. 使用條件與保留邊界

**必須將Cloudflare的Deploy command改成 `npm run deploy:cloudflare`，Build command留空**，並設Build專用機密。不是只換ZIP後再次執行raw Wrangler。保留Git連線，不必改用GitHub；第一階段WAIT與第二階段COMPLETE分開判斷。完整指引在 `CLOUDFLARE_SPLIT_DEPLOY_3.3.22.md`。

原生分段路線要求現有KV＋D1、schema_meta正常、64MiB內加密恢復封裝；不為滿足這個前提建立空D1。KV-only／大資料用原長流程。原資料損壞、衝突、憑證不符、無必要權限或平台限額仍會停止。已刪除／截斷／從未保存資料不能重建。

遠端備份放在原KV便於跨Build恢復，但不等於獨立災難備份；需用 `upgrade:download` 另存離線位置。Worker Secret值不可由API匯出；同Worker保留其名稱，不重設。新部署協調只保護使用該協議的發布器，外部直寫者必須停用。

## 6. 封裝核驗

本次交付包含源碼、回歸程式、上述測試輸出及操作說明；不包含node_modules、正式憑證、測試資料庫、本次臨時升級狀態。`src/upgrade-release.js`保持未授權的預設值，不能拿ZIP直接繞過backup gate。

`FILE_MANIFEST_3.3.22.json`列出包內檔案SHA-256（不自含）；交付ZIP做CRC及所有條目與manifest核對。本次業務原碼差異結果在 `business-source-comparison.json`。正式資料是否可放行仍以原帳戶的當次驗收為準。
