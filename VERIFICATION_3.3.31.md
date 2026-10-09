# SubsTracker v3.3.31 實測報告

驗證日期：2026-10-09（UTC）。以使用者提供完整 v3.3.29 與其後完整 v3.3.30 為基準。

## 結論與邊界

原碼修改及下列本地驗證已完成。預設 deploy:cloudflare 現在使用單次直接升級，不再因為 KV-only 而要求新增 D1 或切換 GitHub Actions。新的 direct-compatible 運行門禁隨同發布，不是僅刪除 D1 檢查。

**沒有登入使用者 Cloudflare，沒有執行真實線上發布。完整鎖定依賴無法在本環境安装，故尚未驗證真正 Wrangler 3.114.17 編譯、完整指定版本型別檢查、原生 Workers/Vitest 測試或使用者線上站點。下列模擬測試不可等同線上成功。**

## 已執行

| 項目 | 通過數 | 實際方法與限制 |
|---|---:|---|
| 最終 Node 回歸 | 311/311；0失敗、0跳過 | 部署、升級、儲存、運行相容、AST上下文、表格契約；包含原275項與新增36項直接流程測試 |
| 直接升級專項（上述311內的子集） | 36/36 | 真正原部署入口、備份加解密、guard、運行門禁；Cloudflare傳輸與Wrangler發布器使用隔離模擬 |
| 來源語法檢查 | 116/116 | node --check；src/scripts與內嵌腳本；不是型別檢查或bundle |
| 業務流程回歸 | 69/69 | 生產業務模組＋本機檔案KV/SQLite適配器；非Cloudflare運行時 |
| 表格API回歸 | 37/37 | 生產API處理模組＋本機檔案KV/SQLite適配器；非Hono/workerd整站測試 |
| 鎖定依賴內容比對 | 通過 | package-lock.json僅變更根版本；所有依賴版本、integrity及依賴樹保持v3.3.30原值 |
| 業務原碼逐位元組比對 | 通過 | src僅新增direct-runtime、修改upgrade-gate兩處入口及兩個版本識別檔；其餘原src檔案完全相同 |

新專項覆蓋：KV-only、KV+D1、下一次直接重試、原密鑰/記錄不變、加密備份讀回、備份下載、錯誤密碼、缺schema/原密鑰、錯KV、綁定漂移、發布測試失敗、上傳回覆丟失不假報成功、偽造環境變數不放行、修改guard配置/源碼/密文/帳戶被拒、舊版狀態端點相容、灰度版本不誤選、既有維護批次被保留、遠端備份損壞不發布。

原20項AST/上下文相容測試在本機使用可用的TypeScript 5.8.3作診斷，不代表鎖定的5.9.3完整tsc通過。指定依賴及正式發布檢查清單沒有被改成舊版，也沒有加入跳過檢查的環境變數。

另新增 tests/data/direct-runtime.test.js 的4項原生Workers測試，直接import真正direct-runtime而不是舊門禁mock；本環境未執行這4項，它們不計入上述311或36。

## 命令

```sh
node --test tests/deploy/*.test.mjs tests/upgrade/*.test.mjs tests/storage/*.test.mjs tests/runtime/*.test.mjs tests/compat/*.test.mjs tests/regression/contract.node.mjs
node --test tests/deploy/direct-*.test.mjs
node scripts/check-syntax.mjs
node scripts/run-python-test.mjs tests/regression/workflow3319.py . <isolated-results-directory>
node scripts/run-python-test.mjs tests/regression/api-regression.py . <isolated-results-directory>
node --check tests/data/direct-runtime.test.js
```

本機使用Node 22.16.0。完整TAP與機器可讀結果位於verification/3.3.31/。

## 尚未完成的真實執行

registry.npmjs.org在本環境無法連線；本地npm cache也缺少鎖定套件。npm ci --offline失敗為ENOTCACHED（zod 3.25.76）；實際toolchain檢查顯示hono 4.12.22未安裝。原錯誤記錄隨包附上。沒有把假的hono或Wrangler放入node_modules來湊通過結果。

因此真正npm run build、指定版本完整tsc、原生npm test、Wrangler dry-run、遠端Token權限及真實發布不列為已通過。使用者提供日誌中的v3.3.30 dry-run成功，只能證明該次舊版建置，不能當成本版編譯證明。使用者遠端repository還有額外歷史檔案，本地沒有其完整快照；未聲稱對這些額外檔案逐項回歸。

本版正式命令仍執行原RELEASE_CHECKS：test:runtime、test:toolchain、lint、test、test:context、test:syntax、test:bundle、test:storage、test:deploy、test:upgrade、test:table-contract、test:workflow。真實環境中任一項失敗仍停止，不會悄悄用模擬結果代替。

## 資料與並行限制

本版預設做相容v3結構的程式發布，不執行舊兩階段歷史批量回填，不偽造遷移完成標記，不建立D1/KV、不改綁、不清庫。發布前僅讀取原資料；持久寫入是原KV的專用加密備份key。原應用的按需初始化、補齊及正常業務/Cron讀寫不被移除。

原站持續運作，因此備份是live-non-transactional線上快照，而不是停寫後的全域一致快照。檢查現行版本與綁定可發現已發生的並行變動，但不是原子發布鎖；同一Worker不要並行啟動其他發布器。舊遷移正在進行、不相容schema、缺原密鑰或過早D1結構，仍會明確停止，避免假修復。

## 封包驗證

交付前檢查：完整ZIP與修補ZIP的CRC完整性、FILE_MANIFEST_3.3.31.json逐檔SHA-256、原v3.3.29加修補及原v3.3.30加修補分別還原成同一完整交付樹。修補不含wrangler.toml；三個乾淨完整版的該檔相同。封包結果另提供SubsTracker_v3.3.31_PACKAGE_VERIFICATION.json，不把封包檢查冒充線上部署。

本版詳見DEPLOY_REPAIR_3.3.31.md；歷史版本文件與舊分段測試保留，不是預設流程。
