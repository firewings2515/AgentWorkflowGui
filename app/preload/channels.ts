// IPC channel names shared by the preload script and the main process. No imports, so the sandboxed
// preload bundle stays small.

export const APP_INFO_CHANNEL = 'app:get-info';

/** Renderer -> main: load the current Snapshot (invoke). */
export const SNAPSHOT_CHANNEL = 'app:snapshot';

/** Renderer -> main: load the current Snapshot with the number of this read, a SnapshotRead (invoke, T040 r3). */
export const SNAPSHOT_READ_CHANNEL = 'app:snapshot-read';

/** Renderer -> main: what the renderer did with what it was sent, a WindowReport (send, T040 r3). */
export const WINDOW_REPORT_CHANNEL = 'app:window-report';

/** Renderer -> main: run one Command, answered with a CommandResult (invoke). */
export const COMMAND_CHANNEL = 'app:command';

/** Main -> renderer: one EventEnvelope per push (send). Before T040; the main process now sends batches. */
export const EVENT_CHANNEL = 'app:event';

/** Main -> renderer: one EventBatch (C-27) per push (send). */
export const BATCH_CHANNEL = 'app:batch';

/** Renderer -> main: the `toSeq` of a batch the renderer's listener has taken (send), for flow control (T040). */
export const BATCH_ACK_CHANNEL = 'app:batch-ack';

/** Renderer -> main: one QueryRequest (C-26, C-28), answered with a QueryResult (invoke). */
export const QUERY_CHANNEL = 'app:query';

/** Renderer -> main: one FolderRequest (C-24), answered with a FolderResult (invoke). */
export const FOLDER_CHANNEL = 'app:folder';
