# SubsTracker v3.3.26｜SQLite 測試執行環境修正

最新操作：[DEPLOY_REPAIR_3.3.26.md](DEPLOY_REPAIR_3.3.26.md)。修正 Cloudflare Python 缺少 `_sqlite3` 導致工作流測試無法啟動的問題；使用現有 Node 內建 SQLite 作真實磁碟核對，不跳過測試，不新增 R2 或其他儲存。

保留原 D1/KV、密碼、來源適配修補及兩階段安全部署。下方為歷史說明；本版具體驗證以 [VERIFICATION_3.3.26.md](VERIFICATION_3.3.26.md) 為準。

---

# SubsTracker v3.3.25｜ExecutionContext 相容修補

最新更新及操作：**[DEPLOY_REPAIR_3.3.25.md](DEPLOY_REPAIR_3.3.25.md)**。針對額外 `src/pages-handler.js` 缺 `props` 的 TS2345；保留 D1＋KV、原綁定與全部安全檢查。先依新版說明更新完整檔案，控制台命令及備份密碼保持不變。下方保留原有使用手冊和歷史說明。

---

# SubsTracker v3.3.24｜部署預檢與依賴核對修正版

基於原v3.3.23，保留D1＋KV限定、原業務資料、備份、維護等待、恢復與驗收。沒有R2。

**必讀 `DEPLOY_REPAIR_3.3.24.md`；本次實測／未完成項目見 `VERIFICATION_3.3.24.md`。**

## 你提供日誌中的根因

`Executing user deploy command: npx wrangler deploy`：控制台仍是舊命令。必須改原Worker的 **Deploy command** 為 `npm run deploy:cloudflare` 並保存；ZIP不會修改這個控制台設定。不要刪除guard強行發布。

Build command可保留原 `npm run build`，本版已改成真實依賴、語法和Wrangler dry-run檢查；也可留空由Deploy入口完成檢查。不再只有echo就綠燈。

## 重要邊界

仍是Git自動啟動第一階段，WAIT後按readyAfter手動Retry同一提交；不是全自動接續。舊版已有未完成維護批次時，先用舊版原提交恢復，不要混用新版。沿用原KV／D1、Worker名與機密，不清庫、不新建替代資料庫。

## 本機診斷與驗證

```sh
npm run deploy:doctor       # 只讀本地lock/已安裝版本，不認證正式部署
npm ci --include=dev
npm run build               # 依賴 + 語法 + 真實dry-run；不發布
npm run deploy:check         # 本機設定預檢，不訪問原帳戶
npm run test:storage
npm run test:deploy
npm run test:upgrade
npm run test:table-contract
npm run test:workflow
npm run lint
npm test
```

發布固定使用專案根Wrangler3.114.17；間接測試套件Wrangler3.100.0的deprecated警告仍可能出現，不是此次ST_DEPLOY_COMMAND的成因。沒有在無法做完整驗證時強行切換Wrangler4；所有原lock套件版本保持。

測試證據在`tests/results/3.3.24/`，其他版本的results和報告屬於歷史。完整型別、Workers Vitest和真實bundle是否通過以本次報告為準，不把模擬工具回歸冒充正式Wrangler驗收。

部署完成後 `npm run upgrade:download` 另存加密備份，備份密碼另外保管。可選GitHub／本機長流程見 `SAFE_UPGRADE_3.3.24.md`；不要兩個發布器同時操作。
