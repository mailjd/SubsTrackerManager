# SubsTracker v3.3.26｜Python SQLite 建置失敗：修正與驗證

日期：2026-10-08。基礎為實際 `SubsTracker-GitHub-Cloudflare-Ready_v3.3.25_ExecutionContextFix_20261008.zip`。本次測試使用合成資料、本機 Node 22.16.0／Python 3.13.5；**沒有登入或部署你的正式 Cloudflare，沒有讀寫正式 KV／D1。**

## 1. 本次失敗根因

使用者的 Cloudflare 日誌已進入 `test:workflow`，執行 `python3 tests/regression/workflow3319.py .` 時，在模組頂層 `import sqlite3` 中止：

```text
ModuleNotFoundError: No module named '_sqlite3'
ST_SPLIT_TEST：test:workflow 未通过
```

這是該建置 Python 缺少可用的原生 `_sqlite3` 擴充，不是正式 D1 查詢失敗，也不是 Node 的 SQLite ExperimentalWarning。僅檢查 Python 版本並不足以保證此可選模組可用。69 個工作流案例在此次錯誤中尚未開始執行。

原 ZIP 子程序重現：以故障注入攔截原 Python 的 `_sqlite3` 匯入，原工作流同樣於 import 階段非零退出。證據為 `tests/results/3.3.26/original-missing-sqlite.log`／`.exit`。故障注入沒有更改系統 Python 或正式資料。

同時找到三處直接依賴 Python sqlite3：工作流、表格 API 磁碟回读，以及旧版本升級核驗。只更換第一個 import，不能完整消除此專案內的同類阻斷。

## 2. 實際修改

| 範圍 | 修正 |
|---|---|
| `tests/support/sqlite-local.mjs` | 使用已存在的 Node 內建 `node:sqlite`，在独立子程序直接開啟現有本機 SQLite 測試檔案。一般讀取唯讀；合成損壞資料的寫入需明確啟用，並在同一交易提交或回滾。不是 HTTP/API 回讀，也不是偽造結果。 |
| `tests/support/sqlite_local.py` | 僅用 Python 標準庫傳遞有型別 JSON，沒有 sqlite3/_sqlite3 匯入、pip、原生套件安裝或網路備援。 |
| 三個 Python 協調腳本 | `workflow3319.py`、`api-regression.py`、`old-version-integration.py` 的 SQLite 存取改用上述橋接；原案例與判定保留。Python 仍協調 HTTP／子程序／TOML，不是完全移除 Python。 |
| `scripts/check-test-runtime.mjs` | 發布前實際建立暫存資料庫、寫入 Unicode 與 int64，再經 Python→另一 Node 子程序從磁碟回讀；不只看版本。輸出 `ST_TEST_RUNTIME_OK` 與 `pythonSQLiteRequired:false`。 |
| `scripts/run-python-test.mjs` | 統一選定的 Python／Node，傳遞原測試退出碼，超時／缺少執行器／SQL 失敗仍阻擋。`test:workflow` 改由此入口執行。 |
| 發布檢查 | `test:runtime` 放到必要檢查最前；保留完整 lint、context、syntax、bundle、storage、deploy、upgrade、contract、workflow、Workers Vitest。沒有跳過開關。 |
| 重複建置 | 測試支援模組禁止產生 `__pycache__`，避免臨時 bytecode 改變跨 Build 的來源指紋。未放寬原指紋／備份驗收算法。 |

橋接保留 NULL、空文字／空 BLOB、中文、引號、int64、浮點與二進位資料。針對本機 Node SQLite 在直接讀取含 NUL 文字時的截斷，改在 SQLite 內先做 HEX 轉換再解碼，以原 byte 內容測試核對。SQL 使用參數綁定；不存在／损壞資料庫、缺少 Node、SQL 錯誤、非完整回應、多語句／不支援的型態或長度超限皆非零退出，不返回空陣列假成功。

