# v3.3.24 Cloudflare分階段部署

請以 `DEPLOY_REPAIR_3.3.24.md` 的最新步驟為準。

Deploy command必須是 `npm run deploy:cloudflare`；Build command可保留 `npm run build`（本版是真實離線檢查）或留空。WAIT後依readyAfter手動Retry同一提交；COMPLETE及maintenance:false才完成。保留原D1＋KV，不需R2，不混用未完成批次。
