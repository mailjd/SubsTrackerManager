# Cloudflare 部署錯誤修正｜v3.3.21

對應 2026-10-08 截圖：`node scripts/require-safe-upgrade.mjs` 返回 exit code 1。

## 結論：更換發布入口，不能只重試同一個 Cloudflare Build

這不是這份日誌顯示的 JavaScript 語法錯誤或資料庫故障。v3.3.20 的 Wrangler 自訂 build 檢查在沒有本次加密備份及原綁定驗證時主動拒絕部署。

Cloudflare Git 直連通常執行 `npx wrangler deploy`，**不會自動執行儲存庫的 GitHub Actions 工作流**。v3.3.21 仍然拒絕未經安全流程的 raw deploy，並非刪除保護來讓 Build 顯示綠色。

**只換上本包、再按 Cloudflare Retry，仍然不是正確部署方式。** 完整安全升級改由 GitHub Actions 執行，網站依然運行在原 Cloudflare Worker，不搬家、不建立替代 KV／D1。

## A. 在 Cloudflare 斷開舊發布入口（一次性）

Cloudflare Dashboard → Workers & Pages → 選擇**現有原 Worker** → Settings → Builds → **Disconnect**。

這裡選的是 Git 連線的 Disconnect；**不是 Delete Worker，不是刪除 KV／D1，也不是移除儲存綁定**。不要再對這次失敗的 Build 反覆按 Retry。若另有舊發布 Workflow／其他自動發布器，也應停用，避免兩邊同時發布。

目前 Workers Builds 每次總時限為 20 分鐘。本工具維護停寫等待本身為 16 分鐘，加上安裝、備份、恢復校驗和遷移，不適合塞進一次 Workers Build。不要把 Deploy command 簡單改成 `npm run deploy:safe`；更不要縮短等待或放行未備份部署。

## B. 在原 GitHub 儲存庫準備設定

Settings → Secrets and variables → Actions。

### Repository secrets

| 名稱 | 內容 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 有權讀取及部署**原 Worker**、讀取原 KV、匯出原 D1 的 Token。不要提供 Global API Key，不要貼到聊天。 |
| `CLOUDFLARE_ACCOUNT_ID` | 原 Cloudflare 帳戶的 32 位 Account ID；不是 Zone ID 或 D1 ID。 |
| `SUBSTRACKER_BACKUP_PASSWORD` | 至少 16 字元的獨立加密備份密碼，建議隨機 32 字元以上。離線保密保存，不改成管理員登入密碼。 |

已存在且正確的項目不必重建。設定在 Cloudflare 的 Secrets 不會自動出現在 GitHub Actions；需在此處配置。缺少 D1／KV／Worker 權限的 Token 會在預檢或備份時被拒絕，而不是改綁新資料庫繞過。

### Repository variables

| 名稱 | 內容 |
|---|---|
| `SUBSTRACKER_WORKER_NAME` | 填**原 Worker 的準確名稱**。不是任意新名稱。未設時使用原 `wrangler.toml` 的名稱；本包範例 `subscription-manager` 不代表你的實際名稱。 |
| `SUBSTRACKER_WORKER_URL` | 自訂網域／關閉 workers.dev 時填原 HTTPS 網站源地址，不含 `/admin`、查詢參數或登入資訊。一般 workers.dev 可由工具讀取原設定推導。 |
| `SUBSTRACKER_ENVIRONMENT` | 原專案使用 Wrangler 命名環境時才填，例如 production；沒有則保持空白。 |

## C. 更新專案並執行正確 Workflow

將 ZIP **解壓後的專案內容**更新到原儲存庫根目錄；不是只把 ZIP 上傳到儲存庫。必須包含隱藏目錄 `.github/workflows/`、`scripts/`、`src/`、`public/`、`package.json`、`package-lock.json`、Wrangler 設定及測試檔。

