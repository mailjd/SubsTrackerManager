# SubsTracker v3.3.24｜部署入口、真實建置與依賴核對修正

日期：2026-10-08。基於原 v3.3.23 D1KVOnly ZIP。本版仍僅使用原 D1＋KV，不需要 R2。這是修正包及操作指南，不是你的線上部署成功證明。

## 先改控制台的這一項，不要只換 ZIP 重試

你提供的失敗日誌寫的是：

```text
Executing user deploy command: npx wrangler deploy
```

此命令未建立本次已驗證的加密備份及升級狀態，原保護腳本因此正確停止。程式不能在 raw Wrangler 的 build hook 中安全地完成另一輪分段發布，再讓外層 Wrangler 繼續覆蓋它。因此本版沒有刪除 guard，也沒有從 build hook 偷偷發布或偽造成功。

Cloudflare → Workers & Pages → **原 Worker** → Settings → Build / Builds → Build configuration → 編輯並保存：

| 欄位 | 本版設定 |
|---|---|
| **Deploy command / 部署命令** | **`npm run deploy:cloudflare`** |
| Build command / 建置命令 | 可保留目前 `npm run build`；亦可留空，由 Deploy 入口完成全部必需檢查 |
| Root directory | 放有本版 package.json、package-lock.json 和 wrangler.toml 的目錄 |
| Production branch | 更新本版的原正式分支 |
| Preview command | 不要在此填正式升級命令；本版不是分支預覽部署 |

**必須按 Save。不是改 Build command，也不是只改 package.json 的 deploy script。** 下一次日誌應明確顯示：

```text
Executing user deploy command: npm run deploy:cloudflare
[upgrade] ST_DEPLOY_ENTRY {"version":"3.3.24","entry":"deploy:cloudflare","storage":"D1_KV_ONLY","continuation":"manual-retry"}
```

若第一行仍是 `npx wrangler deploy`，表示當次任務仍使用舊命令；應核對選中的 Worker、正式分支、Root directory 及保存結果，不要刪除 build guard、換資料庫、清空記錄或反覆更換 npm 套件。

Cloudflare 官方說明：控制台保存的設定會套用到下一次 Build，Retry 使用重試當下的設定；Build 與 Deploy 是兩個不同欄位。ZIP 不能替你修改控制台已保存的命令。

## 本版修了哪些實際問題

| 問題 | 修正 |
|---|---|
| 舊 build 只有 echo，根本沒有編譯 | `npm run build` 現在依序核对依賴、檢查語法、執行本機 Wrangler dry-run，未生成 JS bundle 不算成功。這是離線檢查，不发布。 |
| deploy:check 拒絕已支援的 Workers Builds | 獨立预檢現在接受 Cloudflare 分階段入口；Pages 及缺失設定仍拒絕。長時間 deploy:safe 仍不能在 Workers Builds 直接執行。 |
| 版本訊息仍硬寫3.3.22 | 從目前版本常數產生訊息和文件名稱；輸出實際入口與手動接續標記。 |
| 發布工具版本可被外部解析混淆 | 直接依賴按原 lock 精確鎖定；發布以 Node 執行專案根 node_modules 的 Wrangler，核對實際版本，不尋找全域或 npx 自動下載替代工具。 |
| 安裝了依賴仍不等於真實打包通過 | Cloudflare／GitHub／本機完整發布均要求依賴、型別、語法、真實 dry-run、儲存及業務測試；失敗會指明檢查名稱，正式流程無跳過開關。 |
| 生成部署配置只核對部分ID | 整份產生後配置與加密狀態內已備份配置比對；main、build 等被修改也停止。 |
| 同一待恢復批次中改了測試或建置配置 | 來源摘要擴及測試、工作流、lock 與相關設定；不把測試輸出、node_modules 或臨時授權值列入，避免正常重試誤判。 |
| deploy 包裝命令忽略未知參數 | 拒絕未支援的選項，`--help` 不發布，從不同工作目錄也解析到同一專案。 |

## Wrangler 的兩個版本不是本次中止原因

原 lock 中：根目錄發布工具是 `wrangler@3.114.17`；`@cloudflare/vitest-pool-workers@0.5.41` 的間接測試依賴包含 `wrangler@3.100.0`。所以安裝期出現3.100.0警告、發布期顯示3.114.17，與原依賴樹相符，不能直接判為快取損壞。

本版保留原 lock 的實際套件版本／tarball／integrity，不在無法做完整相容驗證時強行升到 Wrangler 4，亦不以 override 強換測試框架內的 Wrangler。**3.100.0、rollup-plugin-inject 和 sourcemap-codec 的 deprecated 警告可能仍出現；本版沒有宣稱消除全部警告。** 你的日誌真正退出原因是 ST_DEPLOY_COMMAND，並非這幾條 warn。

可執行 `npm run deploy:doctor` 只看本地依賴核對報告，無遠端操作；`npm run test:toolchain` 才要求實際已安裝版本一致。報告不列出環境機密。依賴缺失應用本版完整 lock 執行 `npm ci --include=dev`，而不是用全域 Wrangler 補救。

