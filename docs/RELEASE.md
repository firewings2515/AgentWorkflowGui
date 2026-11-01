# 發行條件（Windows 安裝檔）

AgentWorkflowGui 目前只發行 **Windows x64、未簽章、per-user** 的 NSIS 安裝檔。這份文件寫清楚裡面有什麼、需要什麼、以及發行前要確認的事。

## 1. 版本矩陣

| 項目 | 版本 | 說明 |
|---|---|---|
| Electron | 45.0.0 | 內建 Node **24.22.0**、Chromium 156.0.8078.48、V8 15.6、SQLite 3.53.4；`node:sqlite` 用的是這個 runtime，不需要另外安裝 Node |
| Node（開發／建置） | ≥ 22.13.0 | `package.json` 的 `engines`；打包後的 app 不需要系統安裝 Node |
| electron-builder | 26.18.0 | dev 依賴，固定版本；NSIS 3.0.4.1（由它下載到使用者 cache） |
| Claude Agent SDK | 0.3.309 | 內含原生 CLI（`@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`，Claude Code **2.1.309**）；隨安裝檔附上 |
| Codex CLI | 0.160.0（實測） | **不隨安裝檔附上**；使用者自己安裝，app 在 `PATH` 找 `codex.exe`（或環境變數 `AWG_CODEX_COMMAND`）；找不到時 Codex 不可用，Claude 不受影響 |
| koffi | 3.3.2 | Job Object 用；只打包 `win32-x64` 的 native |
| OS | Windows 10 22H2（build 19045，實測）、Windows 11 x64 | 沒有 arm64 版安裝檔；沒有 macOS／Linux 版 |

## 2. 產出與建置

```bash
npm ci
npm run dist     # electron-vite build → 產生授權清單 → electron-builder（NSIS，x64）→ 檢查授權檔都在清單內
npm run pack     # 只產生 release\win-unpacked（不做安裝檔），用來看內容
```

