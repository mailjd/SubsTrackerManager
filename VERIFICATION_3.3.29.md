# v3.3.29 真實事故追蹤／安全回歸

起點為 v3.3.28 ZIP。此次補丁只改部署前檢查、測試模擬器、可選 GitHub push trigger 與版本文件；不更動訂閱、帳號、歷史、模板、金鑰與 SQL migrations，且保留 Cloudflare KV-only 透過 GitHub Actions Safe upgrade 的既有路徑。

## 根因

最後錯誤 `ST_SPLIT_D1_REQUIRED` 來自 `scripts/upgrade/cloudflare-checkpoints.mjs` 建構子，而 `scripts/upgrade/cloudflare.mjs:protectBindings()` 允許線上 Worker 沒有 D1，會傳 `dbId:null`。`scripts/deploy-cloudflare.mjs` 原來先執行整套 release checks，才檢查線上綁定並建構 D1 checkpoint 物件，所以 259 項 Workers 測試及 69 項工作流通過後才失敗。**不能以測試失敗或 SQLite/密碼/依賴警告解釋這次失敗。**

## 本次改善

1. `scripts/deploy-cloudflare.mjs`：真正遠端 GET `/workers/scripts/{name}/settings` 在昂貴的 release checks 之前執行；完整安全檢查仍在且所有遠端寫入仍在檢查後。可能失敗於權限/網路；不代表遠端資源已更改。
2. `scripts/upgrade/cloudflare-checkpoints.mjs`：加入不洩漏敏感資訊的綁定清單／`ST_SPLIT_D1_REQUIRED`，明確列 KV-only Github 安全流程或核對**原** D1 兩條選項；仍拒絕無 D1 Cloudflare split。
3. 原 fake transport 加入 `FAKE_ONLINE_KV_ONLY=1`，用來重現這次事故；Node 回歸保證 **缺少 D1 → release suite 尚未開始 → 僅 1 個唯讀 GET → 不改動 KV、D1 或 Worker**。
4. GitHub `Safe upgrade` 工作流新增有條件 `push` 入口，需要明確設 `SUBSTRACKER_AUTO_DEPLOY=true`；預設不自動發布，舊 `workflow_dispatch` 不變；部署並發鎖繼續生效。需要先斷開 Cloudflare Builds 直連以免雙發布。

## 不變項

- 只使用現有 KV／D1，沒有 R2、沒有新建替代 D1、沒有移除保護/縮短 16 分鐘停寫等待。
- 訂閱/帳號/歷史/模板/密文/備份資料格式不變；既有 Source checksum 不會被無關測試輸出污染。
- 使用者 GitHub 倉庫中多出的 `src/pages-handler.js` 等檔案需要保留；發行包本身不包含那些使用者額外檔案。
- 尚未對正式 Cloudflare 做出寫入；本機檢查 ≠ 遠端驗收。

## 本次完成的回歸結果

- `node --test tests/deploy/*.test.mjs tests/storage/*.test.mjs tests/upgrade/*.test.mjs`：**159／159 通過，0 失敗、0 跳過**。證據 `tests/results/3.3.29/deploy-storage-upgrade-final.tap`。
- 專用 KV-only 直連事故模擬：預檢僅一次唯讀 GET，沒有跑昂貴 release suite、沒有遠端 PUT/POST、沒有產生維護部署或檢查點；完整測試已包括此斷言。
- `node scripts/check-syntax.mjs`：**111／111 通過**。
- GitHub Actions Workflow YAML 已解析；push 入口需 `SUBSTRACKER_AUTO_DEPLOY=true` 明確啟用；原人工 `workflow_dispatch` 保留。
- 原版 `src/data`、`src/api`、`src/core`、`src/services`、`migrations`、`public` **67 個檔案逐位元組一致**。
- 用來比對的 v3.3.28 Cloudflare 真實日誌已顯示其 259／259 Workers 測試通過；**v3.3.29 沒有重新在真實 Workers 執行器跑這 259 項**，不得把前版結果當本版測試成績。正式線上升級尚未執行。

本版能避免 KV-only 線上環境重複在完整測試後才失敗，但**沒有把缺少 D1 的 Cloudflare Git 直連變成可安全完成的發布**。使用者必須依原綁定選路徑 A 或 B；KV-only 最安全的是既有長時限 GitHub Actions Safe upgrade，而不是刪除鎖。
