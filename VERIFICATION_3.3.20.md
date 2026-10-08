# SubsTracker v3.3.20｜安全升級與資料保留驗證報告

日期：2026-09-28。基礎版本：v3.3.19；亦針對v3.3.18實際舊來源做跨版測試。本報告對應本次實際改動和本機測試，不是線上Cloudflare驗收報告。

## 交付內容

已實作受保護的原地升級、補遷移、完整加密備份與中斷恢復。升級原則是：**原資料完整保留和備份還原檢查通過才放行；不一致就停止，不清庫、不覆蓋來源、不偽報完成。**

程序不按預設名稱新建資料庫；讀取原Worker的實際KV namespace ID／D1 database ID並鎖定。原登入設定、已保存帳號密文、KV加密密鑰、自訂模板和業務歷史不重設。v3.3.19功能維持。

## 本次修掉的具體風險

| 原風險 | v3.3.20修正 | 驗證結果 |
|---|---|---|
| D1有一部分資料就忽略KV，舊3319標記阻止補齊 | 全量聯集、版本／支付校對，只補缺失歷史 | KV3筆＋D1僅1筆時，應有4條歷史全部得到，來源不刪除。 |
| 表格取D1新值，JSON卻只匯出KV舊值 | 表格／備份共享有效來源核對；完整原始來源另入加密包 | D1新備註在表格與匯出一致，KV原始舊快照仍保留作驗證來源。 |
| setup依默认名称建立／改綁空資料庫 | 查原Worker實際ID、匹配原設定，缺失／衝突停止 | 自訂KV／D1名保留，錯誤ID拒絕；測試監測無新建／刪庫呼叫。 |
| 保存數字相同但某一行被替換也算成功 | 原key／metadata／expiry與每筆SQL原行逐項比對 | 刪行、改值、改密文均不能通過。 |
| 原流程一個請求處理過多或重試又從第一批開始 | 每批最多8條，只選缺失列、單調進度、可續跑 | 180條歷史分23次請求完成；測試每次模擬冷隔離、強制最多50次D1查詢。 |
| 後端已提交但網路回應丟失 | 恢復伺服器報告／分批進度，核對同一備份憑證 | 丟失apply／commit回應後可恢復，不重复計數。 |

## 真正跨版與原資料核驗

使用原v3.3.18／v3.3.19來源啟動本機服務建立合成訂閱、歷史、帳號加密密文、雲端模板；停止舊程序，執行新加密備份／真實gate／逐項驗收，再啟動3.3.20重新GET。不是只在同一份記憶體資料上換版本字串。

7組情境全部通過：正常18→20；再次遷移與重啟不重複；D1部分缺失修復；D1舊支付清單補全；最新備註備份一致；實際19→20原4條歷史原欄位／原KV逐項相同；篡改v7 JSON校驗碼拒絕並確認未寫入。

正常測試原訂閱raw值、帳號憑證密文、模板和config均完全相同；19→20也逐項保留原歷史列。非会员舊記錄不在當前訂閱顯示但仍在歷史，是分頁規則而不是丢資料。

## 實際執行的回歸測試

| 測試組 | 通過／總數 | 邊界 |
|---|---:|---|
| 新升級保護Node組 | 56／56 | 合成KV／SQLite、加密、官方REST形狀的假傳輸、真正CLI／gate；不訪問Cloudflare。 |
| 既有表格保存API | 37／37 | 正式API及磁碟adapter，清空／提醒／失敗保留／重啟後讀回。 |
| 訂閱表格Chromium | 16／16 | 真實DOM事件、編輯／保存／取消／粘貼／失敗重試。 |
| 輸入契約／提醒／排程 | 8／8 | Node正式模組。 |
| Database／歷史API工作流 | 69／69 | 新增分流、累計、模板、帳號／公私／序號、刪除、舊備份還原等。 |
| Database／歷史Chromium | 27／27 | Tab、選單、篩選、模板、公私、深色選格、歷史頁、儀表板等。 |

