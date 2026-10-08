# SubsTracker v3.3.27｜Workers 契約修正與部署核驗報告

日期：2026-10-08。基礎：實際 v3.3.26 SQLiteRuntimeFix ZIP。
原ZIP SHA-256：`837585c3425a4bc8853d357e75fa1d33a747cf758e6b09688a742af78fadd3c1`。
本次日誌：使用者上傳的「貼上的文字 (1)(2).txt」，共2726行。

## 1. 日誌已確認與未確認的事

日誌已通過部署入口、備份密碼格式、Python→Node SQLite能力、舊ExecutionContext修補、完整來源型別檢查、Wrangler離線bundle及69項本機workflow。最終是在真正的 `vitest run`／隔離workerd階段發生17項失敗、225項通過（L2716–2723）。本次因此沒有開始正式發布。

這不等於原D1損壞，也不能從這份日誌推斷帳戶中所有其他發布活動。測試輸出中的「生成密鑰／遷移0條」是隔離測試資料的日誌，不可當成正式資料被清空的證據。

## 2. 17項失敗的共同根因及修正

| 根因 | 日誌關聯 | 正式碼修正 |
|---|---|---|
| bulk KV的cacheTtl=30不被目前鎖定執行器接受 | L1623、L1684、L1939–1946等；14項列表、備份、調度、通知、續訂及生命周期失敗共用此讀取路徑 | `src/data/upgrade-reconcile.js`以集中常量60呼叫。保留bulk分組、舊單key fallback、缺項與權限錯誤拒絕。 |
| 舊SuperAdmin測試引用的兩個函式缺失 | L1539–1543、L2505–2525；2項TypeError | 恢復`getRuntimeSuperAdminCredentials(env)`／`verifyRuntimeSuperAdminCredentials(env,username,password)`；真正login亦支援獨立執行時身份。 |
| 新訂閱工作流只更新Database選單，沒有同步舊categories key | L2447–2451、L2474–2481；1項分類測試失敗 | 真正業務提交後追加舊分類；同operationId重試能補寫，不能新增重複歷史。 |

### 2.1 快取數值不是資料過期時間

依2026-10-08查閱的Cloudflare現行文件，KV cacheTtl最小值是30；但此專案鎖定的舊測試執行器明確回報至少60。不能說「所有Cloudflare API一律禁止30」。本次採用雙方都可接受的60，而不是盲目升級整套依賴。

60是讀取快取時長，**不是key的expirationTtl，也不是會員過期日期**。沒有新增TTL刪資料。KV仍是最終一致性；現有D1較新版本、保存回讀校驗及備份原始值比對保留，本修正不宣稱將KV變成強一致性。

### 2.2 SuperAdmin身份與舊介面

獨立身份僅讀Worker執行時`SUBSTRACKER_SUPERADMIN_USERNAME`與`SUBSTRACKER_SUPERADMIN_PASSWORD`，不從Build變數、KV管理員配置或預設字串取得替代身份。缺任一值，新的獨立身份驗證返回失敗。回傳配置為`{username,password}`或null；密碼不trim，不記錄值。

使用獨立username時，login必須同時符合它和第二密碼；普通admin登入仍可用且會清除舊提升權限cookie。從未配置獨立username的舊部署，原「管理員username＋第二密碼」流程保留；明確設成空username不會退回該流程。

使用者倉庫的`tests/core/superadmin.test.js`不在原發行ZIP內，沒有取得完整原文。本次按日誌可見名稱／參數補齊合理且安全的API契約，新增獨立測試檔，**沒有覆蓋、刪除或排除使用者原測試，也沒有聲稱執行過其未提供的完整檔案**。

### 2.3 分類同步不重新提交財務記錄

`prepareOnly`保留無副作用。業務記錄真正提交後才同步兼容分類；原Database選單繼續維護，不另建第二個Database。若附帶選單同步失敗，返回`metadataWarnings`；不把已提交財務操作報成完全失敗，避免人為重試造成重複支出。再次使用原operationId可補寫舊分類且不重複歷史，批量匯入也返回warnings。

## 3. 發現的後續測試語義衝突

`tests/services/scheduler-after-expiry.test.js`與`tests/services/scheduler-dedupe-day.test.js`兩個過期提醒fixture未指定訂閱模式，卻期待日期維持過期。原有循環訂閱功能即使autoRenew=false也推進周期（不建立付費歷史），所以單修TTL之後仍有可能報錯。

本次只在該兩筆過期fixture明確加入`subscriptionMode:'reset'`，原提醒／去重斷言不改；另新增reset與cycle對照，證明沒有把原循環功能刪掉。正式scheduler並未重寫。

## 4. 為何以前本機全綠仍漏出這些問題

原本的本機KV替身沒有驗證cacheTtl；部分替身將陣列key轉為字串，走了單key fallback，因此無法代表workerd真實參數校驗。這次提升本機替身的TTL／bulk契約，另加入實際原生KV suite；兩類測試明確分開。

`npm test`現在排到lint之後，先暴露真實Workers行為，再跑較慢的模擬升級。沒有刪除任何原必需檢查。新增：

