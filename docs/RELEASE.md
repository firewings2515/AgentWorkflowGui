# 發行條件（Windows 安裝檔）

AgentWorkflowGui 目前只發行 **Windows x64、未簽章、per-user** 的 NSIS 安裝檔。這份文件寫清楚裡面有什麼、需要什麼、以及發行前要確認的事。

## 1. 版本矩陣

| 項目 | 版本 | 說明 |
|---|---|---|
| Electron | 45.0.0 | 內建 Node **24.22.0**、Chromium 156.0.8078.48、V8 15.6、SQLite 3.53.4；`node:sqlite` 用的是這個 runtime，不需要另外安裝 Node |
| Node（開發／建置） | ≥ 22.13.0 | `package.json` 的 `engines`；打包後的 app 不需要系統安裝 Node |
| electron-builder | 26.18.0 | dev 依賴，固定版本；NSIS 3.0.4.1（由它下載到使用者 cache） |
| Claude Agent SDK | 0.3.309 | 只附 SDK 的 JavaScript；它的原生 CLI（`@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`）**不隨安裝檔附上** |
| Claude Code | **≥ 2.1.309**（SDK 的 `claudeCodeVersion`） | **需要使用者自行安裝並登入**；不隨安裝檔附上。app 依序找：環境變數 `AWG_CLAUDE_PATH` → `PATH` 上的 `claude.exe` → `%USERPROFILE%\.local\bin\claude.exe` → Claude 桌面版附帶的 CLI（`claude-code\<版本>\`，取最新）；用 `claude --version` 檢查版本、`claude auth status` 檢查登入。找不到、太舊或未登入時 Claude 不可用，Codex 不受影響 |
| Codex CLI | **≥ 0.160.0**（實測的版本） | **不隨安裝檔附上**；使用者自己安裝並登入。app 依序找：環境變數 `AWG_CODEX_COMMAND` → `PATH` 上的 `codex.exe`（或 npm shim 背後的 vendored binary）→ `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`；用 `codex --version` 與 `codex login status` 檢查。找不到、太舊或未登入時 Codex 不可用，Claude 不受影響 |
| koffi | 3.3.2 | Job Object 用；只打包 `win32-x64` 的 native |
| OS | Windows 10 22H2（build 19045，實測）、Windows 11 x64 | 沒有 arm64 版安裝檔；沒有 macOS／Linux 版 |

**找到的路徑一律是完整路徑**：`PATH` 裡的 `.`、空項目與相對路徑會被略過，`AWG_CLAUDE_PATH`／`AWG_CODEX_COMMAND` 必須是完整路徑的 `.exe`；偵測後交給啟動器的是解開連結後的真實檔案路徑，不會再依 session 的工作資料夾重新查找；解開連結後的檔案若不是 `.exe`（例如名為 `claude.exe` 的連結指向 `runtime.js`，SDK 會改用 `node` 啟動它），不會被執行，該 runtime 顯示為「讀不到版本」並附固定說明。`--version` 只認得 `2.1.309 (Claude Code)`、`codex-cli 0.160.0` 或單獨的版本號（完整 SemVer）這幾種輸出，其他一律當作讀不到版本。

## 2. 產出與建置

```bash
npm ci
npm run dist     # electron-vite build → 產生授權清單 → electron-builder（NSIS，x64）→ 檢查授權檔都在清單內
npm run pack     # 只產生 release\win-unpacked（不做安裝檔），用來看內容
```

- 產物：`release\AgentWorkflowGui-Setup-<version>-x64.exe`（約 110 MB；T044 內建 claude.exe 時是 218 MB）；`release\win-unpacked\` 約 326 MB。`release\` 與 `build-resources\` 都在 `.gitignore`，不進 git。
- 設定在 `electron-builder.yml`；`npm run dist` 不需要系統管理員權限、不需要憑證，也不發布到任何地方（`publish: null`）。
- 第一次建置會下載 Electron zip 與 NSIS 工具到使用者的 cache（`%LOCALAPPDATA%\electron\Cache`、`%LOCALAPPDATA%\electron-builder\Cache`）。

### 打包後的路徑

| 項目 | 處理 |
|---|---|
| koffi（`.node`） | `asarUnpack`；`require('koffi')` 由 Electron 對 `.node` 的處理導到 `app.asar.unpacked` |
| claude.exe | **不打包**（T045）。app 把偵測到的使用者自己的 Claude Code 用 `pathToClaudeCodeExecutable` 交給 SDK，仍由 app 啟動在每個 session 的 Job 裡。T044 的 `app.asar` → `app.asar.unpacked` 路徑轉換因此移除。只有開發版（未打包）找不到本機 Claude Code 時才退回 SDK 附的那一份，並記 log；打包版不退回 |
| GUI MCP server | 在 main bundle 內、同一個行程的本機 HTTP server，不需要路徑 |
| `node:sqlite` | Electron 內建，不需要 unpack |
| Claude Code、Codex | 不打包；由 app 偵測使用者自己的安裝（見第 1 節），結果顯示在「設定 → Runtime」 |
| 使用者資料 | `%APPDATA%\AgentWorkflowGui\`（`awg.sqlite` 等），由 Electron 的 `userData` 決定 |

## 3. 安裝、解除安裝與使用者資料

- **per-user**：預設安裝到 `%LOCALAPPDATA%\Programs\agent-workflow-gui`（electron-builder 的 per-user 預設值，資料夾名取自 `package.json` 的 `name`；2026-11-04 使用者實際安裝確認），不會要求系統管理員權限。會在開始功能表建立捷徑，並在 `HKCU` 的解除安裝清單登記；不建桌面捷徑。
- **安裝畫面**（T049）：一般的安裝精靈，不是 one-click。執行後不問問題，直接安裝；裝完停在完成頁，顯示安裝到哪個資料夾，以及「執行 AgentWorkflowGui」的勾選框（預設打勾），按「完成」關閉。整個安裝程式是繁體中文。完成頁文字在 `installer/installer.nsh`。
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
- 第三方授權清單：`npm run dist` 由 `package-lock.json` 的 production 依賴產生 `THIRD_PARTY_LICENSES.txt`（135 個套件，含 renderer 打進 bundle 的 react 與 @xyflow/react），安裝後在 `resources\THIRD_PARTY_LICENSES.txt`。授權分布：MIT 111、ISC 15、BSD-3-Clause 3、Apache-2.0 2、BSD-2-Clause 1、Unlicense 1，另外 2 個是 Anthropic 的專有授權（見下）。清單是 production 依賴的**超集合**：也列出 lock 內有、但沒有放進安裝檔的套件（例如 Agent SDK 的選用 peer 依賴 `@anthropic-ai/sdk`，以及 SDK 的原生 CLI 套件 `claude-agent-sdk-win32-x64` 等，T045 起這些不在安裝檔內）。
  - 清單產生程式 `scripts/third-party-licenses.mjs` 讀每個套件根目錄與其內 vendored 資料夾（不含巢狀 `node_modules`）的授權與 NOTICE 檔，目前 137 個檔案（含 koffi 的 `vendor/node-addon-api/LICENSE.md`、`vendor/node-api-headers/LICENSE`），每個檔以 `File: node_modules/...` 標出；`npm run dist` 最後跑 `scripts/check-licenses.mjs`，產物（`app.asar` 與 `app.asar.unpacked`）裡任何一個授權或 NOTICE 檔不在清單內就失敗；有 2 個套件沒有授權檔（`@koromix/koffi-win32-x64`、`standardwebhooks`，兩者的 package.json 都標示 MIT；koffi 主套件附有 LICENSE.txt），清單中標明「no licence file in the package」。
- **Anthropic 的 Claude Agent SDK 是專有授權**（`SEE LICENSE`：© Anthropic PBC，依 Anthropic 的法律條款使用）。T045 起**安裝檔不再散布 `claude.exe`**（SDK 附的原生 CLI，約 285 MB）：app 使用使用者自己安裝、自己登入的 Claude Code，原本的「是否允許再散布 claude.exe」疑慮不再存在。安裝檔裡仍有 SDK 本身的 JavaScript（`@anthropic-ai/claude-agent-sdk`，約 5 MB）與它的授權檔；它是否可以隨應用程式散布，仍依 Anthropic 的條款，這份文件沒有結論，對外發行前請一併確認。
- app 不讀取、不保存、不顯示 Claude Code 或 Codex 的登入憑證或帳號：登入狀態只用它們自己的 `claude auth status`、`codex login status` 查，只顯示類別（訂閱、API key、未登入、不明）。
- Codex CLI（Apache-2.0）不隨附。

## 6. 已知限制

- 只有 Windows x64；沒有簽章、沒有自動更新、沒有 arm64。
- 安裝檔約 110 MB（T045 之前內建 claude.exe 時 218 MB）。
- **Claude Code 與 Codex 都要使用者自己安裝並登入**，app 不安裝、不下載、不代為登入。Claude Code 要 ≥ 2.1.309、Codex 要 ≥ 0.160.0；太舊時該 runtime 不可用，並提示要更新到的版本。
- 從開始功能表啟動時看到的是使用者的 `PATH`，所以剛安裝完要到「設定 → Runtime」按「重新偵測」；建立或 resume session 前，若該 runtime 目前不可用也會自動重新偵測一次（不定時輪詢）。剛改過的 `PATH` 只有重開 app（必要時重新登入 Windows）才看得到。
- runtime 變得不可用（解除安裝、版本太舊、未登入、檔案不是 `.exe`）之後，已存在的 session 要重新啟動它時，app 在建立 adapter 之前就拒絕：`session.send` 回 `runtime_unavailable`，訊息已儲存並維持待送（不會進入送出中或結果未知），runtime 恢復可用、按「重新偵測」後再送同一則訊息即可。
- 不可用的 runtime 的模型不會出現在 Model 下拉選單，選單旁邊會說明原因。登入狀態讀不懂時記為「不明」，不擋使用。
- Claude 桌面版附帶的 CLI 放在帶版本號的資料夾（`%APPDATA%\Claude\claude-code\<版本>\` 或 Microsoft Store 版的 `%LOCALAPPDATA%\Claude-Data\<套件資料夾>\claude-code\<版本>\<hash>\`），app 用列目錄找、取最新版本；這個資料夾結構是 Claude 桌面版的內部實作，將來改動時只會找不到，不會壞掉（仍可用 `AWG_CLAUDE_PATH` 指定）。
- 啟動後 Claude 的模型清單約 8 秒才出現（Codex 約 3 秒），這段時間模型選單只有 Codex 的選項。
- 圖示（T061）：`assets/icon.ico`（16、24、32、48、64、128、256 像素，PNG 壓縮）與 `assets/icon.png`（512）是專案自己的圖示，放在有追蹤的 `assets/`（`build-resources/` 被 `.gitignore` 排除，不能放）。`electron-builder.yml` 的 `win.icon`（exe、捷徑、工作列）、`nsis.installerIcon`、`nsis.uninstallerIcon` 都指向它；`files` 也帶上 `assets/icon.ico`，視窗（`BrowserWindow.icon`，`app/main/window-options.ts` 的 `WINDOW_ICON_RELATIVE`）開發與安裝版讀同一個檔案。打包不再出現「default Electron icon is used」。`npm run pack` 之後 exe 的版本資訊是 electron-builder 填的（2026-11-05 實測 `release\win-unpacked\AgentWorkflowGui.exe`：`CompanyName` firewings2515、`FileDescription` 與 `ProductName` AgentWorkflowGui、`LegalCopyright` Copyright 2026 firewings2515、`FileVersion` 0.1.0、`ProductVersion` 0.1.0.0）：`FileVersion` 0.1.0、`ProductVersion` 0.1.0.0、`ProductName` 與 `FileDescription` 為 `AgentWorkflowGui`、`LegalCopyright` 為 Copyright 2026 firewings2515；`CompanyName` 取自 `package.json` 的 `author`（預設 `firewings2515`，發行前可以改成要顯示的名稱）。
- 安裝／解除安裝只測過靜默模式（`/S`）與 per-user；沒有測過互動式安裝畫面，也沒有測過套用 AppLocker／WDAC 的企業環境。
- Claude 與 Codex 的 native home（`~/.claude`、`~/.codex`）由各自的 CLI 管理，解除安裝不會清理它們。

## 7. 發行前檢查清單

1. `npm ci`，`npm run lint`、`npm run typecheck`、`npx vitest run --maxWorkers=4`、`npm run build` 都通過。
2. `npm run dist`，確認 `release\` 內有安裝檔，`app.asar.unpacked` 內有 koffi、**沒有** claude.exe。
3. 在已安裝並登入 Claude Code 與 Codex 的 Windows 使用者帳號安裝（可用靜默安裝到暫存資料夾），以暫存的 `--user-data-dir` 啟動，「設定 → Runtime」兩張卡都是「可用」，跑 Claude 與 Codex 各一個 turn，正常退出（R-14）後沒有殘留程序。
4. 解除安裝後 `%APPDATA%\AgentWorkflowGui` 仍在、開始功能表捷徑與 `HKCU` 解除安裝項目已移除。
5. 對外發行前，確認 Anthropic 的條款允許隨附 SDK 的 JavaScript（第 5 節；claude.exe 已不隨附）。
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

## 9. T045 驗證紀錄

2026-11-01，Windows 10 19045 x64，已安裝版（commit `31ccab8` 的內容；`AgentWorkflowGui-Setup-0.1.0-x64.exe`，115,495,579 位元組，SHA-256 `F77B06B3AF445DED94C8A3860735382F88FE9F477C01C0F7D9CEFBF319569FD6`，T044 是 218 MB）。`/S /D=<mkdtemp>\app` 安裝、暫存 `--user-data-dir`；安裝 1 次（13 秒、沒有提權）、解除安裝 1 次（9 秒）、Electron 啟動 3 次（第 1 次因 live 腳本的 agent schemaVersion 過舊而在建立 session 前停下）、Claude turn 1、Codex turn 0。

- 安裝後 `resources\app.asar.unpacked` 內沒有 `claude.exe`，exe 的 `CompanyName` 是 `firewings2515`。
- **用本機 Claude Code**：Snapshot 的 `runtimes` 為 Claude `available` 2.1.309（`C:\Users\capri\.local\bin\claude.exe`，來源 PATH，訂閱，13 個模型）、Codex `available` 0.160.0（來源 PATH，訂閱，10 個模型）。Claude（haiku）1 個 turn completed（`observedModel` `claude-haiku-5-5`）；實際啟動的 `claude.exe` 是 `C:\Users\capri\.local\bin\claude.exe`（PID 43020，父行程是這次的 Electron），不是安裝資料夾內的檔案。`runtime.detect` 回 ok，狀態不變。關閉 735 ms，沒有殘留程序。
- **找不到 Claude 時**（`AWG_CLAUDE_PATH` 指向不存在的檔案）：Snapshot 顯示 Claude `not-installed`（`detail` 說明環境變數的檔案不存在）、`modelCount` 0、模型選單沒有 Claude；Codex `available`、10 個模型。「`session.create` 回 `runtime_unavailable`」沒有在安裝版上實測（腳本沿用 run1 的 userData，`agent.save` 回 `stale_revision`，在建立 session 前就停了），改由單元測試 `app/main/backend-runtimes.test.ts` 的「Claude unavailable: session.create(claude) is refused with runtime_unavailable, and Codex can still be created」涵蓋（Claude 不可用、Codex 可用：建立 Claude session 回 `runtime_unavailable`，建立 Codex session 成功）。審查第 1 輪指出本紀錄原本引用的測試方向相反（Codex 不可用、Claude 可用），已補上這個測試。
- 解除安裝後：安裝資料夾、`HKCU` 項目、開始功能表捷徑都已移除；暫存 userData 的 `awg.sqlite` 仍在；沒有殘留程序。
- 兩次 run1 結束時 `owned_process` 各有一筆沒有 `endedAt` 的 `runtime-host`，對應的程序都已不存在；來源（探測用的行程記錄）沒有追查。

**沒有驗證**：Claude 桌面版附帶 CLI 的搜尋（本機的 Store 版沒有該資料夾，只有單元測試）、「版本太舊」與「未登入」在安裝版上的畫面（單元測試涵蓋）、設定頁的截圖（只用 DOM 與 CSS 量測；1024x768、深色與淺色）、Windows 11。
