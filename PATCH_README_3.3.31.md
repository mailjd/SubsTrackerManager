# v3.3.31 直接升級修補包

適用基準：使用者提供的完整 v3.3.29（KVOnlySafeDeployFix_20261008），以及其後交付的完整 v3.3.30（DeploymentBindingFix_20261009）。這是原應用程式的修補，不是獨立升級輔助工具。

## 套用

將修補 ZIP 內的檔案按原路徑合併到既有 repository 根目錄，覆蓋同名檔案。根目錄是原 package.json / wrangler.toml 所在位置，不要放成 scripts/scripts 或 scripts/src。需要一起更新 package.json 和 package-lock.json。

**修補包不含 wrangler.toml**，不會覆蓋自訂 Worker 名稱、Account ID、環境或網址。原完整版本的 wrangler.toml 在 3.3.29、3.3.30、3.3.31 逐位元組相同。其他被覆蓋檔案若有自行修改，需要保留其自訂差異；不會自動刪除既有 repository 的額外檔案。

Cloudflare Builds 仍使用：

```text
Build command: npm run build
Deploy command: npm run deploy:cloudflare
```

提交本版程式後由同一個 Git 連接觸發部署。保持原 Builds Secrets/Variables；不需新增 D1、不改綁現有 D1、不需中斷 Git 連接、不用切換 GitHub Actions、不用新增任何 skip 開關、不需先發布維護版本後等16分鐘重試。不要同時用其他發布器部署同一 Worker。

原 npm run deploy:cloudflare 現在預設是 direct-compatible；無需額外參數。不再串接舊的 deploy:code-only:check。

## 內容

本修補包含從上述任一乾淨完整基準升到3.3.31所需的聯集檔案，因而也包含3.3.30的原綁定核對修復。PATCH_3.3.29_3.3.30_TO_3.3.31.json 列出來源SHA-256與交付SHA-256；FILE_MANIFEST_3.3.31.json 用於最終檔案完整性核對。

舊版說明/測試/恢復程式仍保留作為歷史資料，不是本版的預設部署方案。当前操作以 DEPLOY_REPAIR_3.3.31.md 為準。

詳細修改、已通過與尚未執行的驗證見 VERIFICATION_3.3.31.md。
