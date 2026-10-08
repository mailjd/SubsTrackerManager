# v3.3.22 CloudflareSplitDeployFix

新增Workers Builds可恢復分階段部署：`npm run deploy:cloudflare`。首次備份／維護發布，16分鐘等待放在兩次Build之間；同提交重試後補遷移／驗收／解鎖。跨Build加密恢復、原D1追加式協調鎖、同來源核對；raw guard仍拒絕繞過。GitHub Safe upgrade改為手動，完整長流程保留。

必讀：`CLOUDFLARE_SPLIT_DEPLOY_3.3.22.md`，本次205項回歸＋7組舊版情境的結果與限制見 `VERIFICATION_3.3.22.md`。需要改控制台Deploy command，不是只換ZIP就能改原設定。
