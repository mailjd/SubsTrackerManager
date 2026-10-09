# v3.3.33 部署與 init 核對

詳細指南：`DEPLOY_REPAIR_3.3.33.md`。本文件取代上一版頂層部署清單；舊清單在 release-notes。

1. 先獨立備份原 D1/KV，記錄原 Database ID、Namespace ID、Worker／帳戶／原 Secrets；停止其他寫入者。
2. 合併本版程式至原 repository 根目錄。package.json 與 package-lock.json 同時更新，保留自訂 wrangler.toml。
3. 只移除原 Worker 的 D1/KV Bindings，儲存／部署設定。不要刪除資源、原 Worker、密鑰或備份。
4. 推送本版，保持 Build `npm run build`；Deploy `npm run deploy:cloudflare`。不要串接舊 code-only check 或手動 wrangler deploy。
5. 確认本次 `ST_CODE_DEPLOYED_AWAITING_BINDINGS`，version 3.3.33，codeDeployed true，applicationReady false。
6. 同一 Worker 綁回原 ID：KV → SUBSCRIPTIONS_KV；D1 → SUBSCRIPTIONS_DB。儲存並部署 Binding 變更，保留剛發布的程式。
7. 確認執行時 Secret SUBSTRACKER_SUPERADMIN_PASSWORD（不是 Builds Secret）；已有 SuperAdmin username 時沿用。
8. 開原站 /init；重新檢查綁定 → SuperAdmin 驗證 → 不寫入預覽 → 核對原資料、原 ID 與備份 → 執行／繼續 init。
9. 等待 ST_WEB_INIT_COMPLETE、applicationReady true、maintenance false；確認原登入、訂閱／帳號／歷史／範本正常，再恢復其他寫入者。
10. 中斷從同版 /init 重新驗證續跑；KV 收據等待不等於失敗。遇到資料衝突停止，不刪庫、不重設 config、不偽造完成狀態。

程式發布成功和資料升級成功是兩個階段。執行 init 前可停留等待頁，不需要先發布舊維護版本或等待16分鐘。

## 本版新增核對

預設固定 deferred-web-init，automaticFallback:false。殘留 D1/KV 時按日誌核對精確 Worker 與 activeVersion，不會轉 direct。

SUBSTRACKER_WORKER_URL 為可選 Build 變數；ST_URL_NOT_VERIFIED 不等於程式尚未發布。先核對 ST_CODE_RELEASE_VERIFIED，再處理原網域可達性。不要為此重新觸發 Git 或開啟 workers.dev。

資料驗證仍以網頁 ST_WEB_INIT_COMPLETE 為準。詳見 DEPLOY_REPAIR_3.3.33.md。
