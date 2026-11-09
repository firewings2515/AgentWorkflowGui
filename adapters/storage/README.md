# Storage v0.7（T038）

T040 在啟動時先 `await openStorage(databasePath)`，再用回傳的 `db` 建立
`createRepositories(db)`／`SqliteDeliveryStore(db)`。回傳值另外包含：

- `report: AdapterStartReport`：相容 `StorageStartReport`，另含 `backupFailures`（操作及安全錯誤代碼）、
  `catalogRecovered` 與 `failedMigrationVersion`（僅版本號）。daily／prune 失敗不阻止啟動。
- `health: StorageHealth`：`state()` 與 `onReadOnly()`；磁碟滿後不會在同次執行中恢復可寫。
- `backups: BackupStore`：供備份清單、下次啟動還原與取消使用。
- `close()`：關閉主資料庫與備份 catalog；呼叫端先停止存取。

`openDatabase` 保留既有的低階行為（直接 migrate、失敗拋出）；正式啟動應改用
`openStorage` 才包含備份及唯讀流程。本任務沒有修改 main 接線。

備份只有 app 的 SQLite 資料，不讀 runtime home 或登入憑證。檔案放在主資料庫同層的
`backups/`，使用 `VACUUM INTO` 包含 WAL 中已提交的內容；通過 `integrity_check`、
`foreign_key_check` 並 flush 後才登記。`catalog.sqlite` 獨立保存清單與待還原／失敗資訊。
即使主資料庫損壞，仍可獨立建立 `SqliteBackupStore` 讀取 catalog。
catalog 損壞會關閉連線、改名為 `.damaged-<時間>-<uuid>` 後重建；啟動時也會處理
`backup-<uuid>.sqlite` 孤立檔案：通過完整驗證後重新登記，確定損壞的孤立檔案才刪除。
孤立檔登記與還原驗證都要求檔案非空且含 `schema_migration` 表；空檔或沒有此表的孤立檔會刪除。
首次 migration 前的無 schema 快照仍可建立，但不會被視為可還原的 app 備份。
原 metadata 遺失時，重建項目以檔案修改時間、`pre-restore` 原因登記，避免誤判當天已做 daily。
清單只檢查檔案類型、存在與大小；完整驗證在建立、孤立檔登記、排程還原、套用前與 prune 選擇保留備份時進行。
若備份目錄不可用，report 記錄 catalog 失敗，備份清單為空且所有 catalog 寫入拒絕；
已在目前 schema 的主資料庫仍可使用。

每天依桌面本地日曆日備份一次；migration 前和還原前的備份不取代 daily。
還原在下一次啟動套用：先複製候選備份到 staging、驗證完整性與版本，再備份現況，
checkpoint 並關閉現有連線，最後以同目錄 rename 替換。rename 是提交點。
主資料庫打不開或完整性失敗時，改名保留原檔與 `-wal`／`-shm` 為 `.damaged-<時間>-<uuid>`，
再套用已驗證的備份；檢查主檔使用獨立副本，避免 SQLite 重建原 SHM。
啟動會清理精確符合 `.restore-<uuid>.sqlite` 及其 sidecar 命名的中斷暫存檔。
替換前失敗不改現況，catalog 保存安全的失敗代碼；不把檔案路徑或資料內容放進回報。
若主檔與候選備份都壞，保留主檔、記下 `lastRestoreFailure`，並拋出帶 `report` 的
`StorageOpenError`；所有連線關閉，不回傳一個聲稱可用的資料庫。
請勿在還原期間另外開啟主資料庫的連線。

`prune` 刪除 catalog 登記、嚴格超過 30 天的自有備份（含後來損壞的備份），並清掉檔案
已遺失的 catalog 列。未知檔案、較新備份、正等待還原的備份保留。
最新一份通過完整驗證的備份一律保留，即使已超過 30 天；daily 備份失敗的該次啟動跳過 prune。
選擇保留備份時若遇到非損壞類 I/O 錯誤，整次 prune 在刪檔前中止。

`readSnapshotData({ recentTurns: N })` 與 `conversations.page(sessionId, cursor, N)`
接受 1～500 個完整 turn；同時間用到達順序排序。沒有 turn 的紀錄依時間落頁，
早於第一個 turn 的紀錄放最舊頁；沒有任何 turn 時全數傳回。
Snapshot 另包含舊的 running turn（及其紀錄）、pending／held permission、未結束 native task。
歷史頁排除讀取當下仍開啟的上述紀錄，避免和 Snapshot 重複。
Cursor 綁定 repository 實例與 session，每個 session 各自保留最近 8 個；過期回 `invalid-cursor`，
須重新取得 Snapshot。重啟後同樣須重取；不得自行組裝。SQLite 分頁 statement 會重用。
若 migration 失敗而尚無分頁欄位，唯讀 Snapshot 回傳完整歷史。

