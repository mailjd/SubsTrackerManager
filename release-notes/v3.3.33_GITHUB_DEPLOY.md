# v3.3.33｜保留原 Cloudflare Git 連接

本次「先解綁 → 程式部署 → 綁回原資源 → /init」**不需要改 GitHub Actions**。繼續使用原 Cloudflare Git 整合，以及 Build `npm run build` / Deploy `npm run deploy:cloudflare`。

請按 `DEPLOY_REPAIR_3.3.33.md` 操作。不要同時執行另一個 Safe upgrade 工作流。

## 下方僅為歷史可選長流程，不是這次操作步驟

# v3.3.26 GitHub Actions（可選長流程）

原GitHub倉庫 → Actions → Safe upgrade → Run workflow；仍是手動入口，不隨Push與Cloudflare同時發布。

工作流先核對環境，再npm ci，再依賴/真實dry-run/型別/語法/儲存/部署/升級/業務/Workers測試；完整加密備份附件上傳後才stage，維護備份保存後才finish。沒有刪除16分鐘等待、備份或驗收。

沿用原Worker/D1/KV，只在GitHub配置原Cloudflare憑證與備份密碼；不需要R2。原本已有分段未完成批次要先按同版指南恢復，不同來源不可混用。

完整參數及恢復操作：`SAFE_UPGRADE_3.3.26.md`。Cloudflare Git入口改法：`DEPLOY_REPAIR_3.3.26.md`。本次驗證邊界：`VERIFICATION_3.3.26.md`。

本版新增 test:runtime（Python 標準庫 + Node SQLite 實際能力）；不再要求 Python 的 sqlite3/_sqlite3。相關測試仍完整執行，詳見 DEPLOY_REPAIR_3.3.26.md。