- 產物：`release\AgentWorkflowGui-Setup-<version>-x64.exe`（約 218 MB，其中 claude.exe 約 285 MB 壓縮前）；`release\win-unpacked\` 約 610 MB。`release\` 與 `build-resources\` 都在 `.gitignore`，不進 git。
- 設定在 `electron-builder.yml`；`npm run dist` 不需要系統管理員權限、不需要憑證，也不發布到任何地方（`publish: null`）。
- 第一次建置會下載 Electron zip 與 NSIS 工具到使用者的 cache（`%LOCALAPPDATA%\electron\Cache`、`%LOCALAPPDATA%\electron-builder\Cache`）。

### 打包後的路徑

| 項目 | 處理 |
|---|---|
| koffi（`.node`） | `asarUnpack`；`require('koffi')` 由 Electron 對 `.node` 的處理導到 `app.asar.unpacked` |
| claude.exe | `asarUnpack`；Agent SDK 用 `require.resolve` 找到的是 `app.asar` 內的路徑，不能啟動，`app/main/packaged-paths.ts` 在啟動時把它換成 `app.asar.unpacked` 的同一個檔案（session 與 model 探測共用）。只有 `app.isPackaged` 為真、而且路徑開頭正好是 `<process.resourcesPath>\app.asar\` 時才換；開發版與其他路徑一律原樣 |
| GUI MCP server | 在 main bundle 內、同一個行程的本機 HTTP server，不需要路徑 |
| `node:sqlite` | Electron 內建，不需要 unpack |
| Codex | 不打包；由 `PATH` 偵測 |
| 使用者資料 | `%APPDATA%\AgentWorkflowGui\`（`awg.sqlite` 等），由 Electron 的 `userData` 決定 |

## 3. 安裝、解除安裝與使用者資料

- **per-user**：預設安裝到 `%LOCALAPPDATA%\Programs\AgentWorkflowGui`（electron-builder 的 per-user 預設值，`oneClick`，不會要求系統管理員權限；這個預設位置**沒有實測**，實測都是用 `/D=` 指定資料夾）。會在開始功能表建立捷徑，並在 `HKCU` 的解除安裝清單登記；不建桌面捷徑。
- 靜默安裝到指定資料夾：`AgentWorkflowGui-Setup-0.1.0-x64.exe /S /D=<資料夾>`（`/D` 必須放在最後、不加引號）。靜默解除安裝：`"<資料夾>\Uninstall AgentWorkflowGui.exe" /S`。
- **解除安裝保留使用者資料**（`deleteAppDataOnUninstall: false`）：`%APPDATA%\AgentWorkflowGui` 不會被刪。要徹底移除要自己刪這個資料夾。
- 程式還在執行時，安裝或解除安裝程式會要求先關閉它。
- 沒有自動更新：新版本要重新下載安裝；資料庫 migration 由 app 啟動時處理。

## 4. 未簽章的影響

- 安裝檔與 `AgentWorkflowGui.exe` **沒有程式碼簽章**，所以：
  - 從網路下載後執行，Windows SmartScreen 會顯示「Windows 已保護您的電腦」，發行者是「不明的發行者」。使用者要按「**其他資訊 → 仍要執行**」。
  - 有些公司的 AppLocker／WDAC／防毒政策會直接擋未簽章的程式。
  - 新發行的檔案沒有 SmartScreen 信譽。依 [Microsoft 現行文件](https://learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation)，信譽是隨下載與使用累積的；簽章（包括 EV 憑證）不再讓檔案立即取得信譽，也不保證不出現警告。
- 給使用者的做法：從可信來源取得，並對照發行頁公布的 SHA-256；發行者可以用 `Get-FileHash` 算出雜湊一起公布。
- 未來要簽章：在 `electron-builder.yml` 的 `win` 加入憑證設定（`certificateSubjectName` 或 `azureSignOptions`）即可，不需要改程式。這次**沒有做**。

## 5. 授權

- 本專案：**Apache-2.0**（`LICENSE`、`NOTICE`，兩者都放進安裝檔的 `resources\app.asar` 內）。
- 第三方授權清單：`npm run dist` 由 `package-lock.json` 的 production 依賴產生 `THIRD_PARTY_LICENSES.txt`（135 個套件，含 renderer 打進 bundle 的 react 與 @xyflow/react），安裝後在 `resources\THIRD_PARTY_LICENSES.txt`。授權分布：MIT 111、ISC 15、BSD-3-Clause 3、Apache-2.0 2、BSD-2-Clause 1、Unlicense 1，另外 2 個是 Anthropic 的專有授權（見下）。清單是 production 依賴的**超集合**：也列出 lock 內有、但沒有放進安裝檔的套件（例如 Agent SDK 的選用 peer 依賴 `@anthropic-ai/sdk`）。
  - 清單產生程式 `scripts/third-party-licenses.mjs` 讀每個套件根目錄與其內 vendored 資料夾（不含巢狀 `node_modules`）的授權與 NOTICE 檔，目前 137 個檔案（含 koffi 的 `vendor/node-addon-api/LICENSE.md`、`vendor/node-api-headers/LICENSE`），每個檔以 `File: node_modules/...` 標出；`npm run dist` 最後跑 `scripts/check-licenses.mjs`，產物（`app.asar` 與 `app.asar.unpacked`）裡任何一個授權或 NOTICE 檔不在清單內就失敗；有 2 個套件沒有授權檔（`@koromix/koffi-win32-x64`、`standardwebhooks`，兩者的 package.json 都標示 MIT；koffi 主套件附有 LICENSE.txt），清單中標明「no licence file in the package」。
- **Anthropic 的 Claude Agent SDK 與 claude.exe 是專有授權**（`SEE LICENSE`：© Anthropic PBC，依 Anthropic 的法律條款使用）。安裝檔內含 `claude.exe`，**對外發行（不只自用）前，需要確認 Anthropic 的條款允許以這種方式再散布**；這個判斷不是工程問題，這份文件沒有結論。若不允許，替代方案是改成要求使用者自己安裝 Claude Code，並以 `pathToClaudeCodeExecutable` 指向它（需要改程式，不在這次範圍）。
- Codex CLI（Apache-2.0）不隨附。

## 6. 已知限制

- 只有 Windows x64；沒有簽章、沒有自動更新、沒有 arm64。
- 安裝檔很大（約 218 MB，主要是 claude.exe）。
- Codex 要使用者自己安裝，而且 `codex.exe` 要在 `PATH`（或設定 `AWG_CODEX_COMMAND`）；從開始功能表啟動時看到的是使用者的 `PATH`，app 啟動時才偵測，剛安裝完 Codex 要重開 app（必要時重新登入 Windows，讓新的 `PATH` 生效）才找得到。
- 啟動後 Claude 的模型清單約 8 秒才出現（Codex 約 3 秒），這段時間模型選單只有 Codex 的選項。
- 圖示是 Electron 預設圖示（沒有設計過的 app 圖示）。exe 的版本資訊是 electron-builder 填的：`FileVersion` 0.1.0、`ProductVersion` 0.1.0.0、`ProductName` 與 `FileDescription` 為 `AgentWorkflowGui`、`LegalCopyright` 為 Copyright 2026 firewings2515；但 `CompanyName` 仍是 Electron 的預設值「GitHub, Inc.」（`package.json` 沒有 `author`），發行前要設定。
- 安裝／解除安裝只測過靜默模式（`/S`）與 per-user；沒有測過互動式安裝畫面，也沒有測過套用 AppLocker／WDAC 的企業環境。
- Claude 與 Codex 的 native home（`~/.claude`、`~/.codex`）由各自的 CLI 管理，解除安裝不會清理它們。

## 7. 發行前檢查清單

1. `npm ci`，`npm run lint`、`npm run typecheck`、`npx vitest run --maxWorkers=4`、`npm run build` 都通過。
2. `npm run dist`，確認 `release\` 內有安裝檔，`app.asar.unpacked` 內有 koffi 與 claude.exe。
3. 在乾淨的 Windows 使用者帳號安裝（可用靜默安裝到暫存資料夾），以暫存的 `--user-data-dir` 啟動，跑 Claude 與 Codex 各一個 turn，正常退出（R-14）後沒有殘留程序。
4. 解除安裝後 `%APPDATA%\AgentWorkflowGui` 仍在、開始功能表捷徑與 `HKCU` 解除安裝項目已移除。
5. 確認 Anthropic 條款允許再散布 claude.exe（第 5 節）。
6. 算安裝檔的 SHA-256，隨發行說明公布；說明 SmartScreen 的警告。

## 8. T044 驗證紀錄

2026-11-01，Windows 10 19045 x64，已安裝版（`/S /D=<mkdtemp>\app`，暫存 `--user-data-dir`）。分兩次：

**A. 完整 live（commit `0f67a55` 的安裝檔）**

- 安裝 1 次（18 秒、沒有提權）、解除安裝 1 次（11 秒）；Electron GUI 啟動 2 次（第 2 次不送 turn，只確認模型清單）。
- Claude（haiku）與 Codex（gpt-6.1-sol）各 1 個 turn 都 completed；claude.exe 由 `app.asar.unpacked` 啟動；koffi／Job Object、`node:sqlite` 正常；GUI MCP server 隨 backend 啟動並掛到兩個 session，但 live 沒有實際呼叫 MCP 工具。
- 關閉 764 ms，沒有 R-14 對話框（當時沒有未結束的工作），沒有殘留程序。
- 解除安裝後：安裝資料夾、`HKCU` 解除安裝項目、開始功能表捷徑都已移除；暫存 userData 的 `awg.sqlite` 仍在，並能以唯讀開啟（22 個資料表，`T044-live-uninstall.json`）。
**B. 最終版的聚焦 live（commit `57f9c33` 的安裝檔：`AgentWorkflowGui-Setup-0.1.0-x64.exe`，218,379,071 位元組，SHA-256 `F5059819767E96C06D3BA45EEBCF52F57BD4A1F024C2AA635FD0BC8A289A37AC`）**

- 驗證 review 後新增的 `app.isPackaged`／`process.resourcesPath` 接線與 `\\?\` 正規化。安裝 1 次（18 秒）、Electron 啟動 1 次、解除安裝 1 次（10 秒）；只送 Claude（haiku）1 個 turn，Codex 沿用 A 的證據。
- Claude 的 13 個模型在 app 啟動後約 8 秒內出現（第一次查詢就已經有）；1 個 turn completed（`observedModel` `claude-haiku-5-5`）；執行中的 `claude.exe` 路徑正好是這次安裝的 `<安裝>\resources\app.asar.unpacked\node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe`。
- 腳本以 port 0 與 `DevToolsActivePort` 連線，並核對 port 擁有者的 PID 與建立時間，才送指令。關閉 768 ms、沒有殘留程序。
- 解除安裝後：安裝資料夾、`HKCU` 項目、捷徑都已移除；暫存 userData 的 `awg.sqlite` 仍在，22 個資料表，`logical_session` 1、`message` 2、`turn` 1、`owned_process` 4（`T044-live2-uninstall.json`）。

**沒有驗證**：有未結束工作時的 R-14 對話框（打包版）、預設安裝位置、互動式安裝畫面、Windows 11、`\\?\` 前綴在安裝版 SDK 上是否真的會出現（只有單元測試）。
