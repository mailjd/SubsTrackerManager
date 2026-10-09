# SubsTracker v3.3.31｜原站直接升級版

以使用者提供的完整 v3.3.29 與其 v3.3.30 綁定修正為基礎，針對 2026-10-09 部署日誌中的 `ST_SPLIT_D1_REQUIRED` 修正原部署流程。

**Cloudflare Git 連接不變、Worker 不變、原 KV / 已綁定 D1 不變。預設同一次部署完成，不再要求方案 A/B，不等待16分鐘、不手動跑第二階段。**

Build command：`npm run build`。Deploy command：`npm run deploy:cloudflare`。原 Builds 變數、機密及備份密碼沿用；不用增加「跳過檢查」環境變數。本機的 `npm run deploy` 也使用同一直接升級入口。

實作流程：讀取原綁定 → 執行既有發布檢查 → 讀取原資料並驗證兼容結構 → 將加密快照存入原 KV 的專用備份前綴 → 單次發布可直接運行版本 → 核對新版狀態及原綁定 → `ST_UPGRADE_COMPLETE`、`mode:direct-compatible`、`maintenance:false`。

這不是只刪掉 D1 檢查：新的直接運行門禁不依賴舊分段流程的完成標記，仍以唯讀方式檢查原 KV 的 v3 結構與既有密鑰，不會把缺資料的環境當成新安裝。分段 apply/commit 端點在直接模式下不接收寫入。

部署本身不批量補遷移歷史、不改寫業務記錄或資料表。應用原有的按需初始化、歷史種子補齊及正常業務讀寫仍保留，並不是改成唯讀網站。因原站不中斷，備份是線上非交易快照，不宣稱與16分鐘停寫遷移的保障相同；不要並行發布同一 Worker。

操作：[DEPLOY_REPAIR_3.3.31.md](DEPLOY_REPAIR_3.3.31.md)。實測與限制：[VERIFICATION_3.3.31.md](VERIFICATION_3.3.31.md)。本包沒有替使用者執行線上部署。

## 歷史版本說明（不代表本版預設流程）

以下保留舊版紀錄；其中16分鐘等待、方案 A/B及兩阶段流程均不是 v3.3.31 的預設升級方式。

---

# SubsTracker v3.3.30｜原部署流程綁定修正版

基於使用者提供的**完整 v3.3.29**。不是升級輔助工具，不是 code-only 跳過門禁。

操作與限制：[DEPLOY_REPAIR_3.3.30.md](DEPLOY_REPAIR_3.3.30.md)。實測報告：[VERIFICATION_3.3.30.md](VERIFICATION_3.3.30.md)。

修正 settings 缺項時的現行版本 D1 核驗、D1 無 ID 被靜默視為 KV-only、命名環境錯誤繼承，以及測試後綁定重驗。原應用、原 D1/KV、原加密備份與兩階段安全升級保留。

Cloudflare 控制台仍使用 Build command `npm run build`、Deploy command `npm run deploy:cloudflare`。保留原 Worker 名稱、帳戶、網址與備份密碼。出現 `ST_UPGRADE_WAIT` 後依原時間重試同一提交，直到 `ST_UPGRADE_COMPLETE` 且 `maintenance:false`。

未完成的旧版本維護批次不可混用本版；本輪沒有登入使用者 Cloudflare，不能宣稱線上已部署成功。

以下為歷史版本說明；本次以 3.3.30 文件為準。

---

# SubsTracker v3.3.28｜SuperAdmin 舊測試契約相容修復

這個版本修正 v3.3.27 部署時唯一失敗的 Workers 測試：`runtime.configured` 原為 `undefined`，現在正確提供 `true`。原憑證 `{username,password}` 可列舉結構不變；驗證邏輯、D1、KV、密文和模板不變。詳見 `DEPLOY_REPAIR_3.3.28.md` 與 `VERIFICATION_3.3.28.md`。

正式部署仍由 `npm run deploy:cloudflare` 執行，仍需所有 Workers 測試通過，遇到問題先停止，不直接改動正式儲存。

---

# SubsTracker v3.3.27｜Workers 契約與部署失敗修正

**本次操作：[DEPLOY_REPAIR_3.3.27.md](DEPLOY_REPAIR_3.3.27.md)；實測與限制：[VERIFICATION_3.3.27.md](VERIFICATION_3.3.27.md)。**

