# SubsTracker v3.3.29 — KV-only 原 Worker 部署修正

## 現場結論（依 2026-10-08 12:08Z 失敗日誌）

`npm run build` 已成功，Workers Vitest **27 files / 259 tests** 全部通過；儲存回歸 36/36、部署回歸 59/59、升級回歸 58/58、業務工作流 69/69 亦成功。最後停在 `ST_SPLIT_D1_REQUIRED`。這是**原 Worker 線上設定查不到可核驗的 D1 綁定 ID**，不是測試失敗，也無法據此推斷正式 D1 已損毀。未看到本輪 `ST_UPGRADE_WAIT`、`ST_UPGRADE_COMPLETE` 或實際發布成功。

### 為何不能直接忽略？

Cloudflare 原生 **分段**部署依賴既有 D1 `schema_meta` 的原子插入來排除同時發布；Workers KV 最終一致，沒有等價的原子互斥語意。**本版沒有移除 D1 安全檢查、沒有以 KV 鎖冒充 D1、沒有建立空的替代 D1，也不使用 R2。**

### v3.3.29 程式修正

1. 把 **唯讀的線上綁定檢查**提前到 12 項較昂貴的 release checks 之前，防止像本次一樣全部通過才發現缺少 D1。
2. 輸出 `ST_SPLIT_BINDING_PROBE`，僅包含原 Worker 名稱、KV/D1 綁定名稱、D1 ID 是否可讀；**不輸出 Token、密碼或資料庫 ID**。
3. 無 D1 時顯示具體恢復路徑，拒絕修改遠端；有 D1 時仍需 **完成全部測試、雙備份、原綁定核對、16 分鐘等待與最終驗收**。
4. 提供 **可選的 GitHub Actions push 自動安全升級**（不需要 D1）；預設關閉，避免 Cloudflare 與 GitHub 同時發布。

## 選擇路徑 A：你原本就有 D1，繼續使用 Cloudflare Workers Builds

進入 **這份日誌所屬的原 Worker → Settings → Bindings**。檢查名為 `SUBSCRIPTIONS_DB` 的 **原 D1** 是否仍然綁定。也要確認 Builds 的 `SUBSTRACKER_WORKER_NAME` 是同一個 Worker；若選錯 Worker，可能檢查到完全不同的 KV-only Worker。**只能恢復確實屬於原 Worker 的既有 D1；不要按名稱猜測、建立空 D1 或把資料指向其他庫。**

如果已驗證原 D1 綁定存在，再運行 `npm run deploy:cloudflare`。新日誌會先顯示 `ST_SPLIT_BINDING_PROBE` 中 `atomicLeaseReady:true`，才進入完整測試。通過遠端備份／發布後如遇 `ST_UPGRADE_WAIT`，須按 `readyAfter` 重試同一提交。最終以 `ST_UPGRADE_COMPLETE` 及 `/api/upgrade/status` 中 `maintenance:false` 為準。

## 選擇路徑 B：原 Worker 只有 KV，不建立新 D1（推薦 KV-only）

**Cloudflare Git 直連分段部署不適用；改為 GitHub Actions 長時限 Safe upgrade，仍然發布至同一 Cloudflare Worker，業務資料仍在原 KV。**

一次性操作（請按順序）：

1. 如曾有較早成功發布的維護版本，先按那一版的恢復說明處理並保留加密附件；不能與新版本混用。若各次均在測試或 D1 預檢階段停止，並未進入本次分段發布。
2. **Cloudflare → 原 Worker → Settings → Builds → Disconnect**。這只停用 Cloudflare Git 建置連線，**不是刪除 Worker、KV、D1、網域或已部署網站**。避免兩個發布器同時部署同一 Worker。
3. 將 v3.3.29 完整工程／修補包合併到**原 GitHub 儲存庫**，原 `wrangler.toml`、來源中額外的頁面適配、全部原始綁定/路由保留。不要移除安全 guard。
4. GitHub 儲存庫 → Settings → Secrets and variables → Actions 設定 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`SUBSTRACKER_BACKUP_PASSWORD`（至少 16 字元，沿用正在使用的備份密碼）。Variables 設 `SUBSTRACKER_WORKER_NAME`（**原** Worker 名稱）。有自訂網址時設 `SUBSTRACKER_WORKER_URL`（僅原 HTTPS origin）；選用命名環境時設 `SUBSTRACKER_ENVIRONMENT`。機密不可寫入 Git 或貼到聊天。
5. 在 **Actions → Safe upgrade → Run workflow** 手動執行首次發布；它完整執行測試、加密升級前備份、發布維護版、保留 16 分鐘等待、維護期備份、追加遷移、原資料逐筆驗收、解鎖。Cloudflare 仍是 Worker 執行平台，不需 R2。從 Actions 下載並另存加密附件和驗收報告。
6. **確認已 Disconnect、Actions Secrets 配置完成且沒有未完成發布**後，可新增 GitHub Actions **Repository variable** `SUBSTRACKER_AUTO_DEPLOY=true`。本版 `.github/workflows/deploy.yml` 已加入 `main/master` push 觸發；預設變數未啟用時，不會自動發布。往後推送至正式分支會自動透過 Actions 安全部署到 Cloudflare。若正式分支不是 main/master，需先把 workflow 的 branches 改為實際正式分支。

> GitHub Actions 自動發布 ≠ Cloudflare Workers Builds Git 直連。**它們是不同的部署入口，不能同時使用。** 安全升級仍需較長時間，不能用縮短停寫等待的方式追求即時部署。

## 升級完成與資料保護

- 僅使用 Cloudflare KV 與（原已綁定時的）D1；KV-only 路徑不要求 D1；**不使用 R2**。
- 仍要求所有正式型別檢查、Workers Vitest、備份、加密附件/還原驗證及歷史追加，不會跳過失敗測試。
- 任何來源綁定不一致、備份不完整、密碼錯誤、資料有衝突都會停止，**不清空或建立替代資料庫**。
- 沒有登入你的 Cloudflare 帳戶，不能在這份交付中聲稱已成功發布或驗證你線上的資料。

官方參考：
- Cloudflare Workers Builds 解除綁定：https://developers.cloudflare.com/workers/ci-cd/builds/
- Cloudflare D1 綁定：https://developers.cloudflare.com/d1/best-practices/remote-development/
- KV 最終一致性：https://developers.cloudflare.com/kv/reference/faq/
- GitHub Actions / Workers：https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/
