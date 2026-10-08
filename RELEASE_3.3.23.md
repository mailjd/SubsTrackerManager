# v3.3.23｜D1KVOnly

- 查核3.3.22：無專案R2綁定／SDK；存在D1 export signed URL下載鏈路。
- D1備份改為query-only的分頁邏輯SQL，保留加密、還原驗證和完整性門禁。
- 普通資料使用rowid游標，大欄位使用有界分片；缺頁／缺片／結構或計數變動停止。
- 新增本機／線上／生成配置D1＋KV策略，REST白名單拒絕R2和D1 import/export作業。
- 新增必需的test:storage；原業務程式、加密與資料鍵名未更動。
- 版本3.3.23，表格保存協議2。部署命令及跨Build等待流程不變。

實際測試與限制：`VERIFICATION_3.3.23.md`。使用方式：`D1_KV_ONLY_3.3.23.md`。
