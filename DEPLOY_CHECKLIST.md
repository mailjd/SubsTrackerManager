# v3.3.34 部署檢查清單

以 DEPLOY_REPAIR_3.3.34.md 為準；不要沿用「必須先解綁」的舊步驟。

1. 保留原資源、ID、Secrets 與獨立資料備份。停止其他寫入者和並行發布器。
2. 解壓累積修補至根目錄，覆蓋同名檔，package.json/package-lock.json 同時更新。保留原 wrangler.toml。
3. 已綁原 KV/D1 不解除、不重建；Build npm run build，Deploy npm run deploy:cloudflare，提交本版。
4. 核對版本 3.3.34、bindingPolicy preserve-active、ST_WEB_INIT_BINDINGS_PRESERVED 的原名稱/ID。
5. 核對 ST_CODE_RELEASE_VERIFIED。AWAITING_INIT 表示直接 /init；AWAITING_BINDINGS 表示只補綁缺項的原資源再 /init，不重推 Git。
6. 原 Worker 執行時 SuperAdmin Secret 驗證、只讀預覽、確認原庫和備份後才執行 init。
7. ST_WEB_INIT_COMPLETE、applicationReady:true、maintenance:false 後核對資料並恢復使用。中斷在同版 /init 續跑，不強制改收據。

網址核驗与資料完成是獨立狀態。ST_URL_NOT_VERIFIED 不等於程式沒有上傳；不自動開啟 workers.dev。
