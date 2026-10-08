> v3.3.23 補充：儲存與備份限定 D1＋KV；D1 備份改用 query，不使用 export/signed URL。不需開通 R2。先讀 `D1_KV_ONLY_3.3.23.md` 的現況、操作與支援邊界。

# SubsTracker v3.3.23｜Cloudflare Git 直連分階段部署

日期：2026-10-08。原包：v3.3.21。這次新增真正的 Workers Builds 發布入口，不只是改寫錯誤訊息，也沒有移除資料保護。

## 最重要的一次性設定

**保留原 Cloudflare Worker、原 Git 連線、原 KV／D1。不要 Disconnect，不要刪除或重建資料庫。**

在 **Cloudflare → Workers & Pages → 原 Worker → Settings → Build／Builds** 修改：

| 項目 | 本版設定 |
|---|---|
| Build command | 留空。本專案不需要額外前端編譯；不要在這裡填發布命令。 |
| Deploy command | `npm run deploy:cloudflare` |
| Root directory | 實際包含 `package.json` 與 `wrangler.toml` 的專案目錄。 |
| Production branch | 保持原正式分支；不要對測試分支發布正式資料庫。 |

**只換 ZIP 然後保留 `npx wrangler deploy` 重試，仍然會被保護檢查拒絕。** ZIP 不能替你修改控制台已保存的 Deploy command。設定保存後才 Retry 新版所在的提交。

不要把 `npm run deploy:cloudflare` 填到 Preview command；本入口發布原正式 Worker，不是建立隔離預覽。本包僅面向 Workers，不是 Cloudflare Pages。

## 1. 更新原儲存庫

將 ZIP 解壓後的專案內容更新到原 Git 儲存庫，包含 `scripts/`、`src/`、`tests/`、`.github/workflows/`、`.node-version`、`package.json` 和 lock。不是只上傳 ZIP 檔案。

保留原 `wrangler.toml` 中正確的 Worker 名稱、帳戶、KV／D1 ID、路由和其他專屬設定，合入新版註解與原有 `[build]` 保護設定；不要拿範例中的名稱或 ID 覆蓋正式資料。程式會再次比對線上 Worker 的實際綁定，缺失／不一致就停止，不按預設名称新建資料庫。

本包 `Safe upgrade` GitHub 工作流已改為**僅手動執行**，不再隨 Push 自動發布，以免與 Cloudflare Git 直連同時操作。其他舊工作流或外部發布器也不要並行執行。只執行 Test 的工作流不會發布。

## 2. 在 Builds 配置環境變數／機密

位置是 **Settings → Build／Builds → Build variables and secrets**，不是 Worker 執行時的 Variables & Secrets，也不是只設在 GitHub Actions。

| 名稱 | 類型與內容 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Secret；原帳戶可發布原 Worker、讀寫原 KV、匯出及查詢／寫入原 D1 的 Token。 |
| `CLOUDFLARE_ACCOUNT_ID` | 原 32 位 Account ID。不是 Zone ID／D1 ID。可設變數或 Secret。 |
| `SUBSTRACKER_BACKUP_PASSWORD` | Secret；至少16字元，建議獨立隨機32字元以上。離線保密保存，兩階段必須一致。 |
| `SUBSTRACKER_WORKER_NAME` | 原 Worker 的準確名稱；不填則讀 `wrangler.toml`。不要使用猜測的新名稱。 |
| `SUBSTRACKER_WORKER_URL` | 使用自訂網域／關閉 workers.dev 時設原 HTTPS 源地址，不含 `/admin`、查詢、密碼。 |
| `SUBSTRACKER_ENVIRONMENT` | 原本使用 Wrangler 命名環境時才設，例如 production；否則留空。 |

Token 應限制在原帳戶與所需資源；主要需要 Workers Scripts Edit、Workers KV Storage Edit、**D1 Edit**，以及讀取原帳戶／Worker 設定的權限；原部署涉及路由時沿用相應 Routes 權限。Cloudflare 自動生成的 Builds Token 預設權限列表沒有列 D1，不能把「原本能上傳 Worker」當作「能備份並協調 D1」的證明。權限不足會停止，不會自建替代儲存。

