# SubsTracker v3.3.30 — 實測與驗證邊界

測試日期：2026-10-09。唯一基準是使用者上傳的完整 v3.3.29。

**結論：已執行的本地 Node、業務與語法檢查通過；真正 Workers／Wrangler 與線上部署尚未通過驗收。**

## 基準與檔案完整性

- 原包：`SubsTracker-GitHub-Cloudflare-Ready_v3.3.29_KVOnlySafeDeployFix_20261008.zip`
- 原包 SHA-256：`bf89d859195b4cf3adebb055f6f73a497d1b60601559530d28222f75b6883f16`
- 版本：package.json、lockfile 根資訊、src/version.js、src/upgrade-release.js 配套更新為 3.3.30。
- 依賴版本未變更。原 `wrangler.toml`、`migrations/`、業務 `src/`（除上述兩個版本檔）逐位元組保留。
- 新包 `FILE_MANIFEST_3.3.30.json` 提供逐檔 SHA-256，排除清單自身。差異清單 `PATCH_3.3.29_TO_3.3.30.json` 記錄修改／新增與原、新雜湊。
- 原包歷史驗證文件保留原樣；它們不代表本輪已重跑。

## 實際執行結果

| 項目 | 結果 | 實際範圍／證據 |
| --- | --- | --- |
| Node regression | 275 / 275，exit 0 | deploy、upgrade、storage、compat、runtime、table-contract；`node-regression.tap` |
| 語法檢查 | 112 / 112，exit 0 | src/scripts 的 JS 模組與內嵌腳本；`syntax.log` |
| 業務 workflow | 69 / 69，exit 0 | 原處理器、本地真實 SQLite 與檔案 KV；`workflow-results.json` |
| Table API regression | 37 / 37，exit 0 | D1+KV／KV-only 兩模式，含落盤及重啟驗證；`api-results.json` |
| 依賴安裝 | exit 1，環境失敗 | registry.npmjs.org 多次 `EAI_AGAIN`，npm 最後報 `Exit handler never called!` |
| 鎖定版本 tsc、原生 Workers/Vitest、真正 Wrangler bundle | **未完成／受阻** | 沒有安裝成功，不把 mock 結果當作原生通過 |
| 真正 Cloudflare API／正式部署 | **未執行** | 未使用使用者帳戶、Token 或線上 Worker |

275 項內含本版新增 **27 項綁定／環境針對性測試 + 3 項分段整合測試**，不是另外再加 30。
行為斷言合計 381（275 + 69 + 37）；112 語法檢查另列，不混成「493 項完整部署測試」。
所有本輪日誌及機器可讀摘要位於 `tests/results/3.3.30/`。

## 舊版問題的離線重現

`baseline-reproduction.json` 記錄直接呼叫原 v3.3.29 程式得到的結果：

1. 未指定 name 的命名環境錯用頂層 Worker 名稱。
2. 命名環境錯誤繼承頂層 KV 宣告。
3. 線上回應含 D1 列但沒有 ID 時，原 protectBindings 靜默返回 dbId:null。

原包歷史文件記載 `ST_SPLIT_D1_REQUIRED`，但本輪沒有最新完整線上失敗日誌，因此**未斷言上述三項就是使用者當次唯一失敗根因**。

## 新增驗收覆蓋

綁定完整時走原快路徑；settings 缺 D1 或缺 ID 時只核驗現行 100% 流量版本。涵蓋大小寫與 legacy id、資料衝突、403、查詢中部署變更、錯版本、灰度多版本、缺少版本、重複名稱、儲存／vars／Secret 名稱變更、GET 白名單及命名環境規則。

兩個新增完整分段場景分別隱藏 settings 的 D1 列／D1 ID，皆從第一階段 `ST_UPGRADE_WAIT`，經測試時間推進與新程序，至第二階段 `ST_UPGRADE_COMPLETE`，沿用相同原 KV 與原 D1。另一新增場景在測試完成後變更 D1，確認鎖與後續寫入前停止。

## 模擬與真實部分

分段整合測試使用**模擬 Cloudflare transport、模擬 Wrangler 發布器與模擬 release-check 子程序**，不會發送真正雲端更新。升級主程式、備份／加密／還原與驗收程式是本版實際模組，本地 SQLite 真正落盤，KV 使用檔案配接器。

Node 和 Python 回歸在該模擬流程以外亦獨立執行，原模組回傳、資料庫內容、寫入失敗處理與程序重启皆受測。仍不等於 workerd 的真實執行結果。

完整的 12 個 release checks 清單沒有刪除、縮減或加跳過環境變數。真實發布仍必須依原流程通過。

## 沒有列為通過的項目

舊 3.3.18／3.3.19 跨版本實驗需要該兩版的實際 baseline 原始碼，本輪未提供。第一次額外呼叫因缺 `--baseline-dir`、`--out` 在 argparse 結束，沒有進入業務斷言；紀錄保留於 `intermediate/business-regression.log`。之後把可執行的現行 workflow/API/語法檢查獨立重跑，均 exit 0。未偽造歷史基準或套用舊報告為本版通過。

## 執行環境

Node.js 22.16.0；npm 10.9.2；Python 3.13.5；SQLite 3.49.1（node:sqlite）。

正式套用條件、舊維護批次處理、原 D1 基礎表要求、Cloudflare Build／Deploy 命令見 `DEPLOY_REPAIR_3.3.30.md`。不清空資料，不建立替代庫，不撤除原 D1 原子鎖。
