# SubsTracker v3.3.34 — 驗證報告

基準：本對話提供的完整 v3.3.33 DeploymentFlowFix；其為原完整 v3.3.29 的累積後續版本。本輪針對 2026-10-10T01:17:29Z 日誌的 ST_UNBOUND_STILL_BOUND 修正預設部署，不改為 direct/split。

## 已完成與未完成

| 驗證 | 結果 | 性質 |
|---|---|---|
| 完整 Node 回歸 | 436/436；0 失敗、0 跳過 | 真實本地 Node 執行；Cloudflare API/上傳器為隔離替身，SQLite 使用本地實作 |
| 生產原碼語法 | 123/123 | Node 語法檢查 |
| 原業務流程 | 69/69 | 生產模組＋本地 KV/SQLite 測試適配器 |
| 原表格 API | 37/37 | 生產模組、本機請求及資料回讀；非線上 Worker |
| 原 v3.3.33 已綁定阻擋重現 | 2/2 | KV-only 及 KV+D1 的舊版測試都確認拒絕發布 |
| 本版 npm ci | 失敗 | npm 日誌顯示 registry.npmjs.org 的 EAI_AGAIN；末尾 Exit handler never called |
| 本版完整 build | 未通過 | check-toolchain 在 hono 未安裝處停止；未到完整 tsc/Wrangler |
| 本版 native Workers tests | 未啟動成功 | vitest: not found |
| 本版真實 Wrangler dry-run | 未完成 | 無鎖定依賴；不能以原版 Build 成功推定新版通過 |
| Cloudflare 線上發布、原資料 init | 未執行 | 沒有使用使用者 Token，未發送線上帳戶讀写請求 |

436 項是同一份最終來源完整重跑的結果，沒有把 focused、helper、原版或 Workers 未執行測試重複相加。第一次完整跑為 418/419，一項測試還在期待舊版 --help 的零綁定文案；更新該文案契約及新增保留綁定測試後，最終完整重跑 436/436。

## 命令

```sh
node --test tests/deploy/*.test.mjs tests/upgrade/*.test.mjs tests/storage/*.test.mjs tests/compat/*.test.mjs tests/runtime/*.test.mjs tests/init/*.test.mjs tests/regression/contract.node.mjs
node scripts/check-syntax.mjs
node scripts/run-python-test.mjs tests/regression/workflow3319.py .
node scripts/run-python-test.mjs tests/regression/api-regression.py .
npm ci --progress=false --no-audit --no-fund --fetch-retries=0 --fetch-timeout=15000
node scripts/build.mjs
npm test
```

本地環境 Node 22.16.0、npm 10.9.2、Python 3.13.5。完整測試檢查沒有從正式發布流程移除；本地安裝失敗不會被當成發布通過。

## 本次核心覆蓋

- KV-only + 關閉 workers.dev + 未設 URL：保留同一 KV ID 發布 web-init，不轉 direct、不清綁定。
- KV+D1 / D1-only / 零綁定：真正預設 CLI 子進程、產生配置及 build guard 跑通，所有上傳/網路由測試替身接管。
- 上傳替身使用實際生成配置回報新綁定，不用「原來就有」的假資料掩蓋遺失資源。
- D1 database_id 與舊 id 的交叉回應一致可通過；ID 缺失、衝突、無效、零 ID、重複名稱不能被當作空庫。
- 測試前/後及發布前/後綁定漂移、遺失、替換、配置/plan 一起改成清空均不能冒充保留成功。
- 未知線上綁定/本地資源注入器停止，不自動建立或刪除資源。
- 沒有新現行 deployment/version 或沒有本次 nonce/source hash，不能僅憑上傳器返回 0 報告成功。
- GET /api/upgrade/code-status 在四種綁定形態下均不呼叫 KV、D1 prepare/batch/withSession；刻意讓這些方法一被呼叫就測試失敗。
- code-status 不把資料完成編造為 true；它明示 readinessChecked:false 及 readiness:null。原 init 登入、只讀預覽、備份確認、續跑、衝突與資料驗收測試保留。
- 新增的 native Workers code-status 測試已交付但尚未執行成功，不列入 436 項通過。

## 不變項目

相對完整 v3.3.33：src 僅 version.js、upgrade-release.js、web-init.js 的 code-status 分支與 web-init-page.js 的提示文字改變。/init 明示已綁定不用重綁，排版及按鈕邏輯不變。migrations/、public/ 全部檔案逐位元組相同。帳號、訂閱、批量導入/導出及既有 init SQL 不變。package-lock.json 除應用自身根版本兩處之外與原版完全相同，沒有換依賴版本。

## 重要運行邊界

程式發布與資料 init 是兩次獨立驗收。這版不在部署階段自動備份或改庫；init 前須備妥独立備份並停止其他寫入者。Settings/現行版本不一致或 ID 看不清時仍停止，不擅自繼承未知設定。綁定完整但 D1/KV 是錯誤資源時，部署器只能確認它們是當前綁定；它不能证明是解綁前的歷史原庫。操作者仍須核對原 ID。

發布前後的控制面核驗不是跨發布器的原子鎖；不要並行另一個發布器。網址驗證缺失不等於程式未部署；資料 readiness 不從 code-status 推斷。

## 原始紀錄

本包 tests/results/v3.3.34/ 包含最終 Node TAP、語法、業務、Table API、build、Workers、npm 安裝紀錄及本輪舊版重現。生產程式差異 production-scripts.diff、production-runtime.diff 與套用驗證另見交付證據包。測試中的 ID、密碼及資料為合成測試值，不是生產憑證。
