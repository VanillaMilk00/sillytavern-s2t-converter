# SillyTavern 簡體轉繁體擴充

這是一個 SillyTavern 第三方擴充，使用 OpenCC JS 將簡體中文轉為繁體中文。

## 功能

- 自動轉換角色回覆。
- 可選擇轉換使用者送出的訊息。
- 可手動轉換目前聊天室或輸入框文字。
- 支援繁體、台灣繁體、台灣用語、香港繁體。
- 預設保留 Markdown 程式碼區塊與行內程式碼。

## 安裝

1. 將整個 `sillytavern-s2t-converter` 資料夾放到 SillyTavern 的擴充資料夾：

   ```text
   SillyTavern/data/<user-handle>/extensions/sillytavern-s2t-converter
   ```

   或開發用的全域路徑：

   ```text
   SillyTavern/public/scripts/extensions/third-party/sillytavern-s2t-converter
   ```

2. 重新整理 SillyTavern。
3. 到 `Extensions` 設定頁找到 `簡體轉繁體`，確認已啟用。

## 注意

此擴充預設從 jsDelivr 載入 OpenCC JS：

```text
https://cdn.jsdelivr.net/npm/opencc-js@1.3.2-next.0/dist/esm/full.js
```

如果你的瀏覽器無法連線到 CDN，可以在擴充設定中改成可用的 ESM module URL。
