# v3.3.28：SuperAdmin 最後一項 Workers 契約修正

來源：2026-10-08 11:42–11:43 Cloudflare v3.3.27 日誌，259 項 Workers 測試中 258 通過、1 項失敗。失敗點 `tests/core/superadmin.test.js:11`：`expect(runtime.configured).toBe(true)`，收到 `undefined`。尚未進入遠端備份或發布。

## 修改

- `src/core/superadmin.js` 的 `getRuntimeSuperAdminCredentials(env)` 完成憑證存在檢查後，向有效憑證物件提供唯讀的 `configured: true`。使用不可列舉屬性，避免變更舊版 `{username,password}` 的列舉屬性、JSON 快照與既有 `toEqual` 契約。
- 憑證不完整仍返回 `null`，驗證仍要求使用者名稱與密碼都正確；保持密碼空白字元有意義，不新增預設值或繞過登入。
- 新增 `tests/runtime/superadmin-configured-compat.test.mjs`，並保留原有 Workers 測試。發布入口仍執行完整 `npm test`，不跳過異常。

## 升級

1. **建議套用差異包**到現有 v3.3.27 Git 倉庫根目錄；僅覆蓋包含檔案，其餘檔案保留，包括倉庫原有的 `tests/core/superadmin.test.js` 和 `src/pages-handler.js`。
2. 提交新的 Git commit，Cloudflare 會自動觸發 Build。控制台原設定不變：Build command `npm run build`；Deploy command `npm run deploy:cloudflare`。
3. 應看到 `subscription-manager@3.3.28`，`npm test` 的 Workers 測試全部通過。此時才進入安全備份及分階段部署。
4. 後續出現 `ST_UPGRADE_WAIT`，按該次 `readyAfter` 重試**同一提交**；最終驗收需 `ST_UPGRADE_COMPLETE` 且 `/api/upgrade/status` 顯示 `version: 3.3.28`、`maintenance: false`。

**注意**：本次只取得日誌，不是遠端 Git 倉庫的所有源碼。倉庫額外檔案不得覆蓋/刪除。已修正可辨識失敗項，但無法在本工作環境執行完整官方 Workers Vitest；正式建置仍可能揭示其他問題。原 Worker、KV、D1、Secret、R2 限制、加密備份與驗收流程均保留。