原站的執行時 Secret 值保持原樣；本版不把備份密碼寫進 Worker 或公開程式碼。不要把 Token、備份密碼或 `.stbackup` 解密內容貼到聊天／Commit。

執行環境需要 **Node 22.13+、Python 3.11+**；包內 `.node-version` 為22，預檢會拒絕缺少必要執行環境的情況。

## 3. 第一次 Build：備份並發布維護版本

設定好命令及機密後，在更新至 v3.3.23 的正式提交執行 Build。

程式依序執行必要型別／語法／回歸測試，讀取原 Worker 的真實資源 ID，取得既有 D1 的部署協調鎖，建立並還原檢查完整加密備份。備份與恢復憑證分片寫入原 KV 的專用升級前綴，全部回讀、解密及摘要核對通過後，才發布本次受保護維護版本。

日誌會出現：

```text
ST_UPGRADE_WAIT {"version":"3.3.23","maintenance":true,"readyAfter":"...Z","runId":"..."}
```

**這是第一階段完成，不是升級完成。** 此時應用普通操作與排程會被維護門禁停止，網站暫時不可正常使用。`readyAfter` 是 UTC 時間（結尾 Z）；以該時間之後再執行為準。

本版保留原16分鐘舊請求／任務結束等待，但不在一次 Builds 命令中空等16分鐘。這是维护式升級，不是零停機更新。

## 4. 到時間後：Retry 同一提交，驗收後開站

在日誌列出的 `readyAfter` 之後，對**同一提交**再執行一次 **Retry build／重試**。通常可在第一階段結束至少16分鐘後操作；以具體日誌時間為準。

即使 Cloudflare 使用全新的建置環境，程式也會從原 D1／KV 取回、驗證並恢復加密檢查點，不依賴前一台機器的本機檔案。它會建立維護期備份，補齊缺失歷史，逐項檢查原始記錄，再保存遷移後備份、提交驗收並解除維護。

**只有以下兩個條件都成立才算完成：**

```text
日誌：ST_UPGRADE_COMPLETE
/api/upgrade/status：version 為 3.3.23，maintenance 為 false
```

再登入檢查訂閱、累計歷史、Database、密碼狀態與原模板；表格保存協議保持2。

提早重試只回報 WAIT，不會重新部署或重置正常等待時間。若上次 Wrangler 上傳成功但回應遺失，程式會確認線上本次版本，以首次確定觀察到的維護時間重新保守等待，不重複覆蓋。若遷移／提交回應遺失，只接續同一批次，不重複累計。

程式**不會自動安排下一次 Build**；第二次需要你在時間到後重試。網路、資料量或平台限額問題可能需要更多次接續，不能把兩次視為所有環境的成功保證。

## 5. 資料保護與備份下載

原始訂閱／帳號／密文／模板／設定／歷史與既有 SQL 列仍用原驗收算法逐項檢查。本次額外保存的是加密恢復物件及追加式協調 metadata，不覆寫業務記錄，不清表、不新建 Worker／KV／D1，不生成替代密鑰。

加密物件在原 KV 的 `__substracker_upgrade_artifacts_v1__:<原帳戶與Worker摘要>:` 前綴。D1 沿用既有 `schema_meta`，只追加對應的 checkpoint／lease／release 記錄，不改寫以前的列。備份排除本次專用加密前綴，避免備份自身無限膨脹；普通資料仍全部核對。

備份留在同一個 KV **不等於獨立災難備份**。完成後或故障時，請在同版專案的本機 Node／Python 環境，設定相同的原帳戶、原 Worker、原備份密碼，執行：

```sh
npm run upgrade:download
```

