# v3.3.23 部署檢查

1. 已閱讀 `D1_KV_ONLY_3.3.23.md`；本工具不使用R2，不需要開通bucket或新增R2金鑰。
2. 原Worker準確名稱、Account ID、KV／D1 ID均保留，不以範例替換。
3. 原版未完成的升級先用同版原提交及恢復憑證處理，不混用來源。
4. Cloudflare Build command留空，Deploy command為`npm run deploy:cloudflare`。
5. Builds配置原Token、Account ID、至少16字元備份密碼、Worker名稱／必要的源網址。Token需涵蓋原Worker、KV、D1，不需要R2。
6. 不同發布器不要並行運作；保留完整測試、加密備份、維護與驗收門禁。
7. WAIT不是完成；依readyAfter重試同一提交，到COMPLETE且3.3.23/maintenance:false才完成。
8. 下載加密備份另存本機；核對原記錄、歷史、帳號、模板和保存診斷。

完整操作與停止情況見 `CLOUDFLARE_SPLIT_DEPLOY_3.3.23.md`。不宣稱未驗證正式環境一定一次成功。
