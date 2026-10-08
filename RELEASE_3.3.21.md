# v3.3.21 DeploymentEntryFix — 2026-10-08

修正 Cloudflare 一般 Git Build 與安全升級工作流入口不一致造成的部署中止判讀。

本次重點：明確平台／設定預檢、可操作錯誤代碼、未準備時不載入 SQLite 還原依賴、獨立本機測試配置、GHA工作流預檢與結果說明。保留正式保護、备份、原綁定、維護等待與逐項驗收。

**不是刪除guard的「直連可部署版」**。請按 `CLOUDFLARE_DEPLOY_FIX_3.3.21.md` 改由原 GitHub Actions → Safe upgrade 發布；只重試原 Cloudflare Git Build 不會成功。

本機188項回歸與93項語法檢查通過；本環境依賴下載失敗，完整 Workers Vitest／型別檢查／真實 Wrangler 發布未完成，工作流繼續保留這些發佈前必要檢查。實際結果與邊界見 `VERIFICATION_3.3.21.md`。

資料模型、SQL遷移、帳號／模板鍵及表格保存規則沒有變更。請保留原Cloudflare資源、原加密密鑰和加密備份。
