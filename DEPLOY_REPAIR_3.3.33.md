# SubsTracker v3.3.33｜部署流程根因修正版

基準：使用者提供／本對話交付的完整 v3.3.32；對應 2026-10-09 12:08 UTC 日誌中的 `ST_DIRECT_URL` 及錯誤模式切換。這是原 repository 的修改，不是另製輔助工具。

## 只走這一條預設流程

**解綁原 D1／KV → Git 發布新版程式 → 控制平面核對本次版本 → 手動綁回相同原 ID → 原站 `/init` → 驗證資料後開站。**

`npm run deploy:cloudflare` 現在固定 `mode: deferred-web-init`，不根據 KV 是否存在自動切到 `direct-compatible`。仍有任何 D1 或 KV 時，`ST_UNBOUND_STILL_BOUND` 會一起列出實際 Worker、settings 及 activeVersion 的殘留 binding 名稱與 ID，然後在發布前停止。程式不替操作者解除綁定、不刪資源、不找其他空庫替代。

此處的停止不是又要求 D1/KV 才能發布，而是保護尚未解綁的原設定。若日誌的 Worker／環境不是剛操作的目標，先修正 Builds 的原 Worker 名稱／環境；不要刪錯資源。

## 套用修補

將修補 ZIP **內的內容**按原路徑合併到 repository 根目錄（原 `package.json` 所在位置），不是新增 `scripts/src`、`scripts/tests` 或 `scripts/scripts`。`package.json` 與 `package-lock.json` 一起更新。

修補包不含 `wrangler.toml`，不更改你的原 Worker 名稱、Account ID、Routes、Secrets 或原資源 ID。自訂過同名原碼時先比較再合併。完整包的 `wrangler.toml` 是原發行版模板，不能用它覆蓋個人自訂環境。不要套回 CodeOnlySafetyGate，也不使用獨立 Upgrade Helper。

部署命令不變：

```text
Build command: npm run build
Deploy command: npm run deploy:cloudflare
```

不要在前後串接舊 `deploy:code-only:check`，也不要改成裸 `wrangler deploy`。本版沒有跳過檢查參數。原直接／分段升級仍保留給明確的舊版恢復操作，但這次不要執行 `direct`、`split` 或另一條 Actions 發布工作流。

## 部署前及綁回

先自行備份原 D1/KV，記錄**原 Database ID、Namespace ID**及執行時 Secrets。只從同一 Worker 移除 D1、KV 的 Binding，儲存並部署設定變更；不要刪除資料庫、namespace 或 Worker。停用其他發布器／寫入者，避免同時操作。

無綁定階段必需的 Build 環境資訊：原 `CLOUDFLARE_ACCOUNT_ID`、有該 Worker 權限的 `CLOUDFLARE_API_TOKEN`、能正確解析的 Worker 名稱（原 TOML 或 `SUBSTRACKER_WORKER_NAME`）。只有原來確實使用命名環境，才沿用 `SUBSTRACKER_ENVIRONMENT`。不要求新增 D1、不要求備份密碼才能發布等待程式。

**`SUBSTRACKER_WORKER_URL` 現在是可選的 Build 變數，不再是程式發布先決條件。** 提供時使用原 HTTPS 根網址；非法值會被忽略並警告，原網址值／憑證不會被原樣印出。省略時嘗試唯讀找出此 Worker 的 Custom Domain、可唯一解析的既有根 Route、已啟用的 workers.dev。權限不足、無根網址、DNS/Access 阻擋只影響 URL 核驗，不改成啟用 workers.dev，也不新增／刪除 Route。

看到本次 `ST_CODE_DEPLOYED_AWAITING_BINDINGS` 後，綁回原資源：

| 類型 | Binding 名稱 | 資源 |
|---|---|---|
| KV | `SUBSCRIPTIONS_KV` | 解綁前原 Namespace ID |
| D1 | `SUBSCRIPTIONS_DB` | 解綁前原 Database ID |

儲存並部署 **Binding 設定變更**，保留已發布的程式，不是再推送一次 Git。綁回後重新執行預設程式部署，會按設計因仍有綁定而停止。

保留原執行時 `SUBSTRACKER_SUPERADMIN_PASSWORD` Secret；若原本使用 `SUBSTRACKER_SUPERADMIN_USERNAME`，沿用它。不拿 API Token 或備份密碼當 init 密碼。不重設原 KV `config`、JWT 或憑據加密密鑰。

## 三個狀態分開判讀