修正鎖定執行器的 KV cacheTtl 相容、SuperAdmin 舊介面缺失、建立訂閱後舊分類資料漏同步；原生 Workers 測試提前到 lint 之後。保留原 D1＋KV、密鑰與歷史，沒有 R2。

提供 `npm run verify:release`：完整發布前检查，不發布；`npm run diagnose:checkout`：只讀列出倉庫額外／異動檔案，不刪除或排除舊檔。

本機合成資料回歸已執行，但完整鎖定 Workers Vitest／型別／真正 Wrangler 打包尚未在此環境完成（依賴下載失敗），**不標示為線上驗收通過或保證部署成功**。現有控制台命令及備份密碼不變；本次必須更新程式，不是重試未改動的3.3.26。

以下為歷史版本說明，遇到版本差異以3.3.27文件為準。

---

# SubsTracker v3.3.26｜SQLite 測試執行環境修正

最新操作：[DEPLOY_REPAIR_3.3.26.md](DEPLOY_REPAIR_3.3.26.md)。修正 Cloudflare Python 缺少 `_sqlite3` 導致工作流測試無法啟動的問題；使用現有 Node 內建 SQLite 作真實磁碟核對，不跳過測試，不新增 R2 或其他儲存。

保留原 D1/KV、密碼、來源適配修補及兩階段安全部署。下方為歷史說明；本版具體驗證以 [VERIFICATION_3.3.26.md](VERIFICATION_3.3.26.md) 為準。

---

# SubsTracker v3.3.25｜ExecutionContext 相容修補

最新更新及操作：**[DEPLOY_REPAIR_3.3.25.md](DEPLOY_REPAIR_3.3.25.md)**。針對額外 `src/pages-handler.js` 缺 `props` 的 TS2345；保留 D1＋KV、原綁定與全部安全檢查。先依新版說明更新完整檔案，控制台命令及備份密碼保持不變。下方保留原有使用手冊和歷史說明。

---

# SubsTracker v3.3.24｜部署預檢與依賴核對修正版

基於原v3.3.23，保留D1＋KV限定、原業務資料、備份、維護等待、恢復與驗收。沒有R2。

**必讀 `DEPLOY_REPAIR_3.3.24.md`；本次實測／未完成項目見 `VERIFICATION_3.3.24.md`。**

## 你提供日誌中的根因

`Executing user deploy command: npx wrangler deploy`：控制台仍是舊命令。必須改原Worker的 **Deploy command** 為 `npm run deploy:cloudflare` 並保存；ZIP不會修改這個控制台設定。不要刪除guard強行發布。

Build command可保留原 `npm run build`，本版已改成真實依賴、語法和Wrangler dry-run檢查；也可留空由Deploy入口完成檢查。不再只有echo就綠燈。

## 重要邊界

仍是Git自動啟動第一階段，WAIT後按readyAfter手動Retry同一提交；不是全自動接續。舊版已有未完成維護批次時，先用舊版原提交恢復，不要混用新版。沿用原KV／D1、Worker名與機密，不清庫、不新建替代資料庫。

## 本機診斷與驗證

```sh
npm run deploy:doctor       # 只讀本地lock/已安裝版本，不認證正式部署
npm ci --include=dev
npm run build               # 依賴 + 語法 + 真實dry-run；不發布
npm run deploy:check         # 本機設定預檢，不訪問原帳戶
npm run test:storage
npm run test:deploy
npm run test:upgrade
npm run test:table-contract
npm run test:workflow
npm run lint
npm test
```

發布固定使用專案根Wrangler3.114.17；間接測試套件Wrangler3.100.0的deprecated警告仍可能出現，不是此次ST_DEPLOY_COMMAND的成因。沒有在無法做完整驗證時強行切換Wrangler4；所有原lock套件版本保持。

測試證據在`tests/results/3.3.24/`，其他版本的results和報告屬於歷史。完整型別、Workers Vitest和真實bundle是否通過以本次報告為準，不把模擬工具回歸冒充正式Wrangler驗收。

部署完成後 `npm run upgrade:download` 另存加密備份，備份密碼另外保管。可選GitHub／本機長流程見 `SAFE_UPGRADE_3.3.24.md`；不要兩個發布器同時操作。
