# v3.3.28｜根因與驗證範圍

**Cloudflare 日誌證據**：v3.3.27 的 `test:runtime`、lint、Workers Bundling 與前置契約正常；Workers Vitest 最終 `Test Files 1 failed | 26 passed (27)`；`Tests 1 failed | 258 passed (259)`。唯一失敗是 `tests/core/superadmin.test.js` 的 `runtime.configured` 期望 `true`、實際 `undefined`。尚未開始遠端資料升級。

**已執行本機**：Node 22.16.0；新 Workers-compatible contract 的 Node 內建測試 5/5 通過；整體 `tests/runtime/*.test.mjs` 58/58 通過；保留 `verifyRuntimeSuperAdminCredentials` 驗證邏輯。可列舉的 `username,password` 屬性和 JSON 格式維持完全一致、無憑證時返回 `null`。

**限制**：提供的完整 v3.3.27 ZIP 中不包含倉庫保留的舊 `tests/core/superadmin.test.js`，因此針對其已出現的斷言重建本機回歸，未聲稱直接執行該測試檔。此環境不具完整鎖定 npm 安裝包，尚未完成完整 Workers Vitest／完整 TypeScript／真實 Cloudflare 發布。Cloudflare v3.3.28 Build 必須執行它們且通過才可放行。

**安全邊界**：無業務儲存結構、資料遷移、D1／KV 命名、加密策略、備份驗收、16 分鐘等待、部署入口變更；沒有使用 R2。未接觸正式帳戶。
