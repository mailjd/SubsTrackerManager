# SubsTracker v3.3.26｜Python SQLite 建置相容修正

基於實際 v3.3.25 ZIP，對應 `test:workflow` 的 `ModuleNotFoundError: No module named '_sqlite3'`。

## 這次要改的是專案，不是控制台機密

日誌已經進入 `npm run deploy:cloudflare` 並通過前面的檢查；Python 在匯入 sqlite3 時就中止，69 個工作流案例還沒有開始執行。這不等於正式 D1 壞掉，也不是 Node 的 SQLite ExperimentalWarning 導致中止。

新版保留 Python 作為測試流程協調及 TOML 讀取工具，但把三個 Python 腳本的本機 SQLite 存取改為 Node 內建 `node:sqlite`。仍然直接讀取磁碟資料庫、核對持久化，不以 API 回應或模擬成功資料代替。

## 更新

將本 ZIP 解壓後的專案內容提交到原儲存庫。以下新增／修改檔案必须一起更新：

- `scripts/check-test-runtime.mjs`、`scripts/run-python-test.mjs`、`scripts/build.mjs`、`scripts/upgrade/release-checks.mjs`
- **`tests/support/`、`tests/runtime/`** 與 `tests/regression/`、`tests/upgrade/old-version-integration.py`
- `package.json`、配套 `package-lock.json`、版本來源與 `.github/workflows/`

保留原倉庫其他來源，包括既有 `src/pages-handler.js`。v3.3.25 的 props 相容修補仍在，沒有用未知檔案覆蓋它。

不要覆蓋原 Worker 名稱、正式 KV/D1 ID、路由、Token、帳號密鑰或備份密碼。不要刪除原資料庫、清空記錄或移除 build guard。

Cloudflare 設定保持：

| 欄位 | 值 |
|---|---|
| Build command | `npm run build`（亦可留空，由部署入口完成必要檢查） |
| Deploy command | `npm run deploy:cloudflare` |
| Node | 沿用目前 Node 22；這份日誌的 22.23.3 不需更換 |
| Python | Python 3.11+ 與 TOML/標準庫可用；**不再要求 Python sqlite3/_sqlite3** |
| 備份密碼與原憑證 | 沿用原值 |
| 遠端儲存 | 原 D1＋KV，無 R2 |

**不用 pip install sqlite3、不用 apt 安裝 SQLite、不用重編 Python，也不需要為這個错误切換 Python 版本。** 新版沒有新增 npm 原生 SQLite 套件或網路下載備援。

這次應提交新版後執行該提交，不是只 Retry 未改動的 3.3.25。若另一次舊升級已進入維護但尚未完成，仍須先以該批次原提交及恢復憑證接續；不能混用來源。

## 預期日誌與判定

新增能力預檢會在建置／發布檢查前讀寫獨立暫存資料庫，並透過 Python→Node 子程序實際回讀：

```text
[runtime] ST_TEST_RUNTIME_OK
"sqliteEngine":"node:sqlite"
"pythonSQLiteRequired":false
"crossProcessDiskRead":true
"remoteAccess":false
```

工作流入口變為：

```text
> subscription-manager@3.3.26 test:workflow
> node scripts/run-python-test.mjs tests/regression/workflow3319.py .
...
TOTAL 69 PASS 69 FAIL 0
```

這只代表該項測試通過。完整 lint、Workers Vitest、備份、D1/KV 權限與逐項驗收仍然必須成功；任何真實 SQL／測試錯誤都會保留非零退出狀態。

原分階段流程不變：第一階段 `ST_UPGRADE_WAIT` → 到 `readyAfter` 後手動 Retry 同一提交 → `ST_UPGRADE_COMPLETE`。只有 `/api/upgrade/status` 顯示版本 **3.3.26**、`maintenance:false` 且驗收通過才算完成。本版沒有新增自動觸發第二次 Build。

## 可重跑的本機核對

```sh
npm run test:runtime
npm run test:workflow
npm run test:table-api
# 刻意禁止 Python 匯入 sqlite3 和 _sqlite3，仍須跑完真正工作流：
python3 tests/runtime/no-sqlite-python.py tests/regression/workflow3319.py .
```

`no-sqlite-python.py` 只做故障注入；不偽造查詢資料、不跳過斷言、不改寫系統 Python。SQL 仍由 Node 對本機磁碟資料庫執行。

完整測試邊界與結果见 `VERIFICATION_3.3.26.md`。這不是已登入或發布你的正式 Cloudflare 的證明。
