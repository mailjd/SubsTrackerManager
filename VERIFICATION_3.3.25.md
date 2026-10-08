# SubsTracker v3.3.25｜ExecutionContext.props 舊來源相容修補與驗證

日期：2026-10-08。輸入：實際 v3.3.24 DeploymentPreflightFix ZIP，以及使用者 09:24:22Z 的 Cloudflare 日誌。**這是本機修補驗證報告，不是正式 Cloudflare 發布驗收報告。**

## 1. 已確認的阻斷點

使用者日誌顯示 `npm run deploy:cloudflare` 已執行，出現 `ST_DEPLOY_ENTRY` 後，`test:toolchain` 通過；接著完整 `tsc --noEmit -p jsconfig.json` 報錯：

```text
src/pages-handler.js(30,50): error TS2345
Argument of type '{ waitUntil(promise: any): void; passThroughOnException(): void; }'
is not assignable to parameter of type 'ExecutionContext'.
Property 'props' is missing ... but required in type 'ExecutionContext'.
```

因此，這次不是先前的部署命令或密碼長度錯誤，也不是 SQLite ExperimentalWarning。仍不能以通過本機機密格式檢查推論遠端 Token 權限、備份及遷移都已成功。

## 2. 很重要的來源差異

實際重新檢查 v3.3.24 ZIP 的 330 個檔案，**沒有 `src/pages-handler.js`**。目前可見的更早 ZIP 中也沒有提供這個檔案。Files 搜尋沒有取得其完整內容。

但是使用者的建置日誌確實在編譯該路徑。原 ZIP 的來源/內嵌腳本檢查量為105，使用者日誌是204，亦顯示來源树並非完全相同。可能是原 Git 倉庫保留額外來源；不能無證據認定那些檔案都可刪除，或宣稱本機已重現使用者整個私有倉庫。

所以本版**沒有憑空編造一份完整 pages-handler.js 去覆蓋它**。改用針對既有檔案及真實編譯診斷的有界修補。原始 ZIP SHA256、檔案差異與設定保留核對位於 `tests/results/3.3.25/source-input-audit.json`。

## 3. 實際修改

| 檔案/設定 | 修改 |
|---|---|
| `scripts/compat/legacy-pages-context.mjs` | 以安裝的 TypeScript 解析實際舊檔，僅處理缺少 props 的 ExecutionContext 編譯診斷。 |
| `scripts/repair-pages-context.mjs` | 本機修補入口；檔案不存在時不建立替代檔，修補或无異動都有明確訊息。 |
| `package.json` | 新增 `prelint`、`repair:context`、`test:context`；原 `lint` 命令仍為完整 `tsc --noEmit -p jsconfig.json`。 |
| `scripts/build.mjs` | 在語法檢查與 Wrangler dry-run 前實際執行 `npm run lint`，避免只打包成功却忽略型別錯誤。 |
| 發布檢查及工作流 | 增加必要的 `test:context`；原 storage/deploy/upgrade/workflow/Workers Vitest、備份與驗收檢查不移除。 |
| 版本與相容快照 | 版本統一3.3.25；表格保存協議仍2；本機原檔快照目錄列入gitignore。 |

在可識別的原物件開頭只插入 `props: {},`，保留每一個其他原始字元，包括原方法內容、this 綁定、import/export、request/env轉發與註解。props 不取自任意 request/env，不從請求輸入推導授權設定。

修補只接受診斷對應的直接物件或 const 初始化物件，其靜態欄位恰為 waitUntil/passThroughOnException。遇到工廠、別名、mutable/reassigned情境、spread或未知形狀會停止，不猜測改寫。已存在 props 不覆蓋。候選修改先在記憶體重新編譯；若 props 需要其他特定內容或引入新錯誤，原檔不寫入。

寫入前核對來源未被同步改動，保存本機原檔快照，再原子寫回。重跑不重複插入，不更改已修補來源的指紋。原程式的其他型別錯誤仍由完整 tsc 阻擋，不使用 `@ts-ignore`、`@ts-nocheck`、強轉 any 或排除檔案。

## 4. 本次實際驗證

| 測試組 | 通過 | 範圍/證據 |
|---|---:|---|
| 舊來源/props 定向回歸 | 20/20 | `context-fixtures.tap`。實際 TypeScript 編譯與 AST、原檔快照、idempotence、真實 npm prelint→tsc、來源指紋、異常拒絕。 |
| 部署預檢與分段接續 | 59/59 | `deploy-final.tap`。真實 runner/guard/加密/SQLite；Cloudflare傳輸與上傳為隔離假傳輸，不是正式發布。 |
| D1 query與儲存政策 | 36/36 | `storage.tap`。正式模組、本機SQLite，未使用R2或正式資料。 |
| 表格輸入/提醒契約 | 8/8 | `contract.tap`。正式模組。 |
| 訂閱保存與重啟讀回 | 37/37 | `api-results.json`。本機磁碟KV/SQLite與正式API。 |
| Database/歷史工作流 | 69/69 | `workflow-results.json`。新增、歷史、續訂、模板、批量操作及還原等本機流程。 |
| **本機功能回歸合計** | **229/229** | 不重複計入單獨重跑或中間輸出。 |

