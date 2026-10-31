// Shape of the API the preload script exposes as `window.awg`.
// Type-only imports, so the renderer can import it without pulling in Electron.
import type { z } from 'zod';
import type { Command, CommandResult, EventEnvelope, FolderRequest, FolderResult, Snapshot } from '../../contracts';

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
  /** Subscribes to pushed events; the returned function cancels the subscription. */
  onEvent(listener: (envelope: EventEnvelope) => void): () => void;
  /**
   * Folder dialog and "show in the file explorer" (C-24). Present in the app; optional so a renderer
   * without it (tests, an older preload) disables the folder buttons. Never rejects for a bad request.
   */
  folders?: { request(request: FolderRequest): Promise<FolderResult> };
}
