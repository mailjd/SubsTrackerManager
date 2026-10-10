# v3.3.34｜沿用原 Cloudflare Git 連接

不需要改 GitHub Actions。Build `npm run build`、Deploy `npm run deploy:cloudflare`。

保留原 KV/D1 綁定發布程式，然後 /init；無綁定或部分綁定也能發布等待頁。操作見 DEPLOY_REPAIR_3.3.34.md，驗證界線見 VERIFICATION_3.3.34.md。

不要同時執行另一個 Safe upgrade/舊分段工作流。本版不自動恢复尚未完成的舊版資料升級，也不宣告舊批次成功；處理舊批次時保留原恢復檔。
