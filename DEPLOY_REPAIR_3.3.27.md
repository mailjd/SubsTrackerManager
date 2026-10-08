# SubsTracker v3.3.27｜本次更新操作

此次不是控制台命令或備份Secret問題。3.3.26已進入Workers測試，遇到KV讀取參數、缺失的SuperAdmin函式及分類同步缺陷；必須提交修正後的程式，重試同一份未修改來源不能解決。

## 推薦：對現有3.3.26使用差異修補包

將 `SubsTracker_v3.3.27_from_v3.3.26_Patch_20261008.zip` 解壓後內容，按相同相對路徑合併到原Git倉庫根目錄並提交。包含src、scripts、tests、package／lock及配套文件。**不要只上傳ZIP檔案本身，不要刪除整個倉庫或src/tests。**

差異包不包含新的wrangler.toml，不刪除原Worker／KV／D1設定，不覆蓋使用者額外的 `src/pages-handler.js`、`tests/core/superadmin.test.js`。新版只讀診斷會列出這些額外檔案，完整測試仍會檢查它們。若你另有本機自訂過本次修改的5個業務檔案，先用Git檢查差異合併，不以未知自訂碼已相容為前提。

完整ZIP是同一版源碼，供保管或乾淨工作目錄使用；直接使用完整ZIP時仍需保留原wrangler專屬ID／路由，不拿範例值替換。

## 控制台設定不再改動

```text
Build command: npm run build
Deploy command: npm run deploy:cloudflare
```

沿用原 `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN`、`SUBSTRACKER_WORKER_NAME`、網站源地址及 `SUBSTRACKER_BACKUP_PASSWORD`。不換備份密碼，不新增R2，不改原D1/KV綁定。deprecated／Node SQLite experimental警告不是此次17項失敗的直接根因。

## 先核對實際新提交

新日誌會有 `subscription-manager@3.3.27` 和 `ST_CHECKOUT_INVENTORY`。額外來源／测试会列出路径与摘要，不顯示機密，不自動刪除。舊pages-handler仍由原props相容器處理。

```text
[release:check] lint
[release:check] test
> vitest run
```

Workers測試已提前到lint後，不再先跑完大量慢速模擬升級才看到原生失敗。**不要把Node test:runtime或test:workflow綠燈當成完整Workers suite通過。** 真正的Vitest全部通過後仍須完成其餘發布檢查、正式備份與驗收。

有可安裝鎖定依賴的本機／CI環境時，可先在沒有正式凭证的工作目錄執行：

```sh
npm ci --include=dev
npm run diagnose:checkout
npm run verify:release
```

`verify:release`只跑完整檢查，不發布、不遷移，不以npm仿真替代真正Vitest。缺少套件或任一測試失敗都會非零退出。

## 維護批次與完成條件

目前仍是第一階段後按`readyAfter`手動Retry**同一提交**，不是全自動續跑。只有這三點成立才算部署完成：

```text
ST_UPGRADE_COMPLETE
/api/upgrade/status → version: 3.3.27
/api/upgrade/status → maintenance: false
```

如果帳戶中另一次舊批次已處於WAIT／維護但未完成，先用該批次原版本、原提交、原密碼恢復，不用3.3.27冒充舊來源。本次所附日誌在發布前Vitest失敗，單靠此日誌不能判斷其他批次是否存在。

## 限制

本機30項新契約測試已對原版重現23個失敗，修正版30全通過；本次共340項本機回歸及7組舊版來源情境通過。但因本工作環境npm registry DNS失敗，完整鎖定Workers Vitest／型別／Wrangler打包未在此完成。新增的17項原生測試需要由能安裝套件的環境執行。沒有線上部署驗收，不保證所有平台權限或後續步驟都已通過。

完整證據與資料保留範圍見 `VERIFICATION_3.3.27.md`。