合計 **213項回歸測試通過**，另有上述 **7組跨版／備份核驗情境**。另完成 **91項來源腳本／HTML內嵌腳本語法檢查**。最終測試JSON／TAP存於 `tests/results/3.3.20/`，沒有把舊版本的結果改名當成本次證據。

Node升級組另測試1,100筆KV訂閱以bulk读取，避免逐筆讀取超過模擬存取額度；缺少bulk返回項目會報錯，不跳過。配額測試是本機強制計數，不等於實測所有CloudflareCPU／記憶體／多區一致性限制。

## 升級前必做的最小設定

在原GitHub儲存庫新增獨立Secret：`SUBSTRACKER_BACKUP_PASSWORD`，至少16字元，建議隨機32字元以上，離線保存。保留原CloudflareToken／AccountID。確認原Worker準確名稱和原網站；自訂名設`SUBSTRACKER_WORKER_NAME`，自訂域名設`SUBSTRACKER_WORKER_URL`。

使用本包Safe upgrade工作流，不要與舊發布器／Cloudflare Git直連並行。新流程會先測試、備份，上傳備份成功才發佈維護版本；等待16分鐘讓舊工作退出，維護期備份成功才進行增補。最終驗收報告通過才開站。

本版不能當成只覆蓋幾個前端文件的更新：**部署腳本和工作流同樣必須使用本次版本。** 詳細指令和恢復方式見 `SAFE_UPGRADE_3.3.20.md`。

## 完整備份範圍

`.stbackup`包含原KV bytes／metadata／expiration、完整D1 SQL、原設定，並對原存於KV的密鑰／登入配置和帳號密文一起加密保護。AES-256-GCM、隨機salt／IV、scrypt派生密鑰；無明文正式憑證寫進交付包。可離線解密到新目錄做還原檢查，不自動覆蓋遠端。

**Cloudflare Worker Secrets的值未由API匯出**；原Worker／Secret名稱保留，但跨帳戶重建需要你另行保管原Secret值。普通網頁JSON默认不包含密碼／全密鑰，不能代替完整`.stbackup`。使用者尚未保存的前端編輯和只存在瀏覽器的Layout也不屬於雲端資料備份。

## 已知限制與未驗證項目

沒有存取、修改、發布你的正式Cloudflare帳戶。所有測試用合成資料和本機adapter；Chromium使用真實DOM加loopback橋接／必要離線樣式，不宣稱完整CDN逐像素或原生OS剪貼簿驗收。

本環境實際嘗試`npm ci`，因registry DNS EAI_AGAIN而失败；`npm test`缺Vitest，`npm run lint`缺Cloudflare Workers types（TS2688），**不能列為通過**。本包CI保留兩者為發布前必需，沒有為取得綠燈而跳過。舊Workers API單測明確模拟「已完成升級」狀態；新56項測試另外實測升級閘門，正式程式無測試解鎖開關。

「原資料保留」不代表能憑空恢復之前已刪除／截斷／從未儲存的交易。矛盾來源、過早schema、欠缺密鑰、超出配額或外部並行寫入可能讓升級停止。這時需保留原資料、備份和恢復憑證核對，不硬升級。未在所有資料規模／平台故障下證明百分之百完成。

## 核驗重跑

```sh
node --test tests/upgrade/*.test.mjs
node --test tests/regression/contract.node.mjs
python3 tests/regression/api-regression.py . /tmp/subs-api-fresh
python3 tests/regression/workflow3319.py . /tmp/subs-workflow-fresh
python3 tests/regression/browser-regression.py . /tmp/subs-browser-fresh
python3 tests/regression/workflow-browser3319.py . /tmp/subs-db-browser-fresh
node scripts/check-syntax.mjs
```

原版整合測試需另備原包：將原3.3.18和3.3.19各解壓到同一基底目錄下`18/`、`19/`，再用：

```sh
python3 tests/upgrade/old-version-integration.py --baseline-dir /path/to/baselines --out /tmp/subs-cross-version-fresh
```

所有輸出目錄應使用新目錄。本機回歸不接觸遠端資料；runner test假傳輸明確拒絕真實外網連線。
