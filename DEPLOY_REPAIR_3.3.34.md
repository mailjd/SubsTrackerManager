# SubsTracker v3.3.34｜保留既有綁定，先發布程式再網頁 init

## 本次修正的確切問題

2026-10-10 01:17:29 UTC 的 v3.3.33 日誌：Build 成功，Deploy 停在 `ST_UNBOUND_STILL_BOUND`；`publishAttempted:false`、`codeDeployed:false`、`dataAPICalls:0`。原因是舊版預設 `expectedStorageBindings:0`，而偵測到 KV。這不是 D1 SQL 或 npm 安裝失敗。增加 D1 不可能滿足「必須零綁定」。

該日誌的 settings 與 activeVersion 摘要都只列 KV，沒有列 D1。這僅是當次部署器觀測結果，不證明原資料庫不存在，也不能推斷使用者沒有操作綁定。

v3.3.34 將預設條件改成 **保留現行綁定**：無綁定、KV-only、D1-only、KV＋D1 均使用相同的 deferred-web-init 程式發布路徑。仍不自動切回 direct/split，不解除綁定、不建立或猜測資料庫、不執行資料備份或初始化。

## 已經綁定原 KV 與 D1 的操作

1. 保留原 Worker、Secrets、原 KV Namespace ID 和 D1 Database ID，先有獨立可用的資料備份。不要刪庫、建立同名空庫、重設 JWT 或資料加密密鑰。執行 init 前停止其他對同一資料庫的寫入者。
2. 將累積修補 ZIP **解壓後的內容**合併至 repository 根目錄（原 package.json 所在位置），覆蓋同名檔。不要上傳 ZIP 本身，不要多套一層 scripts；package.json 與 package-lock.json 同時更新。修補包不含 wrangler.toml。
3. 已存在的 KV/D1 保持綁定，不需要先解綁再綁回。原 Cloudflare Git 連接維持不變。
4. Build command 保持 `npm run build`；Deploy command 保持 `npm run deploy:cloudflare`。不新增任何跳過檢查的旗標，不串接舊 deploy:code-only:check，不直接執行 wrangler deploy。
5. 推送本版。核對日誌版本 3.3.34、bindingPolicy preserve-active 及 ST_WEB_INIT_BINDINGS_PRESERVED 列出的名稱/ID。預設發布不要求 SUBSTRACKER_BACKUP_PASSWORD，但這不代表已替你建立資料備份。
6. 看見 ST_CODE_RELEASE_VERIFIED，且後續 ST_CODE_DEPLOYED_AWAITING_INIT，才表示本次程式與綁定已核對；**資料仍未初始化，網站業務仍鎖定**。
7. 使用原網站 `/init`。原 Worker 執行時 Secret `SUBSTRACKER_SUPERADMIN_PASSWORD` 必須已設定；原有 `SUBSTRACKER_SUPERADMIN_USERNAME` 時亦需沿用。Builds 的同名變數不等於執行時 Secret。不要輸入 API Token 或資料加密密鑰。
8. 按頁面「重新檢查綁定 → SuperAdmin 驗證 → 檢查原資料（不寫入）→ 核對原資源與備份 → 執行／繼續 init」。本版不改動既有 init 的驗證、SQL、收據及續跑邏輯。
9. 只有網頁顯示 ST_WEB_INIT_COMPLETE、applicationReady:true、maintenance:false，才代表資料核驗完成。確認原登入、帳號、訂閱、歷史與範本正常，再恢復其他寫入者。

## 部分或完全未綁定

| 發布器核對到的狀態 | 發布行為 | 發布後 |
|---|---|---|
| KV＋D1，名稱正確 | 原 ID 完整保留，發布程式 | 直接 /init，不重綁、不重推 Git |
| 只有 KV | 保留原 KV，D1 清單維持空（不猜 ID） | ST_CODE_DEPLOYED_AWAITING_BINDINGS；補綁原 D1 |
| 只有 D1 | 保留原 D1，KV 清單維持空 | 等待補綁原 KV |
| 兩者皆無 | 發布等待頁，不建立任何資料資源 | 手動綁回兩個原 ID，再 /init |
| 額外 KV/D1 名稱 | 原名稱與 ID 亦保留，不擅自改名 | 必需的應用綁定仍須正確存在 |
| 來源不一致、ID 缺失/矛盾、不支援類型 | 明確停止，不當作未綁定 | 核對同一 Worker 的現行設定，不能強制清空放行 |

應用所需綁定名稱：KV `SUBSCRIPTIONS_KV`；D1 `SUBSCRIPTIONS_DB`。補綁原資源時只部署 Binding 設定，保留剛發布的程式，不需再次推送 Git。

本地 wrangler.toml 的舊 ID 不用來猜測線上資源。發布配置完全取自 **同一 Worker 的 settings 與現行 100% 流量版本一致的綁定**。D1 支援 API 的 database_id 與舊 id 欄位；同時返回而內容衝突時停止。單純在帳戶內存在一個資料庫不等於它已綁定，工具不會自動選取。

