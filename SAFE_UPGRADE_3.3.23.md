> v3.3.23 補充：儲存與備份限定 D1＋KV；D1 備份改用 query，不使用 export/signed URL。不需開通 R2。先讀 `D1_KV_ONLY_3.3.23.md` 的現況、操作與支援邊界。

# v3.3.23 安全升級操作指南

> 本文件是 **GitHub／本機長流程** 的操作與恢復指南。Cloudflare Git 直連可保留，改用 `CLOUDFLARE_SPLIT_DEPLOY_3.3.23.md` 的兩階段入口；不必為此斷開Git。兩條路線不可並行。

## 1. 適用範圍與保護原則

本包適用於已運行 v3.3.18／v3.3.19、`schema_version=v3` 的既有安裝。支持 KV-only 以及 KV＋現代 D1 結構。遇到更早的帳號主鍵結構、缺失核心表／加密密鑰、无法判定新舊的衝突記錄，預檢會停止；不自行清表或生成替代密鑰。

「無損」在本包中的驗收含義：升級維護期備份中仍有效的原始 KV key（包含原值、metadata 和到期設定）、D1 應用表既有欄位和每一筆原始列均保留；必要新欄位、遷移進度與缺失歷史只做增補。已有密文、會員／支付記錄、模板、設定的原儲存值不被覆蓋。正常到期自刪的 KV 暫存不是永久業務記錄。

已在舊版本刪除、截斷的歷次支付或從未保存的資料不能重建。頁面中尚未保存的編輯也不是伺服器記錄，升級前應保存或另外備份。瀏覽器本機 Layout／暫存不屬於雲端完整儲存備份；沿用同一網址和瀏覽器可維持既有本機設定。

## 2. GitHub 升級前只需準備的項目

在**原來的 GitHub 儲存庫**操作，不要建立一套新 Cloudflare 儲存。

