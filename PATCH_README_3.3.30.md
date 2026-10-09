# v3.3.29 → v3.3.30 差異修补套用

此包只適用於使用者提供的完整 v3.3.29，或以該完整版本為基礎的現有 repository。不是可獨立部署的完整應用，也不是先前的升級輔助工具。

先保留原 repository 副本，然後將 ZIP 內的同名路徑**合併到原 repository 根目錄**。覆蓋列出的修改檔案，新增列出的新檔案；未列出的原檔不刪除。

**不包含 `wrangler.toml`，不要換成空白範本。** 保留原 Worker、帳戶、KV、D1、環境、網址及備份密碼。若本地對將覆蓋的檔案有自訂修改，先比對合併；不要盲目丟棄自訂內容。四個版本檔案須一起更新。

不需再次套用舊 CodeOnlySafetyGate 補丁。原安全部署入口仍是 `npm run deploy:cloudflare`，Cloudflare Build command 仍是 `npm run build`。所有依賴版本不變；安裝命令 `npm ci --include=dev`。

線上若已進入未完成的舊版維護批次，先使用該批次的原提交與原備份密碼完成／恢復；不可用新版本覆蓋舊 checkpoint。

差異清單：`PATCH_3.3.29_TO_3.3.30.json`。完整操作：`DEPLOY_REPAIR_3.3.30.md`。實際測試／未完成項目：`VERIFICATION_3.3.30.md`。逐檔核對：`FILE_MANIFEST_3.3.30.json`。