此橋接只處理本機測試 fixture，不是線上 D1 存取層。測試使用同一 SQLite 引擎，但磁碟回讀在獨立程序進行，不將同一 API 回應當作持久化證據。

## 3. 本次實際執行結果

| 測試組 | 通過／總數 | 邊界／主要證據 |
|---|---:|---|
| runtime＋deploy＋storage＋upgrade＋contract Node 組 | 182／182 | `core-node-final.log`，包含本次新增21項 runtime。升級 REST／Wrangler 上傳用隔離假傳輸，實際本機 SQLite／加解密／guard 仍執行。 |
| 真正 npm 工作流，指定的 Python 同時禁止 sqlite3/_sqlite3 | 69／69 | `workflow-npm-no-python-sqlite.log` 與 `workflow-results.json`。不是跳過失敗案例，真正跑完工作流及資料回讀。 |
| 表格 API／重啟及磁碟回讀，同樣禁止 Python SQLite | 37／37 | `api-no-python-sqlite.log` 與 `api-results.json`。正式 API＋本機 KV/SQLite adapter。 |
| 保留的 ExecutionContext 相容修補 | 20／20 | `context-regression.log`。本機 TypeScript **5.8.3** 的定向 fixture，不是完整鎖定5.9.3＋使用者額外來源型別驗收。 |
| **本機功能回歸合計** | **308／308** | 不重複計入下面單獨重跑或中途結果；全部無 skip。 |

另實際執行正式 `npm run test:runtime`：能力預檢成功，21/21通過（`runtime-npm.log`，這21項已包含在182內，不再加總）。普通 Python 執行和阻擋 SQLite 的直接入口亦各跑完69項；這些是交叉核對，不重複計數。

額外 **7組舊版來源升級情境**：從實際 v3.3.18／v3.3.19 原來源建立合成記錄，再以本次3.3.26來源核對。涵蓋原KV、帳號密文、設定、模板、歷史保留、重啟不重複、D1部分漏項補齊、舊支付補齊、最新備份、篡改備份拒絕。全程用禁止 Python SQLite 的協調器。`cross-version-results.json` 中最後一行是總結，不算第8組。`actual_3319_to_3320` 等名稱及協議 metadata 版號為原有歷史標籤，不是冒充目的版本；本次目標實際是3.3.26。

其他：109個 JavaScript／HTML內嵌腳本語法檢查、7個Python檔案AST／直接匯入掃描、3份TOML、2份工作流YAML及JSON解析通過。證據都存放於 `tests/results/3.3.26/`。`intermediate/` 的初期失敗與子集重跑保留作排查歷程，未計為最終通過。

### 21項新增相容測試的重點

包括缺少 `_sqlite3` 的實際重現、同時阻擋兩個 Python SQLite 匯入仍能讀取、NUL／Unicode／BLOB／int64往返、參數化查詢、唯讀寫入拒絕、交易失敗完整回滾、多語句／DDL拒絕、缺少執行器／Node SQLite關閉時失敗、選定Python一致，以及原測試exit=7確實向上傳遞。不是只驗證檔案裡有特定字串。

## 4. 資料與既有功能保留

和原 v3.3.25 逐檔 SHA-256 比較：`src/data`、`src/api`、`src/core`、`src/services`、`migrations`、`public` 共 **67個業務檔案完全相同**。`wrangler.toml`、dev/test配置、`jsconfig.json`、加密備份、D1 query快照、儲存政策、KV分片/D1 checkpoint實作也未改寫。

原訂閱、歷史、帳號、公私序號、密文、選單、提醒、自動續訂與模板之資料鍵、結構及處理邏輯不變。沒有清表、重建資料庫、重設密鑰、加入R2或更換儲存ID。

`package-lock.json` 的所有依賴版本、下載位置和integrity保持；只有發行版root metadata更新3.3.26。仍使用原Wrangler、TypeScript及Workers套件版本，未為取得綠燈降低檢查或換套件。三個修改的Python協調腳本，其原`assert` AST逐項相同；原流程案例在上述實測全部通過。