Secrets：保留 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`；新增 `SUBSTRACKER_BACKUP_PASSWORD`，至少 16 字元，建議獨立隨機 32 字元以上。密碼不得寫入程式、Commit 或貼到聊天；應離線保密備份，遺失後無法解密 `.stbackup`。

原 API Token 需能讀取既有 Worker 設定／排程／內容、KV 全量資料、D1 SQL 匯出，以及發布既有 Worker。權限不足會停止，不會換資料庫繞過。

Repository Variables（按現有安裝需要設置）：

| 名稱 | 用途 |
|---|---|
| `SUBSTRACKER_WORKER_NAME` | **原有 Worker 的準確名稱**。不填時用原 `wrangler.toml` 所選環境的 `name`；不要把預設範例名稱當成你的實際名稱。 |
| `SUBSTRACKER_WORKER_URL` | 原網站 HTTPS 源網址，不含路徑／查詢。使用自訂域名或未開 workers.dev 時必填。 |
| `SUBSTRACKER_ENVIRONMENT` | 原本 Wrangler 環境名稱，例如 production；沒有分環境則留空。 |

將本包程式與 `.github/workflows/deploy.yml` 更新到原專案。保留原 `wrangler.toml` 中正確的 Worker 名稱、Account ID 與既有 KV／D1 綁定；合入以下保護段落（本包模板已包含）：

```toml
[build]
command = "node scripts/require-safe-upgrade.mjs"
```

升級程式會比對線上原有綁定 ID，另外產生本機暫存 `wrangler.upgrade.json`；不會依預設資料庫名稱重新建立或改綁儲存。既有 Worker 的 Variables／Secret 名稱保留，不設定新的管理員密碼。與本次需求無關或無法識別的額外綁定，會要求人工核對後再升級。

**同時停用任何會另外發布的舊 GitHub Workflow／Cloudflare Git 直連部署。** 只能由本包的 Safe upgrade 工作流負責這一次發布，避免兩套發布器互相覆蓋。

## 3. GitHub 手動啟動的完整流程

在原 repo 的 Actions 手動執行 **Safe upgrade**。本版移除 Push 自動發布，避免與 Cloudflare Git 直連相互覆蓋：

1. 安裝依賴，完成語法、型別與測試；失敗時尚未發布。
2. 只讀掃描原 Worker 與原儲存，完整 KV／D1 讀取两次一致後，加密備份並在隔離 SQLite 還原驗證。
3. **成功上傳升級前加密備份 Artifact 才部署**。發布帶有本次專用校驗碼的維護版本。
4. 維護期間普通 API 和排程停用。保守等待 **16 分鐘**讓舊請求／排程結束，再建立第二份維護期全量備份；備份 Artifact 上傳成功才開始遷移。
5. 合併校對 KV／D1，分批增補缺失歷史。每批最多 8 條，必須持續減少待處理量；無進展立即停止，不無限重試。
6. 再完整读取實際儲存，每一個原 key／每一筆原始 SQL 列逐項核對，建立遷移後加密備份並重新還原驗證。
7. 本次 runId、來源摘要、備份摘要與伺服器報告均一致，才解除維護模式，產生 `*-acceptance.json`。

這是停寫維護式升級，不是零停機發布。整體時間在 16 分鐘等待之外，還包含安裝／全量備份／測試，資料多時更久。網站顯示維護是保護流程，不是表格載入故障。工作流總時限目前 90 分鐘；超時可持加密狀態續跑。

在升級期間停用所有外部直寫 D1／KV 的脚本或其他 Worker。應用維護門禁不能鎖住具有你帳戶憑證的外部寫入者；兩次掃描／最終比對偵測到不一致就會停止。

## 4. 完成後如何確認

Actions 的準備、維護備份和最終驗收均成功；下載 `upgrade-result-or-recovery-...` Artifact，檢查 `*-acceptance.json` 的 `ready`、`bindingsPreserved`、`originalsVerified`、`restoreVerified` 均為 true。網路中斷後恢復的完成凭證格式含 `serverVerification`／`localVerification`，應同樣顯示本次 runId 和已通過的原資料／還原檢查。

`/api/upgrade/status` 应返回版本 3.3.23、`maintenance:false`、本次 runId。再開啟訂閱頁面，保存診斷前後端都應為 3.3.23／協議 2。檢查當前訂閱、歷史、Database 密碼狀態與原自訂模板。

非「开会员」的舊記錄改在訂閱歷史呈現；缺失的歷史補回後筆數可能增加。驗收核對的是原始 ID／內容，不是要求每個頁面的筆數都完全相同。

將加密備份、manifest、驗收報告另外下載保存。CI Artifact 設置 90 天保留，不能把短期下載保留當作永久備份。

## 5. 本機執行同一流程

需求：Node 22.13+、Python 3.11+、可安裝專案依賴和訪問原 Cloudflare。以下為 shell 範例；憑證只放環境變數，不寫入檔案：

```sh
npm ci
# 先用你使用的安全方式設置這些環境變數：
# CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / SUBSTRACKER_BACKUP_PASSWORD
# 必要時另設 SUBSTRACKER_WORKER_NAME / SUBSTRACKER_WORKER_URL / SUBSTRACKER_ENVIRONMENT
npm run deploy:check
npm run lint
npm run test:syntax
npm run test:storage
npm run test:deploy
npm run test:upgrade
npm run test:table-contract
npm run test:workflow
npm test
npm run deploy:safe
```

也可分段執行：

```sh
npm run upgrade:prepare
# 先將 upgrade-backups/ 內的升級前加密備份複製到安全位置
npm run upgrade:stage
# 再將維護期加密備份保存到安全位置
npm run upgrade:finish
```

本機 `deploy:safe` 會建立並驗證備份，但無 GitHub Artifact 外存服務；操作者應另外保存 `upgrade-backups/`。本版 `npm run setup` 等同 prepare，不新建 KV／D1。

## 6. 中斷、冲突與恢復

預檢失敗：原站未被新版本替換，既有資料不改；依錯誤原因核對綁定／備份權限／來源衝突。

維護後失敗：**不要清空資料庫、不要刪除門禁標記、不要套用舊 JSON 覆蓋正式資料。** 原始資料驗收尚未通過時不會強行開站。下載工作流的恢復 Artifact，其中含備份和加密 resume 狀態。

在同版來源目錄、同一帳戶憑證和原備份密碼的環境中，將該次 Artifact 的 `.stbackup`／manifest 保持原檔名放到 `upgrade-backups/`，執行：

```sh
npm run upgrade:resume -- upgrade-backups/本次runId-resume.stbackup
```

恢復會重新核對實際儲存 ID、備份校驗碼和伺服器 runId。若已成功寫入但回應遺失，讀取伺服器已完成報告，不重複累計；若僅部分批次完成，只補仍缺少的項目。遷移開始後禁止用 stage 重建該次基線。

如來源資料自身矛盾，應在副本中核對并解決衝突後，再準備新的受保護升級批次；系統不自行決定哪一份帳務應刪除。此包沒有自動清庫／遠端覆蓋式還原按鈕。

## 7. 加密備份的內容與還原核驗

`.stbackup` 使用 AES-256-GCM 和隨機 salt／IV，密鑰由獨立備份密碼經 scrypt 派生。包含完整 KV 原始 bytes（base64）、metadata／expiration、D1 SQL、原 Wrangler 和線上 Worker 配置。升級前包另存原 Worker 回傳的程式內容供恢復參考；它不是自動回滚部署指令。

原 KV 的 config 裡既有加密密鑰、登入資料和 Database 帳號密文都在完整加密包中。**Worker Secrets 值不能由本流程讀取匯出**；流程維持同一個 Worker 和 Secret 名稱，不重設它們。若要跨帳戶／重建 Worker，仍須你自行保管原 Secrets，這不是本次安全原地升級的範圍。

普通網頁「JSON 備份」是版本 7 的應用資料備份，有內容校驗碼，默认不含帳號密碼；它不能代替 `.stbackup`。

離線重新驗證一份儲存備份：

```sh
npm run backup:verify -- upgrade-backups/本次runId-maintenance.stbackup
```

解密到一個**不存在的新本機目錄**（不訪問或改寫 Cloudflare）：

```sh
npm run backup:verify -- upgrade-backups/本次runId-maintenance.stbackup ./offline-restore-copy
```

輸出 `kv-full.json`、`d1-full.sql`、`original-wrangler.toml`。目錄可能包含管理員敏感配置和加密密鑰，应離線保密，不提交 Git／不公開分享。重複目錄會拒絕覆蓋。SQL 還原驗證在隔離記憶體資料庫執行，不接觸正式儲存。

## 8. 已知邊界

本版驗證見 VERIFICATION_3.3.23.md。未使用你的正式環境做測試；最終相容性由你原帳戶內的保護流程驗收。平台配額、網路、API 權限或資料規模可能造成停止，這時保留備份／原資料而非越過檢查。輸出不是對任何來源损壞或平台故障的百分之百保證。
