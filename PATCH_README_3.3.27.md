# 3.3.26 → 3.3.27 差異修補

目前倉庫已是3.3.26時，將差異ZIP解壓後的相對路徑合併到原倉庫根目錄並提交。不是上傳ZIP本身，不刪除原目錄。

沒有wrangler.toml變更，不替換原Worker/Account/KV/D1設定，不移除pages-handler或使用者額外superadmin測試。操作前用Git核對自訂檔案是否與同路徑修正有衝突。變更清單與before/after摘要見PATCH_3.3.26_TO_3.3.27.json。

原Build command與Deploy command及備份密碼保持不變。詳細步驟見DEPLOY_REPAIR_3.3.27.md；測試範圍、npm依賴下載失敗與尚未完成原生Workers全套驗證的限制見VERIFICATION_3.3.27.md。此包不承諾線上驗收已完成。
