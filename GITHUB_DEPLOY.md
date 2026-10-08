# GitHub / Cloudflare 發布入口

當前版本：3.3.21。

**操作步驟：`CLOUDFLARE_DEPLOY_FIX_3.3.21.md`。**

在原 GitHub 儲存庫建立三個 Repository Secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`SUBSTRACKER_BACKUP_PASSWORD`；核對原 `SUBSTRACKER_WORKER_NAME`，自訂網域設定 `SUBSTRACKER_WORKER_URL`。

Cloudflare 原 Worker → Settings → Builds → Disconnect（只斷開 Git 連線）。保留原 Worker/KV/D1；停用其他同時發布器。

解壓後更新專案根目錄，包括 `.github/workflows/deploy.yml`，保留原 Wrangler 專屬設定。原 repo Actions → Safe upgrade → Run workflow；只看 Test 工作流成功不等於已部署。

本 workflow 維持必要測試、備份上傳後才部署、16分鐘等待、逐項驗收與失敗恢復附件。不要刪除 guard 或改回 raw `npx wrangler deploy`。

完整流程與復原：`SAFE_UPGRADE_3.3.21.md`。
