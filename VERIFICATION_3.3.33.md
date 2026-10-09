# v3.3.33 實測報告與界線

日期：2026-10-09。來源基準：本對話完整 `SubsTracker-GitHub-Cloudflare-Ready_v3.3.32_UnboundWebInit_20261009.zip`。本版修正預設模式自動回退及 `ST_DIRECT_URL`／`ST_UNBOUND_URL` 網址先決條件；不是線上部署成功證明。

## 結果

| 測試 | 本輪實測 | 性質 |
|---|---|---|
| 完整 Node 回歸 | **403 tests / 403 pass / 0 fail / 0 skipped**，退出碼 0 | 原部署、升級、儲存、相容性、runtime、web-init 及 table contract；Cloudflare、Wrangler、部分發布檢查使用模擬 |
| 生產 JS/MJS/CJS 語法 | **122 / 122 通過** | `scripts/check-syntax.mjs` |
| 原業務工作流程 | **69 / 69 通過** | Node/SQLite 與既有離線回歸適配器，不是遠端 D1 |
| 原 Table API | **37 / 37 通過** | 既有離線 API 回歸，不是線上站點 |
| 全部鎖定依賴 `npm ci` | **失敗／未完成** | 多個 registry.npmjs.org tarball 的 DNS `EAI_AGAIN`，npm 結束時另報 Exit handler never called |
| 真正 `npm run build` | **未通過，退出 1** | 鎖定 hono 等依賴未安裝，在 toolchain 檢查停止；未進入真正 tsc / Wrangler 打包 |
| 真正 `npm test` | **未執行成功，退出 127** | `vitest: not found`；不得計入 Workers 測試 PASS |
| 真實 Cloudflare 發布／線上 init | **未執行** | 沒有使用者 API 認證或線上環境；未讀寫使用者資料 |

**403 是 Node 測試案例數，不是 403 次線上部署。** 各專項是其中的子集，不可重複相加。完整命令：

```sh
node --test --test-concurrency=2 \
  tests/deploy/*.test.mjs tests/upgrade/*.test.mjs \
  tests/storage/*.test.mjs tests/compat/*.test.mjs \
  tests/runtime/*.test.mjs tests/init/*.test.mjs \
  tests/regression/contract.node.mjs
```

其他實測命令：`node scripts/check-syntax.mjs`、`npm run test:workflow`、`npm run test:table-api`。Node 22.16.0、npm 10.9.2、Python 3.13.5、Node SQLite 3.49.1。套用到使用者環境時，仍使用原精確鎖定依賴，不升級或替换套件來粉飾結果。

## 本次新增 40 項測試

原有 unbound runner 16 項按新「網址與程式分離」語義調整並保留；新增 25 項，共 41 項。另新增 deployment-evidence 12 項、預設 CLI 3 項：合計 **新增 40 項**。新的 56 項針對性測試（含原有 16 項）全部包含在 403 項總數內。

覆蓋：

- 完全解綁＋workers.dev 關閉＋缺少 Build URL：單次程式發布、控制平面核對成功、資料仍鎖定。
- 殘留 KV／D1／兩者同時存在：預設 CLI 不切 direct，報目標及兩來源殘留 binding，沒有發布或資料 API。
- 原 Custom Domain、根 Route、已啟用 workers.dev；不同 Worker／非預期環境、萬用主機名、子路徑 Route 不猜測網址。
- 網址探測 403、redirect、DNS 失敗、非 JSON、過大回應、錯版本／runId／mode：只影響 URL 核對，不能算 init 完成。
- 無新現行版本、marker 缺失或 sourceHash 不符、只有 settings 有 marker：不把退出 0／HTTP 有回應當成程式成功。
- 原 secret 名稱遺失、發布前／後變更 binding 或版本、灰度流量、原變數名稱衝突、API 權限錯誤：保護仍有效。
- 預檢失敗與發布器失敗有不同 stage／publishAttempted／codeDeployed；不再輸出一律「可能已上傳」的固定警語。

`unbound-cli.test.mjs` 啟動**真正的預設 CLI 進程**、產生真實計畫、執行真實 `require-safe-upgrade.mjs`，但 API transport、Wrangler upload 與 npm 發布檢查命令均為隔離替身。測試用 `.invalid` 網域、合成 ID／憑證，沒有網路 fallback。這不是一條真實 Cloudflare 端到端測試。

舊 `direct-runner` 測試先前把「直接升級」當預設，因此在改模式後初輪失敗。本次將它們改為**明確傳入 `direct` 的舊流程回歸**，保留原備份／資料保護斷言；新的預設 CLI 另有獨立測試。未刪測試、未把失败改為忽略，也未把 direct 恢復成預設。

## 打包檢查的改動

`test:bundle` 現在要求真實 Wrangler 分別 dry-run **合成 D1/KV 設定**及**零 D1/KV 設定**；兩者都必須產生 JS 輸出。此 wrapper 的離線行為用測試替身驗證了，但本環境因依賴未安裝，**沒有完成這兩次真實 Wrangler dry-run**。此強制檢查在正式發布入口保留，沒有變成可跳過的選项。

原 `RELEASE_CHECKS` 清單保留：runtime、toolchain、lint、真正 Workers tests、context、syntax、bundle、storage、deploy、upgrade、web-init、table-contract、workflow。精確鎖定的依賴版本未改。

## 原碼改動範圍

修改原部署入口、unbound runner、控制平面／URL 證據處理、控制 API GET 白名單、可選網址解析與雙儲存形態 dry-run；增加測試及操作說明。

`src/` 除 `version.js` 與 `upgrade-release.js` 的版本識別外，與完整 v3.3.32 **逐檔相同**。`src/data/web-init.js`、init 身份驗證／schema 更新、migrations、業務 API 及 public UI 未改。修補包不包含 `wrangler.toml`。

新版唯一新增的運行時一般變數是內部非秘密 `SUBSTRACKER_CODE_RELEASE_V1`，不是 D1/KV 資料、不是密碼，也不能放行 init。原一般變數／JSON 與 Secret 名稱會核對；Secret 明文不可從 API 回讀，所以沒有聲称驗證過其明文。

## 仍需承認的限制

本地有通過測試不代表使用者環境的 npm、Cloudflare API 權限、Wrangler 或路由一定成功。若 Cloudflare 不接受上傳、現行版本缺少正確證據或正式 Workers 測試失败，程式仍會停止並記錄階段，不假報成功。

無綁定發布不是有 D1 原子鎖的停寫遷移。控制平面前後核驗無法消除最後核對到上傳間的全部競爭窗口；同一 Worker 不要有第二個並行發布器或變更綁定的人員。無綁定階段也不可能替你讀取／備份解綁資源，備份須在解綁前做好。

網址未核對仍可完成程式發布，但不代表 `/init` 在公網可用；需要用原可達 URL 進行後續操作。資料升級只在綁回原 ID 後，經網頁身份驗證、預覽／確認及原資料回讀驗證完成。

## 原始紀錄

本包 `verification/v3.3.33/` 包含完整 403 項 TAP、語法／工作流／Table API 紀錄、預設 CLI 紀錄、依賴安裝錯誤、實際 build 與 Workers 嘗試結果。`PACKAGE_CHECK_3.3.33.json` 記錄累積補丁還原的逐檔結果，`FILE_MANIFEST_3.3.33.json` 提供 SHA-256 清單。