| 日誌／狀態 | 代表什麼 | 不代表什麼 |
|---|---|---|
| `ST_CODE_RELEASE_VERIFIED` | Wrangler 返回成功，現行 deployment/version 已改變，settings 與 active version 均有本次 nonce＋原碼雜湊，且原變數／Secret 名稱核對通過 | 不代表公網 URL 能訪問或資料 init 完成 |
| `ST_URL_VERIFIED` | 該 URL 回傳本版、本次 runId 的等待綁定狀態 | 不代表 D1/KV 已更新 |
| `ST_URL_NOT_VERIFIED` | URL 尚無法核對，詳看 `not_configured` 或 `not_verified` 與 HTTP 結果 | 不抹除已驗證的程式發布，也不會自動打開新公開入口 |
| `ST_CODE_DEPLOYED_AWAITING_BINDINGS` | 本次程式發布流程完成，`codeDeployed:true`、`applicationReady:false`、`dataInitComplete:false` | 不是全站升級完成 |
| 網頁 `ST_WEB_INIT_COMPLETE` | 本次 init 資料驗證完成，可正常開站 | 不是單純綁回或重新整理即可得到 |

若沒有任何可用網址，程式仍能完成控制平面驗收，但你需要恢復／使用原來能到達此 Worker 的網址，才能開 `/init`。這不等於修正自動建立了網址。若 `/api/upgrade/status` 被 Access 保護，先在瀏覽器經原有登入流程進入原站。

## 發布識別與資料保護

新版在 Worker 一般變數新增內部、非機密的 `SUBSTRACKER_CODE_RELEASE_V1`，内容是本次 version/mode/runId/sourceHash。它**不是資料庫鍵、不含密碼、不是放行 init 的憑證**。API 必須在**現行版本**讀到相同值；最新上傳但未啟用的版本不算成功。此名稱若已被不相容的原變數佔用，會停止而不覆蓋它。

原一般變數、JSON 值及 Secret 名稱保留；無法從 API 回讀 Secret 值，因此不宣稱已比較機密明文。只更新本工具自己的發布標記。Routes 欄位不寫進生成的發布配置，避免用本地舊值覆蓋 Dashboard 路由；workers.dev／Preview URLs／Cron 沿用可核實的原設定。

無綁定部署腳本不呼叫資料 API，不備份或遷移原 D1/KV。真正的網頁 init 沿用 v3.3.32 的身份驗證、預覽、確認、分批處理、檢查點與回讀核驗。此版沒有更改 `web-init.js`、SQL schema 更新或業務 API；不靠移除運行門禁來啟站。

## `/init` 操作

開啟原站 `/init` → 重新檢查綁定 → SuperAdmin 驗證 →「檢查原資料（不寫入）」→ 確認原資源與外部備份 →「執行／繼續 init」。所有資料核验通過後才恢復業務及 Cron。

init 不是空庫首次安裝。它要求原 KV v3 結構與原資料密鑰；不生成替代密鑰。更完整的資料更新範圍及中斷續跑限制，見 `UNBOUND_WEB_INIT_3.3.32.md` 的 init 章節；其中舊部署器「有 KV 就切回 direct」規則已被本文件取代。

## 失敗時的證據

`ST_DEPLOY_FAILED` 會輸出 `stage`、`publishAttempted`、`codeDeployed`：

- `publishAttempted:false`：停止在預檢／發布測試／發布前核對，尚未呼叫發布器。
- `publishAttempted:true, codeDeployed:null`：已呼叫發布器，但尚未確認此版本承接流量。不能宣稱未上傳，也不能宣稱成功。
- `codeDeployed:true`：已有控制平面發布證據，仍須看後續 URL 與 init 狀態。

並行變更會盡可能透過前後版本／綁定比對發現；**這不是原子發布鎖**。無綁定期間沒有 D1 原子鎖，最後檢查與上傳間仍存在競爭窗口，所以不可同時發布／改綁。工具不自動回滾或清庫。

## 本輪驗證界線

見 `VERIFICATION_3.3.33.md` 與 `verification/v3.3.33/`。本地測試包含模擬 API／上傳器；沒有連到使用者 Cloudflare，也没有線上讀寫 D1/KV。真實鎖定依賴安裝、完整 build、Workers 測試與線上 init 是否完成，分項列出，不能用 mock 計數代替。

## 官方介面核對（外部技術依據）

- Cloudflare Workers Deployments：現行部署與流量版本清單。https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/
- Worker Version：取得指定版本的 resources/bindings。https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/
- Custom Domain 的 service/environment 篩選。https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/list/
- Wrangler 設定：Dashboard-only routes 的保留規則、keep_vars、workers_dev。https://developers.cloudflare.com/workers/wrangler/configuration/
- Builds 變數與執行時變數的區分。https://developers.cloudflare.com/workers/ci-cd/builds/configuration/

這些官方文件僅支援 API／設定語義，並不證明本包已在你的帳戶成功發布。