## 更新完整原專案，保留原資料與機密

將 ZIP 解壓後的內容更新到原儲存庫，包括 scripts、src、tests、.github、package.json、package-lock.json、.node-version；不是把 ZIP 本身上傳。合併保留原 wrangler.toml 的準確 name、KV／D1 ID、routes、vars 等專屬設定。不要以示例名稱替換原 Worker。

在 **Builds 的 variables / secrets** 中核對：

| 名稱 | 要求 |
|---|---|
| CLOUDFLARE_ACCOUNT_ID | 原32位Account ID |
| CLOUDFLARE_API_TOKEN | 原Worker發布、原KV讀寫、原D1查詢／讀写及必要設定讀取權限；路由按原站需求；不需要R2 |
| SUBSTRACKER_BACKUP_PASSWORD | 至少16字元；原備份密碼另存，恢復同一批次時必須一致 |
| SUBSTRACKER_WORKER_NAME | 原Worker準確名稱，非新名稱 |
| SUBSTRACKER_WORKER_URL | 自訂域名／停用workers.dev時填原HTTPS源地址，不含/admin或查詢 |
| SUBSTRACKER_ENVIRONMENT | 原有命名環境才設；沒有則留空 |

只在 Worker 執行時或 GitHub Secrets 設定，不會自動成為 Builds 的設定。請勿把 Token、密碼、原資料或解密備份 Commit／貼到聊天。此頁不要求R2權限、bucket、金鑰，沿用原D1／KV。

環境需求：Node ≥22.13、npm ≥10、Python ≥3.11；你提供的Node22.23.3／npm10.9.2符合前兩項，日誌沒有顯示Python，會由预檢確認。安裝不要省略devDependencies。發布入口保留完整型別／Workers測試，不將本機模擬結果當成正式檢查通過。

## 正確執行與完成判斷

流程仍是 **兩階段，不是本版新增了無人接續**：

```text
Git提交 → Cloudflare自動啟動
 → 本機必需檢查
 → 原Worker／KV／D1核對 → 加密備份及回讀驗證
 → 發布維護版本 → ST_UPGRADE_WAIT（readyAfter）
 → 到readyAfter後手動Retry【同一提交】
 → 維護期備份 → 增補遷移 → 逐項原資料驗收
 → ST_UPGRADE_COMPLETE，maintenance:false
```

第一次Build綠燈而日誌是WAIT，網站仍處於維護，**不是部署完成**。保留16分鐘舊任務結束等待，不在一次Build裡空等；提早Retry不縮短等待。Cloudflare目前一次Build總時限20分鐘，本版單次部署命令保留15分鐘預算，不保證所有資料量都能兩次完成。

完成應同時看到 `ST_UPGRADE_COMPLETE` 和 `/api/upgrade/status` 的 `version:3.3.24`、`maintenance:false`。再核對訂閱記錄、累計歷史、帳號密碼狀態、模板及表格保存。備份下載用 `npm run upgrade:download`，另存安全位置；同一KV的備份不等於獨立災難備份。

**若3.3.23或更早批次已WAIT／維護而未完成，先用那一版原提交與原加密附件恢復，不要把3.3.24替換進未完成批次。** 這次你提供的日誌只證明該次raw部署被攔下，無法證明帳戶內不存在其他升級批次。

## 新日誌如何判讀

| 訊息 | 意義／處理 |
|---|---|
| ST_DEPLOY_COMMAND | 仍在raw入口，核對控制台Deploy command；不是資料庫錯誤 |
| ST_TOOLCHAIN | 缺依賴／混用lock／實際版本不符；完整npm ci，保留具體錯誤 |
| ST_BUNDLE | 真實dry-run失敗或未產生bundle；這一階段沒有發布 |
| ST_DEPLOY_CONFIG | Build機密、Python、網址或名稱配置不足；修正該項 |
| ST_SPLIT_TEST | 後接具體未通過的檢查名與exit；不要跳過測試強上線 |
| ST_DEPLOY_CONFIG_CHANGED | 生成配置與加密備份內的配置不符；保留原附件並核對，不自動覆寫 |
| ST_SPLIT_SOURCE／ST_SPLIT_OLD_RUN | 原未完成批次與新版來源不同；用原提交恢復 |
| ST_UPGRADE_WAIT | 第一階段完成，需要到時Retry，不是最終成功 |
| ST_UPGRADE_COMPLETE | 仍須核對狀態頁版本與maintenance:false |

此包不操作你的控制台、不移除線上安全門禁、不清庫、不建立替代儲存。真實線上成功必須由正式環境的本次完整檢查及驗收結果確認。

## 官方文件（核對於2026-10-08）

- Workers Builds設定、兩個命令欄位及機密：https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
- Build時限：https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/
- Wrangler major升級指南（本版未直接執行major升級）：https://developers.cloudflare.com/workers/wrangler/migration/update-v3-to-v4/
