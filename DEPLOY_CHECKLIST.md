# v3.3.21 部署檢查表

- 原 Cloudflare Worker 的 Git Builds 已斷開；沒有兩套發布器同時操作同一 Worker。
- 原 repo 已更新解壓後的所有專案內容，尤其 `.github/workflows/`、`scripts/`、測試設定；不是只上傳 ZIP。
- 三個 Repository Secrets 已在 GitHub Actions 配置，沒有寫入公開原始碼。
- `SUBSTRACKER_WORKER_NAME` 指向原 Worker，原 KV/D1 ID、密鑰、模板沒有清除或改綁。
- Safe upgrade 在 GitHub Actions 執行；本地部署前檢查／型別／測試通過後才建立備份和發布維護版本。
- 升級前／維護期加密備份都先上傳成功，才進下一步。
- 最終驗收成功，`/api/upgrade/status` 為 3.3.21、maintenance:false；保留加密附件與 acceptance 報告。
- 未驗收完成不強行解鎖、不重建儲存；依同版文件使用恢復憑證。

逐步介面說明：`CLOUDFLARE_DEPLOY_FIX_3.3.21.md`。