備份門禁、16分鐘維護等待、分階段原提交接續、加密恢復與原記錄逐項驗收保留。**仍需到 readyAfter 後手動 Retry，同一 Build 綠燈不等於升級完成。**

## 5. 未完成與不能宣稱的部分

這不是使用者正式 Cloudflare 建置環境的複製品。本機是Node22.16.0／Python3.13.5，使用者日誌是Node22.23.3／Python3.13.3；我們以顯式阻擋sqlite3/_sqlite3重現核心缺能力情境，而非假稱本機真的缺少系統擴充。

本次實際 `npm ci` 的registry請求失敗（debug含EAI_AGAIN），npm最終`Exit handler never called!`。完整依賴未取得：

- 完整 `npm run lint` 返回TS2688，缺少`@cloudflare/workers-types`：未通過。
- 完整 `npm test` 無Vitest，exit127：未通過。
- 真正 `npm run test:bundle` 由依賴檢查阻擋，hono未安裝：未通過。
- 真正Wrangler發布、使用者完整私有倉庫、正式Token權限與線上資料驗收：未操作。
- 本次未重跑瀏覽器UI，不拿舊版瀏覽器結果冒充新結果。

失敗日誌與退出碼隨包保留；正式發布入口仍必須跑完整檢查，不能把以上本機回歸當作真實Cloudflare全部測試。不能保證排除其他未曝光的倉庫差異、平台權限、配額或執行環境問題。

## 6. 部署操作

見 `DEPLOY_REPAIR_3.3.26.md`。更新**解壓後的完整專案**至原repo，尤其新`tests/support/`、`tests/runtime/`及scripts，不要只改版號或只Retry原3.3.25。保留原Worker名稱、KV/D1 ID、原備份密碼、機密以及額外`pages-handler.js`。

```text
Build command: npm run build
Deploy command: npm run deploy:cloudflare
```

不需安裝R2、pip SQLite套件、apt套件、重編Python或替換現有Node22.23.3。Python3.11+仍需可用，但不再依賴其native sqlite擴充。

看到 `ST_TEST_RUNTIME_OK` 與 `TOTAL 69 PASS 69 FAIL 0` 只是檢查前進；最終需 `ST_UPGRADE_COMPLETE`、`version:3.3.26`、`maintenance:false` 和資料驗收通過。另一舊批次已在維護時，先用原來源及其憑證恢復，不能跨版冒充同一次升級。

## 7. 重跑與封裝

```sh
npm run test:runtime
npm run test:workflow
npm run test:table-api
python3 tests/runtime/no-sqlite-python.py tests/regression/workflow3319.py .
python3 tests/runtime/no-sqlite-python.py tests/regression/api-regression.py .
node --test tests/runtime/*.test.mjs tests/deploy/*.test.mjs tests/upgrade/*.test.mjs tests/storage/*.test.mjs tests/regression/contract.node.mjs
```

完整舊版來源核驗需另準備原18/19包解壓於同一父目錄；使用`tests/upgrade/old-version-integration.py --baseline-dir <dir> --out <fresh-dir>`。只用新的本機輸出目錄，不對正式資料執行fixture工具。

本ZIP附源碼、測試、當次結果及操作說明，不附node_modules、正式憑證、本機測試DB或升級恢復密碼。`FILE_MANIFEST_3.3.26.json` 是本版逐檔SHA-256；舊版manifest/報告只作歷史證據。本次ZIP另做CRC及全部manifest雜湊核對。

## 參考

- Python sqlite3：https://docs.python.org/3.13/library/sqlite3.html
- Python可選擴充／SQLite建置依賴：https://docs.python.org/3.13/using/configure.html
- Node內建SQLite及22.16 API：https://nodejs.org/download/release/v22.16.0/docs/api/sqlite.html
