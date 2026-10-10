# SubsTracker v3.3.34｜保留原 KV／D1，發布後網頁 init

**已綁原資源 → 保留原 ID 發布程式 → /init 驗證及更新 → 核驗通過才開站。未綁齊也能先發布等待頁，不建立新庫。**

完整步驟：[DEPLOY_REPAIR_3.3.34.md](DEPLOY_REPAIR_3.3.34.md)。驗證結果與限制：[VERIFICATION_3.3.34.md](VERIFICATION_3.3.34.md)。

本版修正 v3.3.33 的「必須零綁定」阻擋。KV-only、D1-only、KV＋D1、無綁定都固定使用 deferred-web-init；不切回 direct/split、不反覆要求解綁、不改資料庫 ID。來源不一致或 ID 缺失仍停止，不能清空綁定來偽造通過。

原 Cloudflare Git 不變，Build `npm run build`，Deploy `npm run deploy:cloudflare`。修補包解壓至原 package.json 所在根目錄，保留 wrangler.toml 與 Secrets，不串接舊 code-only check。

程式發布結果 `ST_CODE_RELEASE_VERIFIED` 後，已綁齊會顯示 `ST_CODE_DEPLOYED_AWAITING_INIT`；缺項顯示 `ST_CODE_DEPLOYED_AWAITING_BINDINGS`。**兩者都不等於資料已完成。** 只有 /init 的 `ST_WEB_INIT_COMPLETE` 才能確認資料驗收。部署器不建立資料備份；init 前須有獨立備份及確認原資源。

此版本的完整線上部署尚未驗證；詳細本地測試與依賴安裝限制已寫入驗證報告。

## 歷史文件

舊 README 與部署清單保存在 release-notes；根目錄帶舊版號的文件只作歷史紀錄，不作本版操作指引。應用既有訂閱、帳號、批量導入／導出與業務 UI 保留；/init 僅更新「已綁不用重綁」提示文字。
