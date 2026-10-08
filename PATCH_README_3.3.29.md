# v3.3.28 → v3.3.29 安全修補包

- **優先將此 ZIP 解壓後按相對路徑合併進原 Git 倉庫**，不要直接上傳 ZIP 當原始碼，也不要用整個乾淨 src 目錄覆蓋使用者自己的額外檔案。
- 原 `wrangler.toml` 的 Worker 名稱、已有 KV/D1 ID、路由、密鑰、額外 `src/pages-handler.js` 與其他使用者原始碼保持不變。
- 本包提供真實 Worker D1 綁定的**唯讀預檢**，不會自行為 KV-only 新建 D1；故 KV-only Cloudflare Git 直連仍會被明確攔截，但在昂貴測試之前就得到根因。
- 若原 Worker 確實只有 KV，按 `KV_ONLY_DEPLOY_3.3.29.md` 改用長時限 GitHub Actions `Safe upgrade`，而不是禁用原子鎖或忽略錯誤。推送自動部署需先停用 Cloudflare Builds 直連並在 GitHub Actions Variables 明確設 `SUBSTRACKER_AUTO_DEPLOY=true`，默認不啟用。
- 若 D1 本來就存在，核對原 Worker 的 `SUBSCRIPTIONS_DB` D1 綁定以及正確的 `SUBSTRACKER_WORKER_NAME`；不要把任意新 D1 誤當舊庫。
- 成功完成仍須原完整測試、加密備份、16 分鐘維護等待、原記錄驗收與 `/api/upgrade/status` 的 `maintenance:false`，而不是只看 Build 的成功訊息。
