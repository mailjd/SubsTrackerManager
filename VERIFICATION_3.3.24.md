# SubsTracker v3.3.24｜部署錯誤排查、修正與驗證報告

日期：2026-10-08。輸入包：實際 v3.3.23 D1KVOnly ZIP。資料均為本機合成測試；沒有取得、發布、改寫或清空你的正式 Cloudflare／GitHub。

## 1. 此次日誌的直接結論

使用者日誌先顯示 npm clean-install 成功（144 packages），然後 `npm run build` 只有 echo、退出0，最後明確執行 `npx wrangler deploy`，Wrangler3.114.17 的 custom build 叫到 `require-safe-upgrade.mjs`，因未建立安全升級狀態而退出1。

**直接阻斷原因是 Cloudflare 控制台仍以 raw Wrangler 發布，而不是本專案的安全入口。** 這個現場證據不表示資料庫已損壞，也不能證明帳戶其他發布均未操作資料。保護腳本不會在這個未授權入口發布 Worker、改寫原記錄。

原包真實子程序重現結果：

| 檢查 | v3.3.23結果 | 證據 |
|---|---|---|
| 原 guard，模擬 Workers Builds 但沒有已驗證 run | exit1 / ST_DEPLOY_COMMAND | original-raw-guard.log |
| 原獨立 deploy:check，合法的合成 Builds 設定 | exit1 / ST_DEPLOY_ROUTE，錯誤拒絕其已支援的入口 | original-deploy-check.log |
| 原 npm build | exit0，沒有編譯／產物檢查 | original-noop-build.log |
| 根發布 Wrangler／間接測試 Wrangler | 3.114.17／3.100.0，與使用者日誌相符 | original-dependencies.json、dependency-comparison.json |

不能只把npm警告當成退出原因，也不能把兩個正常依賴位置的版本推斷成快取損壞。新包仍不會刪除guard、讓guard內再發布一次並任由外層Wrangler覆蓋，或將未完成升級偽報為成功。

## 2. 實際改動及範圍

### 2.1 明確區分控制台設定和程式修正

控制台的 Deploy command 必須保存為 `npm run deploy:cloudflare`，這不是ZIP能自動改寫的設定。更新後最先核對下一次日誌的 `Executing user deploy command`，不要把新包版號當成設定已生效。

Build command現在可以保留使用者現有的 `npm run build`：不再只有echo。新版真正執行直接依賴／lock／安裝版本核對、來源語法檢查、Wrangler dry-run；產物缺失或子程序失敗，build會失敗且明確說尚未發布。也可留空，由正式Deploy入口執行所有必需檢查。

### 2.2 修正預檢拒絕自己支援的入口

`check-deploy-environment.mjs` 明確允許 Workers Builds 的分階段入口；仍拒絕Pages、缺少機密、無效Python／TOML／Worker名稱／帳戶／URL等情況。長流程 `deploy:safe` 仍不能在Workers Builds內硬跑16分鐘等待；未放寬此限制。

### 2.3 固定並識別實際發布工具

直接依賴聲明按原lock的確切版本固定，發布使用專案根 `node_modules/wrangler` 的絕對入口，先核對包版本和bin位置。不再讓npx選到全域／網路替代工具。

全部 **238個非根lock節點** 的資料（版本、tarball、integrity、依賴及平台條件）與原包相同。npm10離線lock同步會去掉部分optional節點的libc metadata，本版另外保留了原值，沒有默默更改平台條件。

發布根Wrangler仍是3.114.17；測試pool0.5.41的間接Wrangler仍是3.100.0。**deprecated警告沒有被假裝消除；沒有未經驗證就強行升到Wrangler4、替換測試框架或改寫其間接依賴。** 警告與本次guard退出分開處理，Major工具鏈升級不包含在本次已驗證修正中。

新增 `deploy:doctor` 只讀報告，明確區分「lock中期待的版本」與「已安裝的版本」，沒有列出Token／密碼。

### 2.4 所有完整發布入口增加真實打包檢查

