# SubsTracker v3.3.32｜驗證報告

日期：2026-10-09。基準：本對話完整 v3.3.31，並核對本對話完整 v3.3.29 / v3.3.30 的累積修補相容性。

## 結論及範圍

本版已實作原 repository 的「無 D1/KV Binding 部署 → 手動綁回原資源 → 受驗證的 /init」流程。下列本地回歸通過；**沒有執行使用者真實 Cloudflare 部署，亦沒有讀寫使用者線上 D1/KV。**

**鎖定依賴未成功安裝，因此完整 build、正式鎖定 TypeScript／Wrangler dry-run、原生 Workers-pool 測試尚未通過本機實測。不能把下列 SQLite／模擬 API／離線瀏覽器結果當成原生平台或線上成功。** npm ci 的保留輸出是 `Exit handler never called!`；build 實際停止於缺少鎖定 Hono 的工具鏈檢查；npm test 停於 `vitest: not found`。部署端沒有刪除或略過這些必要檢查。

## 實際結果

| 檢查 | 實際結果 | 證據／限制 |
|---|---|---|
| Node 全部部署、升級、儲存、相容、runtime、table contract、web init | 363 / 363 PASS，0 FAIL、0 SKIP | node-release-363.log；Cloudflare 傳輸／发布器為測試替身，資料庫使用實際磁碟 SQLite fixture。 |
| 新增無綁定部署 | 16 項通過 | 已包含在 363 中；不是另加一次。 |
| 新增網頁 init | 36 項通過 | 已包含在 363 中；真實 Node Request / Crypto 與 SQLite、可控 KV fixture。 |
| 源碼語法 | 121 / 121 PASS | syntax-121.json。 |
| 原業務流程回歸 | 69 / 69 PASS | workflow-69.log；磁碟 fixture，非線上 API。 |
| 原 Table API 回歸 | 37 / 37 PASS | table-api-results.json、table-api-37.log；直接呼叫原 handler 與磁碟 fixture。 |
| init 桌面／390px 手機畫面和互動 | 離線 Chromium 檢查通過 | browser-offline.json；以 set_content + mock fetch 驗證按鈕／確認／續跑回圈／完成／密碼清除，並檢查無橫向溢位。 |
| 真正 HTTP 頁面、瀏覽器 CSP 強制 | 未完成 | 瀏覽器導航回報 ERR_BLOCKED_BY_ADMINISTRATOR；沒有把離線測試稱為同源網路／CSP 實測。CSP header、nonce、同源 API 拒絕另有 Node 測試。 |
| 新增 Workers-pool 原生案例 | 4 項已加入，未執行 | tests/init/web-init.worker.test.js；不算入任何通過數。 |
| 鎖定依賴、完整 build、原生 Workers | 未完成 | npm-ci-failed.log、build-unavailable.log、native-workers-unavailable.log。 |
| 真實 Cloudflare 部署、真實 init | 未執行 | 沒有帳戶憑證、原線上資源／真實資料；不宣稱部署成功。 |

結果目錄：`tests/results/3.3.32/`。其中 UI 截圖為離線合成資料，不是使用者網站。歷史版本的測試報告保留，不代表本版重新執行其所有原生測試。

## 新增測試覆蓋

無綁定部署：settings／active deployment 兩來源核對；不可將 API 錯誤或缺失清單當作零綁定；不自動移除部分綁定；本地過期 ID 不混入無綁定設定；保留變數／機密名稱／Cron／workers.dev；測試失敗不發布；來源與發布計畫不符拒絕；部署期間綁定改變拒絕；同 runId 等待頁才確認程式部署；不要求原已解綁站點先健康，不讀寫資料 API。

init：完全無綁定顯示頁；GET 不寫入；單邊綁定不能啟動；SuperAdmin／使用者名稱／同源 JSON／大小／確認保護；預覽後資料變更停止；原 config、密鑰、KV 業務鍵及 D1 業務行保持；既有歷史保留；缺少結構追加；空 KV 與不相容舊結構停止；寫入／驗收失敗不假完成；25 筆資料跨批續跑；並行 start／ledger 冪等；重複執行不增加歷史；KV 延遲回讀不反覆 put；原收據衝突停止；換綁另一 KV 或換發布識別不能沿用批准；普通 config 更新不永久鎖站，但資料密鑰改變會重新阻擋。

最後修改了完成報告時間，使 completedAt 記錄實際驗收階段而非啟動時間；其後重新執行完整 Node 363 項並通過。

## 沒有降低的发布檢查

`verifyReleaseChecks` 保留 test:runtime、test:toolchain、lint、test（原生 Workers）、test:context、test:syntax、test:bundle（真實 Wrangler dry-run）、test:storage、test:deploy、test:upgrade、test:table-contract、test:workflow，並增加 test:web-init。沒有把本地缺依賴轉成成功，也沒有禁用原文件檢查。

## 本地重現命令

Node >=22.13.0，npm >=10，Python 3 標準庫。

```sh
npm ci --include=dev
npm run build
npm run verify:release
npm run test:table-api
```

不依賴原生 Workers 套件的 Node 檢查：

```sh
node --test --test-concurrency=3 tests/deploy/*.test.mjs tests/upgrade/*.test.mjs tests/storage/*.test.mjs tests/compat/*.test.mjs tests/runtime/*.test.mjs tests/regression/contract.node.mjs tests/init/*.test.mjs
node scripts/check-syntax.mjs
npm run test:workflow
npm run test:table-api
```

這些命令只應在測試／發布工作目錄執行；真正發布仍使用原 `npm run deploy:cloudflare`，不要直接呼叫未授權的 Wrangler deploy。

## 原碼範圍與資料界線

新增 deploy-unbound、web-init-protocol、web-init-schema、web-init、web-init-page；修改原 Cloudflare 入口、發布 guard、環境驗證、測試清單及 runtime 門禁／自動遷移開關。一般業務 API、UI、原 SQL migrations、批量導入／導出實作及依賴解析版本與 v3.3.31 保持一致。

wrangler.toml 與三個已提供基準包相同，累積補丁不含此檔；真實自訂環境須保留。沒有新建 R2、KV、D1 或將其他資源自動綁入。

init 僅在既有 v3 KV 和相容 D1 結構上追加缺失結構／不可變歷史及本次升級 metadata。原業務行不被覆蓋，缺欄位會帶有新增欄位的 schema default；不宣稱資料庫整個檔案位元組完全不變。KV 的更新是新增本次收據，不是清空重建或強制改寫 schema_version。

未綁定階段不備份原資料；網頁確認不是备份驗證。綁回歷史原資源 ID 由操作者核對，runtime binding 不能自動證明解綁前 ID。D1 batch 有單批交易，但與 KV 沒有跨服務交易，也沒有阻止其他 Worker 的全域寫入鎖。實際大資料量容量、計費／配額及真實平台延遲未經使用者環境驗證。

## 發布包驗證

完整包與累積修補包經 ZIP testzip、每檔 SHA-256 核對。累積差異由三個實際基準 ZIP 計算，不靠猜測檔案名。對每個基準以補丁覆蓋後，完整檔案集合和每檔內容均需與 v3.3.32 完整包一致，否則打包程序停止。詳細基準 SHA-256 與逐版比對見同次交付 `SubsTracker_v3.3.32_PACKAGING.json`。

此逐檔驗證只適用本對話提供的原版 ZIP；不是對使用者額外自訂／巢狀殘留檔案作相容保證。補丁不會刪除使用者的額外檔案。
