# GitHub 部署 v3.3.20

唯一正式流程為本包 `.github/workflows/deploy.yml` 的 **Safe upgrade**。詳細操作見 [SAFE_UPGRADE_3.3.20.md](SAFE_UPGRADE_3.3.20.md)。

保留原帳戶、原 Worker、原 KV namespace ID、原 D1 database ID 和原加密密鑰。新增 Repository Secret `SUBSTRACKER_BACKUP_PASSWORD`（至少16字元，獨立保密保存），保留原 Cloudflare Token／Account ID。原 Worker 名稱不是模板 `subscription-manager` 時，設置 Variable `SUBSTRACKER_WORKER_NAME` 為準確原名稱；自訂域名設 `SUBSTRACKER_WORKER_URL`。

更新來源與安全工作流，保留原 wrangler 中的識別資料并合入 `[build]` 保護命令。停用任何平行的舊部署器，避免未驗證發布。工作流測試失敗就停止；升級前與維護期加密備份 Artifact 上傳完成才執行下一步。

維護等待16分鐘之外還有測試／備份時間。完成條件不是「deploy 綠燈」，而是最後的 acceptance 資料保留和還原校驗全部為 true。失敗時下載恢復 Artifact，依安全指南 resume；不要清庫重跑初始化。