新 `check-bundle.mjs` 執行本機根Wrangler的 `deploy --dry-run`，以臨時診斷配置和合成D1／KV ID載入真正src入口與public。子程序不傳入Cloudflare／備份憑證、授權runId或NODE_OPTIONS等預載設定，並隔離HOME、禁止metrics。它不使用原正式配置作測試發布，也不會把診斷配置交给正式stage。必須產生JS bundle才算通過。

**本次環境未能安裝真實Wrangler，這個真實dry-run仍未成功執行。** 本次對參數、合成ID、憑證過濾、退出碼與產物核對的測試使用明確的fake可執行檔，只能證明包裝及錯誤處理正確，不能證明正式打包相容。

Cloudflare split、GitHub及本機 `all` 均要求完整檢查序列：

```text
test:toolchain → lint → test:syntax → test:bundle → test:storage
→ test:deploy → test:upgrade → test:table-contract → test:workflow → test
```

先完成本機檢查，才讀取Cloudflare原設定、取得協調鎖、建立加密備份或發布。測試失敗輸出具體script、exit／signal，沒有跳過開關。read-only的 `upgrade:download` 仍不要求發布測試，不因此開始發布或解鎖。

### 2.5 補強配置和同批次來源核對

原guard只比對生成配置中部分名稱與資料庫ID；本版比對整份配置與本次加密狀態內容，修改main／build等也不能通過。新增真正prepare備份後篡改main的拒絕測試；原R2注入拒絕測試仍保留。

跨Build来源摘要也納入tests、.github、package／lock及相關配置。產物／tests/results／臨時授權值不納入，避免正常接續誤判。同一待恢復批次改來源／版本會停止，不建立新run覆蓋未完成維護。

### 2.6 其他一致性修正

錯誤訊息讀取實際VERSION，不再硬寫3.3.22。`deploy` 包裝入口使用絕對專案根，`--help`不發佈，未知參數不再被忽略而直接啟動部署。相關CLI和恢復文件皆指向3.3.24。

## 3. 本次實際回歸結果

| 測試組 | 通過／總數 | 執行邊界 |
|---|---:|---|
| 部署預檢、依賴工具、分段接續、D1 query／儲存政策、升級備份、輸入契約 | 161／161 | Node真實子程序、正式runner／guard／加解密／SQLite；CloudflareREST與Wrangler上傳使用明確假傳輸。|
| 訂閱保存、提醒規則、失敗保留、重啟回讀 | 37／37 | 正式API模組＋磁碟KV／SQLite及localhost伺服器。不是Workerd或正式站。|
| Database／基礎資料／歷史／模板／批量操作 | 69／69 | 同一本機正式API測試架構，沒有正式帳戶。|
| **以上本機回歸合計** | **267／267** | 無skip，不重複計算重跑及子集。|

另有 **7組舊版來源升級情境**：從原3.3.18／3.3.19 ZIP建立合成舊資料，以本次3.3.24程式執行備份／補遷移／驗收／重啟，核對原訂閱bytes、帳號密文、config、模板和原ledger列。包括部分D1缺項、D1舊支付／新備註、歷史冪等和篡改備份拒絕。結果檔最後的all_upgrade_assertions_passed是總結，不另算第8項；actual_3319_to_3320等標籤為歷史測試名稱，目的端實際載入目前ROOT之3.3.24。

另通過 **105項來源／內嵌脚本語法檢查、3份TOML和2份Workflow YAML解析**。

中途有一項舊結構測試仍只在split單檔搜尋test:storage字串；共用檢查清單移到release-checks.mjs後，該斷言不再有效。已改為核對正式共用清單包含test:storage、split在任何遠端呼叫前執行該清單，以及GitHub的檢查先於prepare；不是刪掉測試或加入無效字串來騙過斷言。最終全組已重跑。

本次沒有重跑瀏覽器渲染／OS原生剪貼簿測試；除身份版本外沒有改動表格UI，不把之前43項瀏覽器測試冒充本次結果。

## 4. 原資料與D1＋KV保留

`src/data`、`src/api`、`src/core`、`src/services`、`migrations`、`public` 的 **67個檔案**與原3.3.23逐檔位元組相同，證據business-source-comparison.json。不移除資料保留驗收，不更名儲存鍵、模板、帳號密鑰，不清空歷史。

