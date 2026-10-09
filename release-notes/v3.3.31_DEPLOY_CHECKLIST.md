# v3.3.31 直接升級檢查

1. 更新原 repository 的程式，保留原 wrangler.toml、Worker 名稱與 Git 連接。不要套回舊 CodeOnlySafetyGate 或獨立升級輔助工具。
2. 原 Build command 為 `npm run build`，原 Deploy command 為 `npm run deploy:cloudflare`，不需要修改為其他服務或工作流。
3. 原 Cloudflare Account ID、API Token、SUBSTRACKER_BACKUP_PASSWORD（至少16字元）、可選的 Worker 名稱/環境/網址沿用。
4. 提交後觸發同一次建置及部署。日誌應有 `ST_DIRECT_BINDINGS_OK`，KV-only 是可接受結果，不會再要求 D1 發布鎖。
5. `ST_DIRECT_BACKUP_OK` 後單次發布；只有核對同一 runId、新版及原綁定後才顯示 `ST_UPGRADE_COMPLETE`、`mode:direct-compatible`、`maintenance:false`。
6. 不需要等待16分鐘或 Retry 第二階段。原站真的已有未完成的資料遷移、綁定衝突、密鑰缺失或不兼容舊結構時仍停止，不偽造成功。
7. 直接升級備份的下載指令由日誌提供：`npm run upgrade:download -- <backup UUID>`。原密碼需另行妥善保存。

完整說明見 DEPLOY_REPAIR_3.3.31.md。本地測試不等於使用者 Cloudflare 的線上驗證。
