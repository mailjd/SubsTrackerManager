# SubsTracker v3.3.30 — 原部署流程綁定修正版

## 基準及修正範圍

唯一基準：使用者提供的完整 `SubsTracker-GitHub-Cloudflare-Ready_v3.3.29_KVOnlySafeDeployFix_20261008.zip`。
這是原工程修正版，不是「既有 D1／KV 升級輔助工具」，也不是強制放行的 code-only 補丁。

本輪沒有取得使用者 Cloudflare 帳戶或最新完整失敗日誌。原包內 `KV_ONLY_DEPLOY_3.3.29.md` 記載先前停止於 `ST_SPLIT_D1_REQUIRED`；該文件是歷史線索，不是本輪遠端診斷結果。以下修正已在本地重現／測試，但不得據此宣稱使用者線上已部署成功。

## 實際修改

### 1. settings 缺少 D1 時，不立即認定原 Worker 只有 KV

原 `npm run deploy:cloudflare` 現在按下列順序執行：

1. 解析原 Wrangler 設定，記錄實際目標 Worker 與選定環境。
2. 唯讀讀取該 Worker 的 settings。D1 ID 完整時沿用原快路徑。
3. 分段部署需要 D1、但 settings 缺少 D1 或該列沒有 ID 時，讀取同一 Worker 的 deployments，再讀取**目前承接 100% 流量的版本**之 `resources.bindings`。
4. 重讀現行部署及 settings，確認查詢期間没有變更。核對兩來源的 KV、一般變數、Secret 名稱及其他綁定一致後，才使用現行版本所載的原 D1 ID。
5. 通過原綁定檢查及全部 release checks，再進入原本的加密備份、維護版、分段等待、遷移及驗收流程。

不使用帳戶中「第一個 D1」、資料庫名稱比對、手填 ID 猜測或未部署的最新上傳版本。不建立或改綁替代資料庫。不把 403、缺少版本資訊、灰度多版本部署當成 KV-only。

如果 settings 與現行版本都明確沒有 D1，原 Cloudflare 分段部署仍會停止。**「帳戶裡存在 D1」並不能單獨證明它已綁定給此 Worker；本版沒有取消這個資料保護邊界。**

### 2. 原 D1 列缺少 ID，不再在完整 safe-upgrade 中被靜默降級

v3.3.29 的 `protectBindings()` 遇到 `{type:'d1', name:'SUBSCRIPTIONS_DB'}` 而沒有 ID 時，會返回 `dbId:null`。在長流程的 `prepare()` 中，這可能導致產生空的 `d1_databases`。

v3.3.30 會先嘗試以上唯讀核對；仍無法確認時，明確返回 `ST_BINDING_D1_UNRESOLVED`，不產生「已確認 KV-only」結論。

此外，UUID 使用完整格式校驗、正規化大小寫，拒絕不一致的 `id`／`database_id`、重複綁定名稱和重複本地儲存宣告。

### 3. 命名環境不再錯用頂層 Worker／儲存 ID

v3.3.29 以淺層合併解析環境，會讓未宣告的 KV／D1 ID、vars 從頂層滲入命名環境；未明訂環境名稱時也會沿用頂層 Worker 名稱。

v3.3.30 修正為：

- 選定 `SUBSTRACKER_ENVIRONMENT` 後，不繼承頂層 `kv_namespaces`、`d1_databases` 和 `vars`。
- 環境有明訂 `name` 時使用該名稱；未明訂時使用 `<原 name>-<環境名稱>`。
- 明確設定的 `SUBSTRACKER_WORKER_NAME` 仍具有最高優先。
- 這是本地設定解析，不是移除線上綁定。`prepare()` 仍讀取及保留所選 Worker 的原資源。

**原包已明訂的 production／staging 名稱不變。** 不要只因部署正式站便新增 `SUBSTRACKER_ENVIRONMENT=production`；沿用實際原環境。

### 4. 完整測試之後、第一個遠端寫入之前重新核對綁定

原分段入口在測試之前取得的綁定可能於測試期間被其他發布器或管理員變更。
本版在取部署鎖之前重新比對 KV、D1、Variables 和 Secret 名稱，並在 prepare 及後續受保護寫入點再次核對；不把舊預檢結果用於不同資料庫。

這不能代替「不要同時運行兩個發布器」。外部寫入者不受本程式的 D1 部署鎖控制；原雙掃描、資料基線及逐筆驗收仍保留。

## 套用到現有 GitHub repository

**優先使用差異修補 ZIP，合併至原 repository 根目錄，覆蓋同路徑檔案；不要先刪除倉庫。**

- 差異包不包含 `wrangler.toml`，因此不覆蓋原 Worker、環境、路由或本地綁定設定。
- 未包含的自訂程式與原 repository 額外檔案繼續保留，仍由原完整 lint／Workers 測試檢查。
- `package.json`、`package-lock.json`、`src/version.js`、`src/upgrade-release.js` 必須配套更新到 3.3.30。
- 本版沒有新增或升降任何依賴版本。標準依賴安裝命令仍是 `npm ci --include=dev`。
- 不必再次套用 `SubsTracker_v3.3.29_CodeOnlySafetyGate_Patch_20261009.zip`；本版部署入口不執行那個固定返回 false 的獨立檢查器。倉庫若留有該檢查器，它本身不會讓本版 `deploy:cloudflare` 失敗；但若控制台自行串接了它，需恢復下列原部署命令。

