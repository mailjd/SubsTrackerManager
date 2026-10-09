# v3.3.31｜原站單次直接升級

## 本次日誌根因

提供的 2026-10-09 08:58 UTC 日誌顯示 v3.3.30 建置、型別檢查與 Wrangler dry-run 已成功；失敗是在 deploy:cloudflare 主動拋出 ST_SPLIT_D1_REQUIRED。settings 與 active-deployment 都顯示目標 subscription-manager 為 KV-only，原入口卻強制使用需要 D1 原子鎖的兩階段資料遷移。這不是 npm 棄用警告或建置編碼錯誤。

## 直接套用

沿用原 Cloudflare Workers Builds Git 連接、Worker、綁定與 Builds 變數/機密。更新 repository 根目錄的程式，保留自訂 wrangler.toml；套用差異包時沒有必要改 Wrangler 檔。Build command 與 Deploy command 分別仍是：

```text
npm run build
npm run deploy:cloudflare
```

提交更新後同一次部署即可走完整個預設流程；不需選方案 A/B、不新增資料庫、不改 GitHub Actions、不新增 skip 環境變數、不等16分鐘、不手動重試第二階段。不要繼續串接舊的 deploy:code-only:check。

## 流程與修改範圍

- `scripts/deploy-cloudflare.mjs` 預設呼叫直接部署；`scripts/deploy.mjs` 使用同一入口。
- 原先 v3.3.30 的 D1 綁定補查與命名環境修復保留；KV-only 明確通過，不猜測綁定帳戶內另一個 D1。
- 原 RELEASE_CHECKS 全部保留；新增直接流程測試由 test:deploy 執行。失敗不會轉成 exit 0。
- 部署前線上唯讀快照、解密校驗、SQLite 記憶體還原完整性檢查後，加密存到原 KV 的專用獨立前綴。
- 只發布一次 Worker；同時使用新的 direct-compatible 運行門禁，不會卡在旧 UPGRADE_MAINTENANCE 完成標記。
- 發布前再次核對現行部署、原綁定、Variables、Secret 名稱及網站維護狀態；發布後再核對 runId/版本/門禁及原綁定。
- 配置明確填回原 KV / 原已綁定 D1 ID；使用原線上變數及 Cron，keep_vars=true。原 wrangler.toml 不被程式修改，臨時配置不提交 Git。
- 不建立 D1/KV、不執行資料庫初始化/清庫/還原命令，不寫入業務記錄。備份確實新增原 KV 的專用 key，並非「完全零 KV 寫入」。

## 驗收日誌

```text
ST_DEPLOY_ENTRY ... mode: direct-compatible ... continuation: single-build
ST_DIRECT_BINDINGS_OK ... storage: KV-only ... d1Required: false
ST_DIRECT_BACKUP_OK ... remoteVerified: true
ST_DIRECT_GUARD_OK
ST_DIRECT_PUBLISH
ST_UPGRADE_COMPLETE ... version: 3.3.31 ... maintenance: false
```

只有最後一項代表本次腳本完成新版啟站核驗。Wrangler 退出0但狀態錯版/舊 runId/維護模式時仍失敗，不假報成功；發布後錯誤也不宣稱程式從未上傳。

## 與舊兩階段流程的實質差異

本版預設是兼容結構的程式升級，不是在沒有原子鎖的 KV 上強行執行同一套停寫遷移。沒有16分鐘 drain、沒有 D1 發布鎖、沒有部署期批量歷史補遷移。應用原本的 ensureMigrations/ensureD1Seed/ensureLedgerSeed 及正常 API、Cron 讀寫邏輯沒有刪除；既有 v3 資料沿用既有按需初始化與增補能力。

原站保持運作，線上備份不是全域一致的交易快照。原業務可能在快照讀取期間繼續寫入；不能宣稱它等同於先停站後的資料遷移快照。部署前的版本重驗不是分布式原子鎖；同一 Worker 不要並行使用另一發布器。

偵測到舊站本來正在維護/資料遷移、不支持的舊 KV schema、缺 JWT/加密密鑰、會觸發早期 accounts 表重建的 D1 結構時仍停止。這些是明確的資料風險，不是因 KV-only 而禁止升級。本次提供的日誌是在發布前停止，沒有顯示已進入維護階段。

## 備份

原密碼 `SUBSTRACKER_BACKUP_PASSWORD` 沿用，不更改網站登入密碼或凭據密鑰。

```text
npm run upgrade:download -- <本次日誌 backupId>
```

只下載及核驗，不執行資料還原。備份包含線上資料、舊 Worker 程式及設定，但不包含 Cloudflare 無法讀回的 Secret 明文。備份預設不自動過期或清理，以免自動刪除恢復資料；會占用原 KV 容量與請求配額。

舊分段流程保留在 deploy-cloudflare-split.mjs，僅由顯式 deploy:split / 舊 download 呼叫；不是使用者本次直接升級需選擇的方案。已有舊批次要用其原版本與原密碼恢復，本版不冒充完成原批次。

## 驗證界線

詳見 VERIFICATION_3.3.31.md。未使用使用者 Cloudflare Token，未執行線上發布。無法安裝鎖定 npm 依賴的限制如實列出；模擬發布測試不是 Wrangler 編譯或線上成功的證明。

## 外部技術依據（非使用者日誌）

- Cloudflare Workers versions/deployments： https://developers.cloudflare.com/workers/versions-and-deployments/
- Wrangler --keep-vars 與 Secrets： https://developers.cloudflare.com/workers/wrangler/commands/workers/
- KV 的最終一致性及原子操作限制： https://developers.cloudflare.com/kv/concepts/how-kv-works/

以上只用於核對平台規則，問題根因來自本次日誌與附件原始碼。
