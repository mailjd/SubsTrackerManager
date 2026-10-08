# v3.3.23 GitHub Actions（可選長流程）

一般Cloudflare Git直連繼續使用`npm run deploy:cloudflare`，不必切換發布器。

要使用GitHub長流程時，在原repo的Actions選Safe upgrade手動執行；保留原Cloudflare憑證、資源ID及備份密碼，不與Cloudflare發布並行。流程保留D1＋KV核對、完整測試、加密備份、維護等待、驗收與恢復附件。

D1來源改為query-only，不需要R2。此可選工作流仍把加密備份另存GitHub Actions artifacts（CI附件而非業務資料庫）；Cloudflare原生分階段入口則把恢復檢查點放在原KV／D1。

見 `SAFE_UPGRADE_3.3.23.md` 及 `D1_KV_ONLY_3.3.23.md`。原Secret不要貼到聊天或寫入Git。