完整 ZIP 含完整應用及測試，供完整比對／乾淨 checkout 使用。將完整版覆蓋至已有自訂設定的倉庫前，保留原 `wrangler.toml` 等個人設定，不用範本取代。

## Cloudflare Workers Builds 設定

| 項目 | 值 |
| --- | --- |
| Build command | `npm run build` |
| Deploy command | `npm run deploy:cloudflare` |
| Node | `.node-version` 中原有的 `22`；需 22.13+ |
| 原 Worker 名称 | 原有 `SUBSTRACKER_WORKER_NAME`，必須是要更新的那個 Worker |
| 帳戶／API Token | 原有 `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN` |
| 備份密碼 | 原有 `SUBSTRACKER_BACKUP_PASSWORD`，至少 16 字元，未完成批次不能換密碼 |
| 原網址／環境 | 保留原有 `SUBSTRACKER_WORKER_URL`／`SUBSTRACKER_ENVIRONMENT`，未使用者不必新增 |

部署命令是 Cloudflare 控制台設定，不會由 ZIP 自動修改。Build variables／secrets 與 Worker runtime variables／secrets 不是同一配置位置。不要將 Token 或備份密碼提交到 Git 或貼在日誌裡。

settings／deployments／versions 查詢需要同一目標帳戶下的 Workers Scripts Read 或 Write 權限；實際發布及既有 KV／D1 讀寫仍沿用安全升級原需求。不要為此授予帳戶所有權限，也不需要 R2 權限。

## 新日誌及處理方式

| 日誌 | 意義／下一步 |
| --- | --- |
| `ST_DEPLOY_TARGET` | 實際目標 Worker 與環境；應與原正式 Worker 一致。 |
| `ST_BINDING_FALLBACK` | settings 的 D1 資訊不足，開始唯讀核對現行版本。不是發布完成。 |
| `ST_BINDING_D1_RECOVERED` | 已從一致的現行版本核驗原 D1；接著仍須完整安全升級。 |
| `ST_BINDING_KV_ONLY_CONFIRMED` | settings 與現行版本都沒有 D1；分段入口不能假裝取得 D1 原子鎖。 |
| `ST_BINDING_PROBE_INCOMPLETE` | 權限不足、無可核验部署等；不下 KV-only 結論。 |
| `ST_BINDING_SOURCE_CONFLICT` | 兩來源的 KV／變數等不一致；停止，不合併不同儲存。 |
| `ST_BINDING_CHANGED` | 預檢／測試期間設定變動；沒有繼續使用過期綁定。 |
| `ST_BINDING_MULTIVERSION` | 現行多版本分流；此安全升级不能猜測哪版是原資料來源。 |
| `ST_SPLIT_BINDING_PROBE` | 原有綁定預檢結果；通過後才開始必要測試。 |
| `ST_UPGRADE_WAIT` | 原第一階段完成，網站處於維護模式；按 `readyAfter` 重試**同一提交**。 |
| `ST_UPGRADE_COMPLETE` | 原流程已完成；另核對 status 的 `version:3.3.30` 及 `maintenance:false`。 |

原 16 分鐘停寫等待未縮短，並非看到 Build success 就已恢復網站。新診斷不輸出 Token、備份密碼或儲存 ID；Cloudflare/Wrangler 自身的其他日誌依其輸出行為。

## 尚未完成的舊批次

**如果線上已進入 3.3.29 或其他版本的維護模式，不能用本版覆蓋那個未完成批次。** 先用原提交、原密碼與原恢復附件完成／恢復該批次。本版沿用源碼指紋及 checkpoint 版本保護，會拒絕混用。

如果先前一直停在綁定預檢，沒有發布維護版，則可合併本版、提交新的 commit 後建置。

原 D1 缺少 `schema_meta` 或其他所需 v3 基礎表時仍停止，不會偷偷建空表／新庫來製造通過。本版不是任意早期資料結構的遷移器。

## 資料及測試邊界

本版沒有修改 bulk import、subscription/account API、UI、資料遷移 SQL、資料加密或業務紀錄邏輯；`src/` 僅版本識別與分發預設 gate 版本更新。原 KV-only 長時限 Safe upgrade 保留。沒有新增 R2、其他儲存、獨立輔助工具或不安全 code-only 發布入口。

本輪的實際結果以 `VERIFICATION_3.3.30.md` 及 `tests/results/3.3.30/` 為準。模擬 API／部署器的通過不能代替真正 Wrangler 編譯、Workers runtime 或線上帳戶验收。

## 核對使用的官方資料（2026-10-09 查閱）

- Worker settings API：https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/get/
- 現行 deployment 順序與版本流量比例：https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/
- 指定 Worker version 的 resources.bindings：https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/
- Wrangler 命名環境及不繼承項目：https://developers.cloudflare.com/workers/wrangler/environments/
- Workers Builds 命令與變數：https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
