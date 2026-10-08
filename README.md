# SubsTracker v3.3.23｜D1＋KV 限定版

本版基於 v3.3.22。應用資料、Cloudflare分階段備份與恢復只使用既有D1＋KV，沒有R2綁定、R2金鑰或R2 SDK。不要求開通R2。

舊版無專案R2 bucket，但D1全量备份仍經`export`與`signed_url`下載。本版改為D1 `query`分頁生成SQL，並增加儲存白名單與拒絕額外物件儲存的檢查。業務相關67個檔案維持原值。

**先讀 `D1_KV_ONLY_3.3.23.md`，測試明細見 `VERIFICATION_3.3.23.md`。**

## Cloudflare部署

Build command留空；Deploy command仍為：

```sh
npm run deploy:cloudflare
```

沿用原Worker、KV、D1和Builds機密，不新建資料庫，不刪除build guard。第一次WAIT後依readyAfter重試同一提交，直到COMPLETE並maintenance:false。若舊版批次仍在維護，先處理原批次，不能混用新程式。

詳細步驟：`CLOUDFLARE_SPLIT_DEPLOY_3.3.23.md`。可選長流程：`SAFE_UPGRADE_3.3.23.md`。

## 本機檢查

```sh
npm ci
npm run test:storage
npm run test:syntax
npm run test:deploy
npm run test:upgrade
npm run test:table-contract
npm run test:workflow
npm run lint
npm test
```

`test:storage`使用Node＋Python合成D1測試，無需R2。正式發布仍要求完整測試，不提供跳過備份/測試開關。本機全部已執行與未完成項目以驗證報告為準；舊的`tests/results/3.3.xx`是歷史證據，不算本次測試。

備份下載：`npm run upgrade:download`。備份密碼另存，完整加密附件另存本機；存於原KV不能代替獨立災難備份。
