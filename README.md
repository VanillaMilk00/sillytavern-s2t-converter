# SillyTavern 簡體轉繁體擴充

這是一個 SillyTavern 第三方擴充，使用 OpenCC JS 將簡體中文顯示為繁體中文。

## 功能

- 自動將角色回覆顯示為繁體。
- 角色生成中可即時顯示繁體預覽。
- 預設只寫入 `message.extra.display_text`，不改 `message.mes` 或 `swipes` 原文。
- 保護 SillyTavern 角色卡常用語法，例如 `{{setvar::好感度::喜欢}}`。
- 保護 Markdown 程式碼區塊、行內程式碼、slash command 行與常見全大寫角括號 token。
- 可手動轉換目前聊天室的顯示文字，或明確轉換輸入框文字。
- 支援繁體、台灣繁體、台灣用語、香港繁體。

## 安裝

在 SillyTavern 的「Import Extension From Git Repo」輸入：

```text
https://github.com/VanillaMilk00/sillytavern-s2t-converter.git
```

也可以手動將整個資料夾放到：

```text
SillyTavern/data/<user-handle>/extensions/sillytavern-s2t-converter
```

或開發用的全域路徑：

```text
SillyTavern/public/scripts/extensions/third-party/sillytavern-s2t-converter
```

重新整理 SillyTavern 後，到 `Extensions` 設定頁找到 `簡體轉繁體`。

## 變量與指令安全

自動轉換不會改寫原始聊天內容，因此不會把角色卡依賴的簡體變量名轉成繁體。

例如以下內容會保留 macro 原樣，只轉換外層顯示文字：

```text
{{getvar::状态}} 她说喜欢。
```

輸入框的「轉換輸入框」按鈕是明確手動操作，但同樣會保護 `{{...}}`、Markdown 程式碼與 `/setvar ...` 這類 slash command 行。

## 生成中即時顯示

開啟「生成中即時顯示繁體」後，擴充會在串流生成期間定期讀取目前回覆原文，轉成繁體後只更新畫面顯示。

這個功能不會逐 token 改寫文字，也不會把繁體寫回 `message.mes`。生成完成後才會用完整內容更新 `message.extra.display_text`。

## 注意

此擴充預設從 jsDelivr 載入 OpenCC JS：

```text
https://cdn.jsdelivr.net/npm/opencc-js@1.3.2-next.0/dist/esm/full.js
```

如果瀏覽器無法連線到 CDN，可以在擴充設定中改成可用的 ESM module URL。
