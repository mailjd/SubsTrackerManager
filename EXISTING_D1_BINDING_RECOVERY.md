# SubsTracker v3.3.29 — 原 D1 綁定真因與恢復（非新版本升級）

依 2026-10-08 12:52 UTC 實際日誌：`subscription-manager` 的 **線上版本**由 Cloudflare `/workers/scripts/subscription-manager/settings` 回傳 `SUBSCRIPTIONS_KV`，但 `d1Bindings:[]`，故 `ST_SPLIT_D1_REQUIRED` 停在發布前。這不等於帳戶完全不存在任何 D1，也無法證明原 D1 已損壞或遺失資料。

## 重大配置缺口

目前包中的 `wrangler.toml` **沒有 `[[d1_databases]]`，也沒有 `[[kv_namespaces]]` 原 ID 宣告**。該工具之前依賴「正式線上綁定 → 升級時生成臨時 `wrangler.upgrade.json`」。一旦正式線上版本沒有 D1，根本無法自動核實原 ID、生成正確安全配置。`keep_vars=true` 不能用於保證保留資料庫或 KV bindings。Cloudflare 官方建議讓 Wrangler 檔案成為配置來源。

## 先選正確路徑，不能亂接資料庫

### A. 帳戶原本存在**有真實業務資料的 D1**

1. 從 Cloudflare 控制台確認帳戶、Worker、**既有 D1 ID**，核對 D1 內有 `schema_meta`、`subscriptions_current`、`subscription_history`、`accounts` 等原業務資料表。不要以同名空庫代替。
2. 進入產生錯誤日誌的 **同一個 Worker `subscription-manager`** → Settings → Bindings → Add D1 database binding，名稱要 `SUBSCRIPTIONS_DB`，選**原 D1**。完成保存並確認該設定已在當前生效 Worker 版本中，而不是停留在未發布的草稿／Preview／別的環境。
3. 不要立即反覆 Retry。可以在可信的本地環境或已具備 Secrets 的 CI 中執行 `npm run binding:doctor`（只查線上設定，不改資料）。成功時才會顯示 `D1_PRESENT_CHECK_ID_AND_SCHEMA`。
4. **把綁定固定到版本庫**：在可信的本地終端設定 `SUBSTRACKER_ORIGINAL_D1_ID` 為**已核實的原 D1 UUID**，執行 `npm run binding:pin`。工具會核對它與線上 Worker 的 D1 ID 相同、原 KV 不變，並用唯讀 SELECT 核對原 D1 業務結構後，才會將兩個原資源 ID 寫入**本地** `wrangler.toml`，另存 `.binding-backups/` 備份。它不呼叫遠端部署／建立／刪除 API。對照 git diff 確認只有原 ID，再提交。`SUBSTRACKER_ENVIRONMENT` 存在時，它會寫入該指定環境；注意 Wrangler 的命名環境 bindings 不自動繼承根配置。
5. 沿用 `Build: npm run build`、`Deploy: npm run deploy:cloudflare` 和原密碼；提交新配置後再進入原安全升級。最後須 `ST_UPGRADE_COMPLETE` 和 `maintenance:false`。

### B. 找不到原業務 D1，或原 Worker 一直只有 KV

方法 A **不能實現**，因為沒有可安全核實並還原的原 D1。不要跳過 D1 鎖、使用離線 dry-run 的全零 ID、創建空 D1、或將別的庫偽裝為原庫。應停止 Cloudflare Workers Builds 分段部署，切換到本專案已提供的 GitHub Actions `Safe upgrade` 長時限流程。先斷開 Cloudflare Builds Git 自動部署，避免雙重發布；按 `KV_ONLY_DEPLOY_3.3.29.md` 設置 Actions Secrets 並手動執行一次，成功後再選擇推送自動部署。

## 新增診斷／修復指令

```bash
npm run binding:doctor
```

此命令使用現有 `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN` 及 `SUBSTRACKER_WORKER_NAME`，只讀取已部署 Worker 的設定，輸出名稱、布林值、環境，不會輸出 Token 或儲存 ID。若找不到線上 D1 會**以非零狀態停止**，不會假裝已修好。

```bash
# 只有原 D1 已重新出現在同一個 Worker 的線上設定時才使用：
# 在本地終端自行設定真實、已核實的 SUBSTRACKER_ORIGINAL_D1_ID
npm run binding:pin
```

`binding:pin` 發送的請求僅為 Worker 設定 GET、D1 metadata GET、D1 `/query` 唯讀 SELECT；本地更新 `wrangler.toml` 時保留原內容及備份。沒有將任何既有帳密、歷史、模板或訂閱從 KV 搬走。

## 本次本機驗證邊界

針對上述保護已執行自動化 Node 測試，包括線上缺 D1、錯誤／全零 ID、錯帳戶資源、空 D1、不同環境、TOML 有效性、檔案覆寫防護及備份。**不能聲稱已登入 Cloudflare、恢復你原 D1 或完成線上發布。**

官方參考：
- https://developers.cloudflare.com/workers/wrangler/configuration/
- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/
- https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