## 可分辨的成功階段

- ST_WEB_INIT_BINDINGS_PRESERVED：已核對現行資源，還未上傳。
- ST_WEB_INIT_PUBLISH：開始呼叫發布器，不等於已完成。
- ST_CODE_RELEASE_VERIFIED：現行 deployment/version 已更新，本次 nonce/source hash 符合，原資料綁定/變數/Secret 名稱未消失。
- ST_URL_VERIFIED 或 ST_URL_NOT_VERIFIED：網址能否回應本次程式的獨立證據，與程式發布、資料 readiness 分開。
- ST_CODE_DEPLOYED_AWAITING_INIT：必需的兩個綁定都存在；需要人工網頁 init，不是假報資料完成。
- ST_CODE_DEPLOYED_AWAITING_BINDINGS：缺少必需綁定；只補綁缺項的原資源。
- ST_WEB_INIT_COMPLETE：僅網頁完成資料核驗後產生。

本版新增 GET `/api/upgrade/code-status` 僅返回程式身分與綁定介面是否存在，**不呼叫 D1 session/SQL 或 KV get/list/put**。它返回 readinessChecked:false、applicationReady:null、dataInitComplete:null；不能作為資料已完成的證據。發布器改核對此端點，不再要求舊版 `phase:bindings_required`，避免已綁齊時反而核驗不通過。原 `/api/upgrade/status` 與 `/api/init/status` 保留真實資料狀態檢查。

SUBSTRACKER_WORKER_URL 仍是可選的 Build 變數，可填原站 HTTPS 根網址。不會自動開啟 workers.dev、建立網域或要求解除 Access；URL 未驗證不表示程式未上傳，但要有可達原網址才能操作 /init。

## 資料與發布保護

發布器只查 Worker 控制中繼資料，並使用本專案鎖定的 Wrangler 發布程式/靜態資產。不執行 D1 SQL、KV 資料 API、備份、初始化、遷移或自動回滾。只移除綁定檢查、把檢查改為返回成功均不是本版作法：生成配置會明確帶回原 ID，build guard 與發布後核對都會驗證它們。

部署期間不要並行另一個發布器，也不要編輯同一 Worker 的綁定、Variables、Cron 或域名設定。工具會在測試後及上傳前/後重新檢查，但這不是 Cloudflare 跨所有發布器的原子鎖；不能保證另一個操作在最後檢查之後不再改動。發現漂移停止，不自動回滾或寫庫。

獨立備份需要自己事先完成。本版本不因「有綁定」就把備份或遷移偷偷移回部署階段。升級後尚未完成 init 的新版本會暫停業務及 Cron。執行 init 前不應有其他 Worker 或舊請求繼續修改同一份資料。

## 保留與變更範圍

從完整 v3.3.33 修正。src 只變更 version.js、upgrade-release.js、web-init.js 的獨立 code-status 分支，以及 /init 的綁定提示文字。/init 明示已綁定不用重綁；排版及按鈕邏輯不變。訂閱、帳號、業務 UI、批量導入、D1/KV migration SQL 未變更。依賴版本與 lockfile 中的套件內容未變更，僅應用自身版本升到 3.3.34。

檔案名 deploy-unbound.mjs、wrangler.unbound.json、UNBOUND_PLAN 及部分 ST_UNBOUND_* 錯誤前綴為內部相容保留，不再表示有資料綁定就拒絕發布。**判斷本版以 version 3.3.34 和 bindingPolicy preserve-active 為準**。若仍看見 v3.3.33 的 ST_UNBOUND_STILL_BOUND，當次 Build 還不是本版。

## 本輪驗證界線

具體命令、結果、未完成項目見 VERIFICATION_3.3.34.md。本地模擬 API/上傳器的通過不等於已部署 Cloudflare；工具仍保留正式 lint、native Workers test、Wrangler bundle 等發布檢查。

## 官方原始資料核對（與附件日誌分開）

- Cloudflare Workers API：D1 使用 database_id，舊 id 為別名；KV 使用 namespace_id。https://developers.cloudflare.com/api/resources/workers/
- **本專案鎖定版本** Wrangler 3.114.17 create-worker-upload-form.ts：D1 上傳 metadata 使用 database_id 作 id；KV 使用 id 作 namespace_id；keepVars 只保留 plain_text/json，不是保留儲存綁定的替代品。https://raw.githubusercontent.com/cloudflare/workers-sdk/wrangler%403.114.17/packages/wrangler/src/deployment-bundle/create-worker-upload-form.ts
- 配置文件：https://developers.cloudflare.com/workers/wrangler/configuration/

上述官方內容用於核對資料欄位與上傳格式，不代表已向使用者帳戶發出任何請求。
