# AgentWorkflowGui

在同一個桌面介面裡，管理 **Claude** 與 **Codex** 的多個 session，並用可重複使用的 workflow 把它們串起來。

A local desktop GUI for running reusable agent workflows across Claude and Codex sessions.

> **開發中**：目前完成專案骨架、前後端共用的介面定義，以及用假資料運作的工作台外殼；尚未接上真正的 Claude／Codex runtime。

## 為什麼做這個

Claude 和 Codex 各有自己的 IDE，但只能各自使用。AgentWorkflowGui 的重點是**跨工具**：

- 同一個工作台同時開 Claude 和 Codex 的 session，可以互相傳訊息。
- 用 workflow 把工作交給不同的 agent，例如「規劃 → 實作 → review → 測試」，每個 node 可以選不同的工具和 model。
- 要換工具時，把目前的進度整理好，轉交給另一個工具的新 session 接著做。

## 規劃中的功能

| 功能 | 說明 |
|---|---|
| Session 工作台 | session 樹、對話區、右側四個分頁（成果、任務流程、跨 session 訊息、Session 資訊）、兩組工作區並排 |
| Agent 管理 | 可重複使用的角色定義；Agent 不綁 model，model 在 session 或 workflow node 上另外選 |
| Workflow 編輯器 | 拖拉 node、拉線連接；每個 node 有多條 input／output 規則 |
| Task 流水線 | 每個 task 在自己的 git worktree 裡進行，多個 task 錯開時間平行跑，最後依序合併 |
| 跨工具轉交 | 整理內容（目標、交接說明、diff、測試結果），經使用者確認後在另一個工具建立新 session |
| 權限與升級 | 一般操作自動核准；寫到工作目錄外、push、破壞性指令、讀取秘密檔等送到 root session 由使用者決定 |
| 外觀 | 預設深色，可切換淺色 |

## 技術

- Electron + React + TypeScript，先支援 Windows
- 透過 Claude Agent SDK 與 Codex app-server 驅動兩邊的 agent
- App 關閉後不在背景繼續執行

## 開發

需求：Node.js 22.12 以上、npm 10 以上。

```bash
npm install        # 安裝依賴（也會下載 Electron）
npm run dev        # 開發模式啟動
npm test           # 執行測試
```

完整的指令、目錄結構、模組依賴規則與 Electron 安全設定見 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 授權

本專案以 [GNU General Public License v3.0 或之後的版本](LICENSE)（GPL-3.0-or-later）釋出。

Copyright (C) 2026 firewings2515
