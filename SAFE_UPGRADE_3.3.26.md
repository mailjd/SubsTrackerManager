# Safe upgrade 3.3.26

先閱讀 `DEPLOY_REPAIR_3.3.26.md`。本版修正部署測試對 Python `_sqlite3` 的依賴：Python 協調測試、Node 內建 SQLite 讀取實際本機測試資料庫，部署機仍需 Python 3.11+ 和原有 Node 22.13+ 能力。

沒有修改正式 D1/KV 備份、密碼派生、維護等待、資料原值核對及驗收／解鎖邏輯。`test:runtime` 是新增必須通過的檢查，不是跳過測試的開關。

沿用長流程：`SAFE_UPGRADE_3.3.24.md`；分階段流程：`CLOUDFLARE_SPLIT_DEPLOY_3.3.24.md`；D1/KV限制：`D1_KV_ONLY_3.3.24.md`。使用本版時，完成版本應為3.3.26。

只接續同一個批次的提交／版本／備份密碼，已進入維護而尚未完成的舊批次不能直接換新來源。Cloudflare Git 直連仍需在 readyAfter 後手動重試，沒有自動安排下一個 Build。

本次本機結果與未完成的檢查見 `VERIFICATION_3.3.26.md`；最終以正式帳戶本批次的資料驗收通過為準。
