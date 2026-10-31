// IPC channel names shared by the preload script and the main process. No imports, so the sandboxed
// preload bundle stays small.
export const APP_INFO_CHANNEL = 'app:get-info';
/** Renderer -> main: load the current Snapshot (invoke). */
export const SNAPSHOT_CHANNEL = 'app:snapshot';
/** Renderer -> main: run one Command, answered with a CommandResult (invoke). */
export const COMMAND_CHANNEL = 'app:command';
/** Main -> renderer: one EventEnvelope per push (send). */
export const EVENT_CHANNEL = 'app:event';
/** Renderer -> main: one FolderRequest (C-24), answered with a FolderResult (invoke). */
export const FOLDER_CHANNEL = 'app:folder';
