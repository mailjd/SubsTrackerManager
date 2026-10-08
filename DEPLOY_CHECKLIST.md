# v3.3.26部署檢查

1. 已閱讀`DEPLOY_REPAIR_3.3.26.md`；完整解壓更新原專案，package及lock配套，含scripts/tests/.github。
2. 原Worker的Deploy command已保存為`npm run deploy:cloudflare`；不是改Build或Preview欄。下一次日誌必須顯示該命令。
3. Build command可保留`npm run build`或留空。npm ci包含devDependencies；Node22.13+/npm10+/Python3.11+。
4. 原名稱、路由、KV/D1綁定與執行時密鑰均保留；不新增R2、不建立替代儲存。
5. Builds中的原帳戶Token/Account ID、備份密碼（至少16字元）、Worker名稱等已配置；Token具原D1/KV/Worker必要權限。
6. 所有必需檢查通過才備份／發布，不能以缺包、型別或bundle失敗為由跳過測試。
7. 無其他未完成舊批次／並行發布者。舊WAIT批次先用其原提交恢復。
8. WAIT後依readyAfter手動Retry同一提交；COMPLETE且版本3.3.26/maintenance:false才完成。
9. 核對原資料／帳號／模板／歷史及保存診斷，另存加密備份與驗收報告，密碼單獨保存。

本包不代表已替你修改控制台或正式發布。詳細證據與限制見`VERIFICATION_3.3.26.md`。

本版新增 test:runtime（Python 標準庫 + Node SQLite 實際能力）；不再要求 Python 的 sqlite3/_sqlite3。相關測試仍完整執行，詳見 DEPLOY_REPAIR_3.3.26.md。
