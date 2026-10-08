# Safe upgrade 3.3.27

先閱讀 `DEPLOY_REPAIR_3.3.27.md`。本次修正 Workers KV 讀取參數相容、SuperAdmin 契約與建立後分類同步；仍沿用3.3.26的Python→Node SQLite能力檢查及3.3.25的舊適配props修補。

正式備份格式、原KV/D1綁定、密碼派生、16分鐘維護等待、原始值核對及解鎖邏輯未改。Cloudflare分階段需要手動接續同一提交，沒有自動安排下一個Build。

長流程見 `SAFE_UPGRADE_3.3.24.md`；分階段見 `CLOUDFLARE_SPLIT_DEPLOY_3.3.24.md`；D1/KV限制見 `D1_KV_ONLY_3.3.24.md`。本次最終版本應為3.3.27。

已在維護而未完成的舊批次不得直接更換提交／版本／備份密碼；先沿用原批次完成或按同版指南恢復。本次使用者日誌在發布前測試失敗，不顯示已進入正式備份／發布。

驗證範圍与未完成的完整Workers測試見 `VERIFICATION_3.3.27.md`。不能以本機模擬通過代替正式當次資料驗收。
