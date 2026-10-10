# v3.3.29～v3.3.33 → v3.3.34 累積修補

解壓後將內容合併至原 repository 根目錄，覆蓋同名檔；不要只上傳 ZIP 或放成 scripts/src。package.json/package-lock.json 必須一起更新。

修補包不包含 wrangler.toml，不刪除原 KV/D1/Secrets，不自動改 Cloudflare 控制台命令。現在**不要求先解綁**：已綁原資源保持不動，原命令發布完成後 /init。沒有綁齊也可先部署，再補綁缺項的原資源。

Build npm run build，Deploy npm run deploy:cloudflare。不要沿用舊 ST_UNBOUND_STILL_BOUND 的解綁指令，不加 direct/split/code-only flag。

操作與限制見 DEPLOY_REPAIR_3.3.34.md、VERIFICATION_3.3.34.md。原生 Wrangler/Workers 與線上部署尚未完成驗證，不以本地模擬結果保證正式部署。

套用驗證只針對本對話提供的完整 ZIP 基準，不代表會刪除或修復使用者 repository 另加的檔案。日誌中多餘的 scripts/src 等不會被這個 ZIP 自動刪掉。自訂過的同名程式檔請先比對，不覆蓋原環境與機密。
