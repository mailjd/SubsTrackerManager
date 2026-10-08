# v3.3.20 升級檢查清單

## 發布前
- [ ] 現有來源是 v3.3.18／3.3.19；不是對空資料庫重新安裝。
- [ ] 已核對原 Worker 名稱、Cloudflare Account ID、KV namespace ID、D1 database ID。
- [ ] 原 Worker Secrets／KV 加密密鑰未重設，未更換資料庫綁定。
- [ ] 新增獨立 `SUBSTRACKER_BACKUP_PASSWORD`，至少16字元并離線保存。
- [ ] 本包 Safe upgrade 是本次唯一部署工作流，沒有平行舊發布器。
- [ ] 所有單格暫存先保存；暫停外部直接寫入 KV／D1 的腳本。
- [ ] 語法、型別、回歸與 Workers 測試均通過；失敗不繞過。

## 自動放行條件
- [ ] 完整原儲存備份兩次掃描一致，解密／SQLite 還原檢查通過。
- [ ] 升級前及維護期加密備份已另存，CI Artifact 上傳成功。
- [ ] 新版維護模式與 runId 確認；已等待舊作業退出。
- [ ] 歷史分批增補持續前進，沒有含糊來源／缺失索引／衝突支付。
- [ ] 原 KV key 和原 SQL 列／欄位逐項保留，非僅總數一樣。
- [ ] 生成遷移後加密備份及 acceptance，服務端 commit 後才解除維護。

## 發布後
- [ ] `/api/upgrade/status` 為 3.3.20、maintenance=false，runId 與報告一致。
- [ ] 保存診斷前後端 3.3.20／協議2；實際編輯保存再重新登入讀回。
- [ ] 當前訂閱、訂閱歷史、Database、帳號密碼狀態、模板皆核對。
- [ ] 加密備份、manifest、驗收報告已下載，備份密碼另存。

中斷時依 SAFE_UPGRADE_3.3.20.md 用原加密恢復憑證續跑；不清庫、不刪標記、不重建空綁定。