保留原 `wrangler.toml` 中正確的 name、account_id、KV／D1 ID 和路由等專屬設定，合入本包 `[build]` 保護設定。升級器會再次對照正在運行的 Worker 原綁定；不一致就停止，不按預設名稱建立新儲存。

`.github/workflows/deploy.yml` 應存在於原儲存庫的預設分支。Push 到 main／master 會觸發 **Safe upgrade**；也可到 GitHub **Actions → Safe upgrade → Run workflow**，選擇已更新的分支後執行。已有一次工作流正在跑時，不要再手動啟動第二次。

注意 **Test** 工作流只做測試，不是部署。要檢查的是 **Safe upgrade** 的執行結果。

## D. 正確流程與完成標誌

```text
Deployment entry and configuration preflight（只檢查本機設定）
    ↓
安裝依賴、型別／語法／回歸測試
    ↓
原 Worker 綁定與完整加密備份核對
    ↓
升級前備份 Artifact 上傳成功
    ↓
發布維護版本 → 等待舊任務結束 → 維護期備份
    ↓
維護期備份 Artifact 上傳成功
    ↓
分批增補歷史 → 原始記錄逐項驗收 → 解鎖
```

看到 `構建保護檢查通過` 只代表進入發布維護版本階段，**還不是升級完成**。以最後驗收步驟成功、`/api/upgrade/status` 的 `version: "3.3.21"` 與 `maintenance: false` 為準，並保留加密備份、恢復憑證和 acceptance 報告。

工作流允許最長 90 分鐘；16 分鐘維護等待未被刪掉或縮短。資料量、網路或權限問題仍可能讓升級停止。網站若已在維護模式，不要清除門禁或強行解鎖；下載該次恢復附件並依 `SAFE_UPGRADE_3.3.21.md` 處理。

若先前 v3.3.20 的 Safe upgrade **已進入維護但尚未完成**，先用 v3.3.20 同版來源及該次加密恢復憑證續跑；不要直接用 3.3.21 冒充舊 runId。本次截圖只顯示 build 被拒絕，無法判定帳戶內其他發布是否曾進入維護。

## E. 本機替代入口

需要 Node 22.13+、Python 3.11+、專案依賴及原帳戶必要權限。在本機或長時限的 CI（不是 Workers Builds）設定上述環境變數後：

```sh
npm run deploy:check
npm ci
npm run lint
npm run test:syntax
npm run test:deploy
npm run test:upgrade
npm run test:table-contract
npm run test:workflow
npm test
npm run deploy:safe
```

`deploy:check` 是無網路的設定預檢，成功不代表 Token 已經通過線上權限驗證。`upgrade:prepare` 才讀取原資源並做完整備份。既有完整升級／恢复指南在 `SAFE_UPGRADE_3.3.21.md`。

## F. 本版改動邊界

新增明確的部署入口判斷、設定預檢、錯誤代碼及工作流提示；錯誤入口會在任何遠端操作前停止。未備妥就不載入 SQLite 還原模組，避免它的實驗性警告干擾判讀。合法 Safe upgrade 仍需真實加密備份、本次狀態、原資源 ID 和校验碼。

Vitest 改用獨立本機設定 `wrangler.test.toml`，不讀取正式儲存綁定或正式發布 build；正式 guard 另外由部署／安全升級回歸實測。此測試設定不能用於部署。

訂閱資料模型、SQL migrations、歷史分流、帳號庫、模板儲存鍵、密碼／密鑰、備份加密算法和逐項驗收邏輯沒有改動。版本標記更新為 3.3.21。

## 官方文件（核對於 2026-10-08）

- Cloudflare Workers Builds 設定與預設部署命令：https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
- Cloudflare Workers Builds 時限：https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/
- Cloudflare Disconnect Git builds 操作：https://developers.cloudflare.com/workers/ci-cd/builds/#disconnecting-builds
- Cloudflare GitHub Actions：https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/
- GitHub Run workflow：https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow

本文件描述操作路徑及本機驗證，不代表已替你登入、設定或發布正式 Cloudflare／GitHub。
