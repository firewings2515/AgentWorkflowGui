// Shape of the API the preload script exposes as `window.awg`.
// Type-only imports, so the renderer can import it without pulling in Electron.
import type { z } from 'zod';
import type { Command, CommandResult, EventBatch, EventEnvelope, FolderRequest, FolderResult, QueryRequest, QueryResult, Snapshot } from '../../contracts';

export interface AppInfo {
  readonly name: string;
  readonly version: string;
}

/** A command as the renderer writes it, before defaults (e.g. `attachments`) are filled in. */
export type CommandInput = z.input<typeof Command>;

export interface AwgBridge {
  getAppInfo(): Promise<AppInfo>;
  /** Loads the current Snapshot. Apply only envelopes whose `seq` is larger than the Snapshot's. */
  snapshot(): Promise<Snapshot>;
  /** Never rejects for a bad command: the result carries `invalid_request` and the other codes. */
  send(command: CommandInput): Promise<CommandResult>;
  /**
   * Subscribes to pushed events, one envelope at a time (unpacked from the batches); the returned function cancels the
   * subscription. A delta merged into a later one leaves its seq unused, so prefer `onBatch`.
   */
  onEvent(listener: (envelope: EventEnvelope) => void): () => void;
  /**
   * Folder dialog and "show in the file explorer" (C-24). Present in the app; optional so a renderer
   * without it (tests, an older preload) disables the folder buttons. Never rejects for a bad request.
   */
  folders?: { request(request: FolderRequest): Promise<FolderResult> };
  /**
   * Brings the app window to the front (a clicked notification, T055). Takes no argument: the main process picks its own
   * window. Present in the app; optional so a renderer without it (tests, an older preload) simply does not bring it forward.
   */
  focusWindow?(): Promise<void>;
}

/** One Snapshot read (T040 r3): `read` names it, so the renderer can say it took this one and no other. */
export interface SnapshotRead {
  readonly read: number;
  readonly snapshot: Snapshot;
}

/**
 * What the renderer did with what it was sent (T040 r3), so the main process knows what reached it instead of guessing:
 * `applied`, it applied the batch ending at `toSeq` (not held back, not dropped); `adopted`, it took the Snapshot of
 * read `read` and applied what it held back after it, up to `seq`.
 */
export type WindowReport = { readonly kind: 'applied'; readonly toSeq: number } | { readonly kind: 'adopted'; readonly read: number; readonly seq: number };

/** What the preload script exposes (T040): the bridge plus batches and queries, which the renderer treats as optional. */
export interface AppBridge extends AwgBridge {
  /**
   * Subscribes to pushed event batches (C-27): consecutive, `fromSeq` right after the last batch's `toSeq`. Each batch is
   * acknowledged to the main process once the listener returned (flow control).
   */
  onBatch(listener: (batch: EventBatch) => void): () => void;
  /** Read-only queries (C-26, C-28): history pages, backups. Never rejects for a bad request. */
  query(request: QueryRequest): Promise<QueryResult>;
  /** Loads the current Snapshot, named by the number of this read (T040 r3). */
  readSnapshot(): Promise<SnapshotRead>;
  /** Tells the main process what the renderer did with a batch or a Snapshot read (T040 r3). */
  report(report: WindowReport): void;
}
