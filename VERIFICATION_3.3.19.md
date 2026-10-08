# v3.3.19 實作與驗證報告

## 交付階段

實作、下列本機回歸、語法／靜態結構檢查與打包檢查完成。不是僅提供修改方案，也不是改名舊版 ZIP。完整變更規則及16項需求對照見 `RELEASE_3.3.19.md`。

## 實際執行的功能測試：157／157 通過

| 測試組 | 數量 | 實際執行內容 |
|---|---:|---|
| 原有表格保存 API 回歸 | 37 | 正式 API＋本機磁碟 KV／SQLite；欄位回讀、清空、提醒、失敗不假成功、程序重啟、模板保存。|
| 原有訂閱表格 Chromium 回歸 | 16 | 真正輸入與保存按鈕、多格粘貼、當前編輯器、取消、請求失敗與重試、防重入、版本不匹配、重新讀取。|
| Node 輸入契約／提醒／排程測試 | 8 | `node --test tests/regression/contract.node.mjs`。|
| 新業務／Database API 工作流 | 69 | 會員更新、其他類型只歷史、獨立快照、重試冪等、同帳號多訂閱、混合導入、歷史唯讀／時間篩選、模板重啟保留、基礎選項共享、公司／個人序號、並發序號、帳號導入與錯誤公私拒絕、篩選後分頁、13筆刪除、續訂補周期與防重複、備份與舊版還原、衝突前置驗證、名稱支出。|
| 新 Database／歷史 Chromium 工作流 | 27 | 基礎資料預設Tab、新增／改名／取消、表頭排序／篩選、雙擊編輯與實際保存、暗色選取RGB、小箭頭寬度、拖欄／隱藏、雲端模板恢復、公私選單／序號、新增非會員、表格模式聯動續訂、儀表板DOM順序、歷史快照、登入跳轉源碼斷言。|

測試結果 JSON／TAP 位於 `tests/regression/results/`。原 v3.3.18 測試證據保留在其下 `v3.3.18/` 子目錄，沒有將舊證據改名當成本版新測試。

此外通過 **119 項語法／結構檢查**：88個JS／MJS／CJS檔案、21個HTML內嵌腳本、10份HTML的重複ID檢查。實際頁面組裝後的 Database 重複Tab／輸入框問題在瀏覽器回歸中亦已修正。

新增 SQL migration 在本機 SQLite 重複執行兩次通過。Excel 帳號模板已加入公／私兩項下拉，檢查內嵌bytes與附帶XLSX一致、XLSX壓縮檔CRC完整，並渲染確認新欄頭及示例。回歸測試只使用合成資料，不包含使用者真實帳號／憑證。

## 本輪確實找到並修掉的回歸

初次新UI測試曾失敗，修正後重新跑通，未把失敗結果當成通過：

- Database頁有兩段相似表頭，被字串插入重複建立Tab／ID；改為唯一插入並逐頁檢查。
- 欄寬套用誤選到有同名data-col的箭頭按鈕，箭頭跟著欄寬放大；改為只對th／td套欄寬，箭頭保持小尺寸。
- 隱藏欄位按鈕開啟選單後，被文件層關閉事件立即關掉；修正點擊傳播。
- 部分非安全／測試上下文缺少crypto.randomUUID；使用crypto.getRandomValues的操作ID兼容分支，避免新增／模板入口失效。
- 還原歷史衝突若放在後段才發現，可能已寫入當前資料；改成全量歷史預驗證在前，再進入還原。
- 已完成遷移的資料庫再次導入旧版備份，也需要為該備份的歷史補建快照；加上獨立舊備份轉換，不單靠首次遷移標記。
- 舊單測中版本硬編碼3.0.0、以及表格請求硬編碼3.3.18，會與新服務器版本衝突；改為引用正式VERSION，不刪除測試或降低保存驗證要求。

## 測試邊界與未完成驗證

本機 server 使用正式 API router／資料模組，KV 為磁碟檔案 adapter，D1 為真正本機 SQLite adapter。這不是實際 Cloudflare Workers／KV／D1。D1交易、重啟讀取和API結果有本機證據；**不保證等同線上多區KV一致性、平台請求配額或並發性能**。

Chromium測試載入實際HTML並觸發DOM事件，使用本機HTTP橋接和記憶體Web Storage adapter。CDN不可用時載入最小離線樣式，因此檢查了可操作性、DOM顺序、選中顏色與尺寸，**沒有宣稱完整Tailwind／FontAwesome CDN的逐像素視覺驗收，也沒有驗證所有作業系統原生剪貼簿操作**。

`npm ci` 實際嘗試因依賴下載DNS EAI_AGAIN失敗。完整 `npm test`（Cloudflare Workers Vitest）未執行；完整 `npm run lint` 依賴的Workers型別未能安裝，不能列為通過。額外使用DOM型別做診斷仍只用作定位，沒有冒稱其等同專案型別檢查。既有CI的lint／Workers測試保留，新增工作流API測試會在失敗時返回非零碼，阻止部署。

沒有存取或修改使用者線上 Cloudflare 資料，也沒有執行真實付款、自動扣款或真實通知。排程生成的是本系統的續訂歷史記錄，不代表外部付款平台已扣款。

## 重跑方式

Node22.13+、Python3；瀏覽器組另需Python Playwright與Chromium。下方輸出目錄必須是新目錄：

```sh
node --test tests/regression/contract.node.mjs
python3 tests/regression/api-regression.py . /tmp/subs-api-new-run
python3 tests/regression/browser-regression.py . /tmp/subs-browser-new-run
npm run test:workflow
python3 tests/regression/workflow-browser3319.py .
```

安裝專案依賴成功的環境再執行：

```sh
npm ci
npm run lint
npm test
```

升級前先備份，保留原KV／D1綁定與密鑰。部署後確認頁面與API版本均為3.3.19；完整操作及資料遷移限制請看 `RELEASE_3.3.19.md`。