磁碟滿在回滾後拋 `StorageWriteError('disk-full')`，後續寫入拋
`StorageReadOnlyError`；仍允許讀取以及透過獨立 catalog 排程／取消還原。
真正的提交前 I/O 失敗回 `StorageWriteError('io')`；約束違規、SQL 或 trigger 錯誤原樣拋出。
`StorageWriteError` 訊息是固定代碼，以非 enumerable 的 `cause` 保留原始錯誤供內部診斷。
非磁碟滿的 COMMIT 失敗保留既有 CR-2 `CommitUncertainError` 語意，不能假設已派送或重送。

故障實作只在 `testing/storage-faults.ts`。`new InjectedStorageFaults(db)` 可注入既有連線；
啟動測試可將未綁定的實例經 `openStorage(path, { hooks: faults })` 傳入。
慢磁碟以同步等待模擬同步 SQLite I/O；正式程式不建立故障實例。

## v0.8（T048）

migration v11 把 agent／workflow／project 與 instance 內 template 的 `schemaVersion` 從 0.7.0 改為 0.8.0；
session、preferences、instance 的新欄位都是選填（沒有 Agent、`autoTitle`、`workFolderRoot`、run 的
`workFolder`／`projectFolder`），所以舊的 body 不改。新表 `work_folder_claim` 記錄 GUI 自動建立的工作資料夾
屬於哪個 session（一個 session 一筆、一個路徑一筆，路徑不分大小寫比對）。claim 先寫、資料夾後建；啟動時
沒有對應 session（也沒有對應 run 的開始紀錄）的 claim 會刪掉，資料夾是空的才以非遞迴 rmdir 刪除。

## v0.9（T050）

migration v12 只把 agent／workflow／project 與 instance 內 template 的 `schemaVersion` 從 0.8.0 改為 0.9.0，
不加表、不改欄位。側欄釘選 `UiPreferences.pinned`（`chat` 是 session id、`workflow` 是 run id，各最多 50 個、
不重複）存在 preferences 的 body 裡，0.9 之前存的沒有這個欄位，讀成兩份空清單（`pinnedOf`）。`workflow.rename`
改 run 的 `title`，用 instance 原本的整份 compare-and-set 更新寫回 body。

## v0.10（T059）

migration v13 只把 agent／workflow／project 與 instance 內 template 的 `schemaVersion` 從 0.9.0 改為 0.10.0，
不加表、不改欄位、不加索引。封存標記 `archivedAt` 存在根 session（一般 session）與 instance 的 body 裡，
`autoArchiveDays` 存在 preferences 的 body 裡；0.10 之前存的都沒有這些欄位，讀成「未封存」、自動封存 14 天
（`autoArchiveDaysOf`）。instance 的 `archivedAt` 只允許在已結束的 run 上（規則 `instance.archived-ended`），
寫入時 `checkRecord` 也會擋。自動封存要的「最後訊息時間」用 `ConversationRepository.latestMessageMs`：沿既有的
`message_by_session (session_id, at_ms)` 從最新一筆往回找第一則使用者或助理、且不是子代理的訊息。備份是整個
資料庫檔，封存標記跟著一起備份與還原。

## v0.11（T063）

migration v14 把 agent／workflow／project 與 instance 內 template 的 `schemaVersion` 從 0.10.0 改為 0.11.0，
並加一張表 `app_marker (name, at)`：只寫一次、不刪除的標記（`MarkerRepository`）。`starter-offered` 表示起始範本
已經放過（或不需要放）：migration 時資料庫裡已經有任何 agent 或 workflow，就直接寫入，所以既有的安裝不會在啟動時
自動放入起始範本；空的資料庫不寫，下一次啟動放入一次後才寫。備份是整個資料庫檔，標記跟著一起備份與還原。
`workflow.delete` 用既有的 `DefinitionRepository.delete`（compare-and-set）；instance 的 body 本來就存整份範本，
刪掉範本不影響已結束的執行。

## v0.12（T070）

migration v15 只把 agent／workflow／project 與 instance 內 template 的 `schemaVersion` 從 0.11.0 改為 0.12.0，
不加表、不改欄位、不加索引、不動標記。範本庫的內建範本和它們的 Agent 是一般的定義（固定 ID），只在使用者從範本庫
加入時用 `seedDefinitions` 寫入；第一次啟動仍然只放起始範本。
