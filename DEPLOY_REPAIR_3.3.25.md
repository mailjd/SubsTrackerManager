# v3.3.25：舊 Pages 適配檔 ExecutionContext.props 修補

本版針對 2026-10-08 09:24:22Z 的 `src/pages-handler.js(30,50) TS2345`。
目前的部署命令與備份密碼格式檢查已通過，不需改回 raw Wrangler、不需更換備份密碼。

## 為什麼需要相容修補

交付的 v3.3.24 原始 ZIP **不包含** `src/pages-handler.js`，但 Cloudflare 日誌正在編譯此檔。這表示實際倉庫與可核對的發行 ZIP 不完全相同；可能是覆蓋更新保留的額外檔案，不能憑日誌斷言它的完整來源。

`jsconfig.json` 包含 `src/**/*.js`，所以未作為 Workers main 的額外 JS 也可能接受型別檢查。原 context 只有 `waitUntil` 和 `passThroughOnException`，沒有型別所需的 `props`。只做打包或 JavaScript 語法檢查不會證明 TypeScript 相容。

## 本版如何處理

保留原 `src/pages-handler.js`；不要為了更新刪除整個來源樹。新版 `npm run build` 會執行完整 `npm run lint`，而 npm 的 `prelint` 自動執行 `scripts/repair-pages-context.mjs`。

修補器只在該檔真的出現「ExecutionContext 缺少 props」的編譯診斷時執行，解析該診斷對應的物件。若它是已驗證的兩方法物件，僅插入：

```js
props: {},
```

不更換方法內容、this 綁定、request/env、import 或 export；不把 request 或 env 的資料塞進 props。以目前已安裝的 TypeScript 對修改候選再檢查，若新增型別錯誤或無法辨識，就停止而不亂改。

原檔先存到本機 `.compat-backups/pages-handler.<原始SHA256>.js`，然後原子寫回。這是本機程式原檔的快照，不是資料庫備份；已加入 `.gitignore`。不要上傳其內容或任何機密。

再次執行為無異動；沒有該檔時不建立替代檔。每次候選修補的輸出相同，不將時間/隨機值插入原始碼，因此不會因第二次 Build 重複插入 props 而改變來源指紋。

## 更新操作

把本 ZIP 解壓後的專案內容更新到原儲存庫，特別是 `scripts/`（包含 `compat/`）、`tests/`（包含 `compat/`）、`package.json`、`package-lock.json` 及本版來源版本標記。不是只上傳 ZIP 本身，也不是只改版本字串。

保留原 `wrangler.toml` 的 Worker 名稱、KV/D1 ID、路由、機密；本次不需要重新配置或重建資料庫。原倉庫额外的 `src/pages-handler.js` 留在原處，由有界修補器處理。

設定維持：

| Cloudflare Builds 設定 | 值 |
|---|---|
| Build command | `npm run build` |
| Deploy command | `npm run deploy:cloudflare` |
| SUBSTRACKER_BACKUP_PASSWORD | 沿用原已保存的值 |
| Worker / KV / D1 | 沿用原綁定 |
| R2 | 不新增、不使用 |

第一輪預期看到：

```text
> subscription-manager@3.3.25 prelint
[compat] ST_CONTEXT_REPAIRED ...
> subscription-manager@3.3.25 lint
> tsc --noEmit -p jsconfig.json
```

`ST_CONTEXT_REPAIRED` 只代表這一個適配問題已修補，不代表整個升級完成。第二次檢查出現 `ST_CONTEXT_UNCHANGED` 是正常的；乾淨來源沒有舊檔時則出現 `ST_CONTEXT_ABSENT`。

如果出現 `ST_CONTEXT_REPAIR`，表示原檔不是可安全自動修補的形狀，或空 props 不能滿足它的特定型別。原檔不會被覆蓋。此時應取得該檔完整來源進一步核對；不能用 `@ts-ignore`、把它排除出 jsconfig 或刪除 lint 解決。

## 部署與保存邊界

本次日誌在 `verifyReleaseChecks` 的 lint 階段已停止，尚未進入本次正式發布；本版可用新提交重跑。若帳戶內**另有**已達 WAIT 的未完成批次，仍須用其原提交和原密碼恢復，不能混換批次。

原 D1＋KV 備份、保護、來源核對及手動接續流程保持：第一次 `ST_UPGRADE_WAIT` 後，依 `readyAfter` 重试同一提交；到 `ST_UPGRADE_COMPLETE` 且 `/api/upgrade/status` 為 `version: 3.3.25`、`maintenance: false` 才完成。

本次不宣稱已完成正式 Cloudflare 發布，也不表示 Cloudflare Pages 已成為受支援的正式升級入口。只是讓額外 Pages 相容檔不再因這個已知的型別缺欄阻斷 Workers 專案。

詳細驗證及未完成項目見 `VERIFICATION_3.3.25.md`。原長流程操作保留於 `SAFE_UPGRADE_3.3.24.md`；本版來源版本使用3.3.25。
