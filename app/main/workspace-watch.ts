// Watches each open session's workspace (T017 plan §4, writtenPaths source 3): every file that changes in
// it while the session's runtime runs counts as written by the session, `.git` included. A watch that
// cannot start or fails later makes the whole workspace count as written (fail closed).
import { type FSWatcher, watch as fsWatch } from 'node:fs';
import { join } from 'node:path';
import type { SessionId } from '../../contracts';

export interface WorkspaceSink {
  changed(sessionId: SessionId, root: string, path: string): void;
  failed(sessionId: SessionId, root: string): void;
}

export type WatchFn = (root: string, listener: (event: string, filename: string | null) => void) => Pick<FSWatcher, 'close' | 'on'>;

const defaultWatch: WatchFn = (root, listener) => fsWatch(root, { recursive: true, persistent: false }, (event, filename) => listener(event, filename));

export class WorkspaceWatchers {
  private readonly watchers = new Map<SessionId, Pick<FSWatcher, 'close'>>();

  constructor(
    private readonly sink: WorkspaceSink,
    private readonly log: (message: string) => void,
    private readonly watch: WatchFn = defaultWatch,
  ) {}

  start(sessionId: SessionId, root: string): void {
    if (this.watchers.has(sessionId)) return;
    const fail = (why: string) => {
      // The reason only: the path is the user's own folder, but nothing more is needed to act on it.
      this.log(`[watch] watching the workspace of ${sessionId} ${why}; every file in it now counts as written`);
      this.sink.failed(sessionId, root);
      this.stop(sessionId);
    };
    try {
      const watcher = this.watch(root, (_event, filename) => {
        // No name means the change cannot be placed: count the whole workspace.
        if (filename === null || filename === '') fail('lost a change');
        else this.sink.changed(sessionId, root, join(root, filename));
      });
      watcher.on('error', (error: NodeJS.ErrnoException) => fail(`failed (${error.code ?? error.name})`));
      this.watchers.set(sessionId, watcher);
    } catch (error) {
      fail(`could not start (${(error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.name : 'unknown')})`);
    }
  }

  stop(sessionId: SessionId): void {
    const watcher = this.watchers.get(sessionId);
    this.watchers.delete(sessionId);
    try {
      watcher?.close();
    } catch {
      // Closing a failed watcher may throw; it is gone either way.
    }
  }

  stopAll(): void {
    for (const sessionId of [...this.watchers.keys()]) this.stop(sessionId);
  }
}