此命令只下載、驗證恢復附件到 `upgrade-backups/`，不發布、不遷移、不解鎖。請將整個目錄另存到安全位置，包含 `.stbackup`、manifest、resume 狀態和 `*-acceptance.json`，備份密碼另行保管。失敗或等待階段尚未生成的後續附件不會憑空出現。

沿用原加密格式；普通應用 JSON 備份預設不包含全部密碼。Worker 執行時 Secrets 的值不能經本工具 API 匯出，須自行保管；原 KV 已存的密鑰與帳號密文包含在加密備份中。瀏覽器未保存的單格編輯、本機 Layout 不是雲端資料備份的一部分。

## 6. 中斷與錯誤處理

| 訊息／情況 | 處理方式 |
|---|---|
| `ST_DEPLOY_COMMAND` 或 raw Wrangler 被拒絕 | 檢查修改的是 Deploy command，確實為 `npm run deploy:cloudflare`，且目前提交包含新 scripts／package。 |
| `ST_DEPLOY_CONFIG` | 在 Builds 補齊正確變數／機密，不要只配置執行時 Secret。 |
| `ST_SPLIT_TEST` | 看前面的具體測試錯誤；尚未開始本次發布。不要跳過測試來繼續。 |
| `ST_SPLIT_BUSY` | 不並行發布。異常中止的鎖最多25分鐘到期；保持同一提交後重試。 |
| `ST_SPLIT_SOURCE`／`ST_SPLIT_VERSION` | 有未完成檢查點，不可換另一份程式冒充原批次；恢复第一次 Build 的提交及密碼。 |
| `ST_SPLIT_OLD_RUN` | 原站已有其他舊批次在維護，先使用舊版原來源與那次恢復憑證接續，不能用新版覆蓋門禁。 |
| 密碼／密文／摘要不符 | 保留原物件及密碼，停止，不刪檢查點重新開始。 |
| 外部改寫被偵測 | 停止其他直寫正式儲存的腳本，在副本核對衝突；本版不自行挑一份資料覆蓋。 |
| `ST_SPLIT_D1_REQUIRED`／`ST_SPLIT_SIZE` | 此入口需要原 D1；加密恢復包上限64MiB。超出時用長時限 Safe upgrade 並保留原恢復資料，不建立空 D1 或關閉檢查。 |
| `ST_SPLIT_BUDGET` | 本次命令達15分鐘保護預算，保留原提交及檢查點後接續；極大資料／測試耗時需長時限流程。 |

原應用的維護门禁不能阻擋持有帳戶 API 權限的外部程式；升級期间不要直接向原 KV／D1 寫入。原記錄不一致就停止，不會假裝驗收成功。

Cloudflare 平台總時限目前20分鐘，包含依賴安裝等；本版15分鐘命令預算不是平台時限保證。正常內部協調使用原 D1 原子語句，鎖存活25分鐘；超時後不會繼續持過期鎖寫入。

原 GitHub／本機長流程仍保留，見 `SAFE_UPGRADE_3.3.23.md`。不要在兩條路線中同時啟動新 run；已有原生分段批次時，優先用原提交接續，或先下載加密恢復資料後按同版恢復指南操作。

## 7. 驗證邊界

已做本機原始 guard 重現、新 Build 接續、回應遺失、破壞／衝突拒絕、舊版來源升級及原表格保存回歸；詳見 `VERIFICATION_3.3.23.md`。**尚未連接或發布你的 Cloudflare 帳戶。** 控制台命令／機密仍需你設定。

完整 Workers Vitest、完整型別檢查及真實 Wrangler bundle／upload 沒有在本工作環境完成：npm registry DNS 失敗，缺少依賴。正式入口仍要求這些檢查，不設跳過開關。資料損壞、欠缺權限或平台限額仍可能阻止正式升級，不能承諾所有環境一次成功。

## 官方文件（核對於2026-10-08）

- Build／Deploy command、Build 變數／機密、Token 預設權限：https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
- Workers Builds 時限：https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/
- Wrangler custom build：https://developers.cloudflare.com/workers/wrangler/custom-builds/