另通過 **107項 JavaScript/內嵌script語法檢查**，見 `syntax.log`。中間中止的測試輸出保留在 `intermediate/`，不計為通過；本次未重跑瀏覽器、完整舊版跨版矩陣或額外完整upgrade測試組，不拿舊版結果當作本次結果。

### 定向型別測試的準確邊界

20項測試使用的是**依日誌錯誤形狀重建的合成 adapter**，不是使用者未提供的 pages-handler 原檔。測試以最小 ExecutionContext 宣告重現TS2345，再驗證插入 props 後錯誤消失。

本機實際可用 TypeScript 是 **5.8.3**；這個編譯器只用於本機定向回歸，**沒有將它寫進或降級專案 lock**，也沒有篡改其套件版本。正式發行仍鎖定 **5.9.3** 及 `@cloudflare/workers-types 4.20260524.1`，會在使用者 Build 中以實際依賴檢查候選及完整原倉庫。

測試也涵蓋：原檔逐字保留、兩個呼叫共用一個context、inline物件、已存在props、CRLF/註解/綁定方法、已有其他型別錯誤、props特定型別不允許空物件、符號連結/語法錯誤/未知形狀拒絕。真實npm生命周期測試從其他工作目錄呼叫，不使用假npm取代這項確認。

## 5. 資料及設定保留

`src/data`、`src/api`、`src/core`、`src/services`、`migrations`、`public` 共 **67個業務檔案與v3.3.24位元組完全相同**。對照在 `business-source-comparison.json`。

`jsconfig.json`、`wrangler.toml` 位元組不變，沒有移除型別檢查或改正式綁定。直接及間接依賴版本不更換；package/lock僅更新發行版metadata與scripts配置。修補器本身沒有網路請求或D1/KV讀寫，不接觸訂閱、密文、歷史、模板或機密。

原 D1＋KV query-only 備份、遠端恢復協調、16分鐘維護等待及來源驗收保留。不新增R2、物件儲存權限或替代資料庫。`.compat-backups`只是建置機上的原程式快照，不是獨立資料庫備份，也不保證隨Build臨時環境消失後仍可取得；原Git提交本身仍是來源備份。

## 6. 尚未完成的驗證

本次 `npm ci` 在30秒本機上限內未完成；另行實際連線測試顯示registry DNS無法解析。完整鎖定依賴未安裝成功：

- 完整 `npm run lint`：因缺少 `@cloudflare/workers-types`，返回TS2688，**未通過**。
- 完整 `npm test`：缺少Vitest，返回127，**未通過**。
- 本次真實Wrangler完整bundle/上傳：**未執行完成**，不拿先前使用者成功dry-run或假上傳當作本次通過。
- 正式Cloudflare帳戶、完整私有倉庫與線上資料：**沒有連接或修改**。

對應嘗試輸出在 `npm-ci.*`、`registry-connectivity.log`、`full-lint-attempt.*`、`full-workers-test-attempt.*`。完整5.9.3+Workers型別檢查和Workers Vitest仍是部署必需項；相容修補成功不會直接放行發布。

## 7. 更新與驗收

依 `DEPLOY_REPAIR_3.3.25.md` 更新完整包，控制台維持 `npm run build` / `npm run deploy:cloudflare`，原密碼及原KV/D1保持不變。

看到 `ST_CONTEXT_REPAIRED` 再看到完整lint通過，才代表本次型別阻斷已排除；它不是完成資料升級的標誌。正式仍需 WAIT→同提交接續→COMPLETE，狀態版本3.3.25、maintenance:false。

遇到未知原檔形狀時停止，需取得其完整來源核對；本版不能保證任意額外來源或任意環境一次發布成功。

## 8. 參考資料

官方Context API：https://developers.cloudflare.com/workers/runtime-apis/context/
官方Pages EventContext：https://developers.cloudflare.com/pages/functions/api-reference/
npm pre/post scripts：https://docs.npmjs.com/cli/v10/using-npm/scripts/

打包後以 `FILE_MANIFEST_3.3.25.json` 核對本包；旧版manifest及報告是歷史證據，不是本包校驗表。交付不包含node_modules、本機測試資料庫、正式憑證、恢復令牌、執行中的升級狀態或字體檔。
