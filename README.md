# SubsTracker v3.3.21｜部署入口修正

**既有資料保留、安全驗收通過才開站。應用仍運行在原 Cloudflare Worker。**

## Cloudflare 部署 error 的處理

看到 `node scripts/require-safe-upgrade.mjs` exit code 1，是一般 Wrangler／Cloudflare Git 直連入口未執行備份與原綁定驗證，被安全檢查拒絕。

**先看 `CLOUDFLARE_DEPLOY_FIX_3.3.21.md`。不要只替換 ZIP 後在 Cloudflare Retry，不要刪掉 [build]。**

本版使用原 GitHub 儲存庫的 **Actions → Safe upgrade** 發布。斷開的是 Cloudflare 的 Git Builds 連線，不刪除原 Worker 或原儲存。工作流含16分鐘維護等待，不應放入20分鐘時限的 Workers Builds。

## 操作文件

- `CLOUDFLARE_DEPLOY_FIX_3.3.21.md`：這次 error 的逐步處理、Secrets／Variables、正確入口。
- `SAFE_UPGRADE_3.3.21.md`：完整加密備份、資料驗收、維護與中斷恢復。
- `VERIFICATION_3.3.21.md`：本次實際測試及驗證邊界。

`npm run deploy:check` 僅本地預檢；`npm run deploy:safe`／三階段命令維持原安全流程。原業務記錄、Database、模板及 SQL 遷移結構不改；資源 ID 不一致即停止。

此包不是全新安裝器，禁止為解決部署錯誤重建空資料庫。已在維護的舊批次需先使用同版來源及該次憑證恢復，不混用版本。