保留D1 query直接备份、原KV加密分片、D1協調鎖、16分鐘維護等待、回讀／還原核驗、中斷恢復及最後逐項原資料驗收。**沒有R2／S3 fallback或新增外部儲存。** 不自建Worker、KV或D1來繞過原綁定衝突。

來源不變和本機回歸不能代替正式升級驗收：資料損壞、來源衝突、限額、欠權限或外部直寫仍可能讓正式流程停止。

## 5. 必須明列的未完成項目

本工作環境 `npm ci --ignore-scripts --no-audit --no-fund --fetch-retries=0 --fetch-timeout=10000` 實際失敗，tarball請求反覆 EAI_AGAIN，npm退出1。與使用者日誌中的安裝成功不是同一個環境，不能把我們的DNS故障當成使用者此次Cloudflare故障。

| 檢查 | 本次結果 |
|---|---|
| npm offline package-lock-only同步 | exit0；僅lock同步，不是依賴安裝 |
| 真正npm ci | exit1，DNS失敗，依賴未安裝 |
| npm run lint | exit2，TS2688缺@cloudflare/workers-types |
| npm test（完整Workers Vitest） | exit127，vitest未安裝 |
| npm run test:bundle | exit1，依賴核對拒絕缺失hono，未能運行真實Wrangler |
| npm run build | exit1，缺依賴不再被echo假成功掩蓋 |
| 正式Cloudflare Wrangler上傳／部署／最終驗收 | 未執行，沒有線上存取權限 |

**不能宣稱本版已在Cloudflare成功發布、完整型別／Workers測試／真實bundle已通過，或保證正式環境一次成功。** 新入口會真正執行並要求這些檢查，不以本機fake替代。若正式環境出現新的ST_TOOLCHAIN／ST_BUNDLE／ST_SPLIT_TEST錯誤，應按具體命令和日誌定位，不跳過。

## 6. 自動化的準確邊界

仍是Git提交自動啟動第一階段，WAIT後人工到readyAfter重試同一提交。**沒有新增自動安排第二次Build。** 第一次綠燈不等於升級完畢。

完整條件：ST_UPGRADE_COMPLETE；/api/upgrade/status為3.3.24、maintenance:false；原資料驗收通過。若已有3.3.23批次處於維護，先用舊版原提交恢復，本版更嚴格的來源核對不會容許混用。

控制台操作詳見DEPLOY_REPAIR_3.3.24.md。這次修正包括程式缺陷與保護補強，但**造成你這份日誌中止的控制台Deploy command仍須改成npm run deploy:cloudflare並保存**。

## 7. 證據與封裝

本次證據在tests/results/3.3.24/：node-regression.tap、node-status.json、api-results.json、workflow-results.json、cross-version-results.json、syntax.json、config-parsing.json、business-source-comparison.json、dependency-comparison.json，以及真實npm失敗日誌。其他版本的results和報告是歷史，不計入此次267項。

本包不含node_modules、測試資料庫、正式憑證、解密備份、.upgrade或upgrade-backups執行狀態；src/upgrade-release.js仍是未授權預設值。FILE_MANIFEST_3.3.24.json列出逐檔SHA-256（不自含）；交付前核對ZIP CRC及manifest全部條目。

可重跑核心回歸：

```sh
node --test --test-concurrency=3 tests/deploy/*.test.mjs tests/storage/*.test.mjs tests/upgrade/*.test.mjs tests/regression/contract.node.mjs
python3 tests/regression/api-regression.py . /tmp/subs-api-fresh
python3 tests/regression/workflow3319.py . /tmp/subs-workflow-fresh
node scripts/check-syntax.mjs
```

上述Node回歸不需要npm套件，但不等於完整Worker測試。真實依賴／打包／Workers測試需另執行npm ci、npm run build、npm run lint、npm test。測試輸出目錄應為全新，不能指向正式資料。

## 8. 官方依據（核對於2026-10-08）

- 控制台Build／Deploy、保存與Retry生效、Build機密獨立：https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
- 單次Build20分鐘上限：https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/
- Wrangler3→4遷移範圍：https://developers.cloudflare.com/workers/wrangler/migration/update-v3-to-v4/
