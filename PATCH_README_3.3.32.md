# v3.3.29 / v3.3.30 / v3.3.31 → v3.3.32 累積修補

基準是本對話提供的三個完整發布 ZIP；應用累積修補後逐檔核對結果見 VERIFICATION_3.3.32.md。自訂 repository 仍需先比對合併；驗證不代表能替你判定額外自訂程式是否相容。

把本包內容按原路徑合併到原 package.json 所在根目錄，覆蓋同名檔案。不要新建外層 scripts 資料夾。package.json、package-lock.json 必須同時更新。

**本包不包含 wrangler.toml；不覆蓋原 Worker／帳戶／命名環境。** 沿用原 Git、原部署憑證、原資料資源、原 Secrets。鎖定依賴版本未變，只更新根套件版號及新增測試入口。

接著按 UNBOUND_WEB_INIT_3.3.32.md：獨立備份 → 只解除兩個 Worker Binding → 部署程式 → 綁回原 ID → 網頁 /init。不要套用舊 CodeOnlySafetyGate、升級輔助工具或直接 Wrangler 發布。

保留你原先的備份及密鑰。本包不是備份檔，也不含使用者線上資料或 Cloudflare 憑證。