- `npm run verify:release`：使用同一份必需清單，不發布、不遷移。全部通過才輸出`ST_RELEASE_CHECKS_OK`。
- `npm run diagnose:checkout`：只列出倉庫比發行包多出、修改或缺失的來源／測試檔與摘要。不刪除、不排除、不自動覆寫。

原生Vitest的include未改，未知舊測試仍參與。新`superadmin-runtime-compat.test.js`不取代使用者的`superadmin.test.js`。

## 5. 實際執行的驗證（不是線上部署）

同一組30項嚴格業務契約測試，先載入**原3.3.26來源**，得到7pass／23fail；再載入**修正來源**，30／30通過。原失敗為刻意重現，不計為修正版通過。記錄：`contract-before.tap`與`contract-after.tap`。這30項是Node正式模組＋嚴格KV替身／SQLite，**不是原來242項Workers suite**。

| 本次重跑組 | 通過數 | 執行邊界 |
|---|---:|---|
| runtime／嚴格契約／倉庫診斷 | 53 | 21個SQLite能力＋30新業務契約＋2診斷／順序；Node真實磁碟及合成資料。 |
| D1 query／KV限定儲存 | 36 | 正式snapshot、SQLite及隔離假REST。 |
| 部署入口／分階段接續 | 59 | 真正runner與guard；npm／Wrangler上傳／CloudflareREST明確採假工具或傳輸。 |
| 安全升級、備份與恢復 | 58 | 本機加密、KV／SQLite、受控REST，非正式帳戶。 |
| 舊ExecutionContext相容 | 20 | 實際編譯fixture；本機TypeScript **5.8.3**，不是鎖定5.9.3完整專案。 |
| 表格輸入／提醒契約 | 8 | Node正式模組。 |
| Database／當前訂閱／歷史workflow | 69 | 正式API與本機磁碟KV／SQLite。 |
| 表格保存與重啟回讀 | 37 | 正式API與新程序磁碟回讀。 |
| **合計** | **340** | 無skip；30項before/after不再次累加。 |

另從原3.3.18／3.3.19包實際啟動舊來源建立合成資料，再升到本次3.3.27，**7組情境通過**：原值、帳號密文、模板、設定、已有歷史保留，漏歷史補回、備份取新值、重複執行不重複歷史、損壞備份拒絕。case標籤仍有歷史`3320`，目的來源為本次ROOT，不是舊結果改名。

111項來源／內嵌腳本語法通過；3個新增原生suite語法另通過；3份TOML與2份Workflow YAML解析通過。沒有重跑瀏覽器畫面或原生剪貼簿，沒有把舊結果加入本次數字。

## 6. 不能宣稱已通過的項目

本工作環境的`npm ci`實際失敗，npm registry解析出現EAI_AGAIN，造成套件未完整安裝。並已實際嘗試：

| 項目 | 實際結果 |
|---|---|
| 完整鎖定型別檢查 | exit2，找不到`@cloudflare/workers-types`（TS2688） |
| 完整Workers Vitest | exit127，`vitest: not found` |
| 真正Wrangler離線bundle | exit1，缺少鎖定的hono／本機工具套件 |
| 正式Cloudflare發布 | 未操作，沒有Token／帳戶授權或正式資料 |

新增的原生Workers測試共17個（10身份＋5KV＋2模式）已編寫，但本機沒有成功執行；原來完整Workers suite同樣未在本環境通過。**不能把340項本機／適配器測試當成完整Workers通過，更不能承諾下一次所有平台步驟必成功。** 正式入口仍要求真正npm test、lint與bundle，失敗仍會停止，不設skip開關。

驗證紀錄存於`tests/results/3.3.27/`，原版本results屬於歷史，不計入本次。

## 7. 原資料保留與變更範圍

67個業務檔案逐檔比對：**62不變，5修改**（upgrade-reconcile、superadmin、auth handler、subscription-workflow、subscriptions handler）；見`business-source-comparison.json`。

未更動7份SQL migrations、D1/KV資源ID、帳號密碼密文格式、加密密鑰、歷史儲存鍵、模板鍵、備份加密格式、原值驗收及16分鐘維護等待。没有R2或物件儲存後備路徑。未接觸正式資料，不能宣稱已驗收使用者正式記錄。

## 8. 交付與使用

同時提供完整包及**3.3.26→3.3.27差異包**。目前倉庫已是3.3.26時建議使用差異包，直接合併檔案到原根目錄；不包含wrangler.toml變更，不覆蓋原額外superadmin測試／pages-handler。

命令保持`npm run build`與`npm run deploy:cloudflare`，沿用備份密碼與原帳戶ID。必須提交新程式；只Retry未改的3.3.26不會修正本次程式問題。舊批次若已在維護中，先同版同提交恢復；本次日誌在發布前測試中止，不顯示這次已建立正式維護批次。

## 官方規格核對（外部資料，不代替專案實測）

- KV讀取： https://developers.cloudflare.com/kv/api/read-key-value-pairs/ （現行最低30，與本次舊執行器最低60的日誌區分）
- Workers Vitest： https://developers.cloudflare.com/workers/testing/vitest-integration/ （工作執行器測試與Node替身不同）
