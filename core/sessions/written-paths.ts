// What each session wrote, for the CR-1 rule that running a script the session just wrote goes to the
// user (PolicyContext.writtenPaths). Three sources, all over-estimates, so the only cost is more requests
// at root (T017 plan §4, decided by the main session):
//   1. paths of the session's file-change items;
//   2. paths of the command and file-change requests it was allowed;
//   3. files that changed in its workspace while its runtime ran (the main process watches the folder),
//      so a file written by a command counts too. `.git` counts (hooks).
// Source 3 is aggregated: once a folder below the workspace holds more than `folderLimit` changed files,
// the folder itself is recorded (a written folder covers everything in it). Past `totalLimit` entries, or
// when the watch fails, the whole workspace counts as written (fail closed).

/** Windows paths compare case-insensitively (ASCII) and with either slash. */
const keyOf = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** Drive-letter, UNC and rooted paths are absolute; anything else is relative to `cwd`. */
export const isAbsolutePath = (path: string): boolean => /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]/.test(path);

export const absolutePath = (path: string, cwd: string): string => (isAbsolutePath(path) ? path : `${cwd.replace(/[\\/]+$/, '')}\\${path}`);

interface Watched {
  root: string;
  /** Files recorded one by one, by key. */
  files: Map<string, string>;
  /** Folders recorded as a whole, by key. */
  folders: Map<string, string>;
  /** Changed files below each folder key (recursive), for folders not yet recorded whole. */
  counts: Map<string, number>;
  whole: boolean;
}

interface Written {
  exact: Map<string, string>;
  watched?: Watched;
}

export interface WrittenPathsOptions {
  folderLimit?: number;
  totalLimit?: number;
}

export class WrittenPaths {
  private readonly sessions = new Map<string, Written>();
  private readonly folderLimit: number;
  private readonly totalLimit: number;

  constructor(options: WrittenPathsOptions = {}) {
    this.folderLimit = options.folderLimit ?? 200;
    this.totalLimit = options.totalLimit ?? 5000;
  }

  /** Sources 1 and 2: exact paths, relative ones taken against `cwd`. */
  add(sessionId: string, paths: readonly string[], cwd: string): void {
    const written = this.of(sessionId);
    for (const p of paths) {
      const abs = absolutePath(p, cwd);
      written.exact.set(keyOf(abs), abs);
    }
  }

  /** Source 3: a file that changed in the session's workspace `root`. Changes outside it are ignored. */
  changed(sessionId: string, root: string, path: string): void {
    const watched = this.watchedOf(sessionId, root);
    if (watched.whole) return;
    const rootKey = keyOf(root);
    const key = keyOf(path);
    if (!key.startsWith(`${rootKey}/`)) return;
    const parts = key.slice(rootKey.length + 1).split('/');
    const original = path.replace(/[\\/]+$/, '');
    // Folders below the root, outermost first, with the original spelling.
    const folders: [string, string][] = [];
    for (let depth = 1; depth < parts.length; depth++) {
      const folderKey = `${rootKey}/${parts.slice(0, depth).join('/')}`;
      folders.push([folderKey, original.slice(0, original.length - (key.length - folderKey.length))]);
    }
    if (folders.some(([k]) => watched.folders.has(k)) || watched.files.has(key)) return;
    watched.files.set(key, original);
    for (const [folderKey] of folders) watched.counts.set(folderKey, (watched.counts.get(folderKey) ?? 0) + 1);
    const full = folders.find(([k]) => (watched.counts.get(k) ?? 0) > this.folderLimit);
    if (full !== undefined) this.collapse(watched, full[0], full[1]);
    if (watched.files.size + watched.folders.size > this.totalLimit) this.wholeWorkspace(sessionId, root);
  }

  /** The watch failed or cannot run: the whole workspace counts as written from now on. */
  wholeWorkspace(sessionId: string, root: string): void {
    const watched = this.watchedOf(sessionId, root);
    watched.whole = true;
    watched.files.clear();
    watched.folders.clear();
    watched.counts.clear();
  }

  list(sessionId: string): string[] {
    const written = this.sessions.get(sessionId);
    if (written === undefined) return [];
    const { watched } = written;
    return [
      ...written.exact.values(),
      ...(watched === undefined ? [] : watched.whole ? [watched.root] : [...watched.folders.values(), ...watched.files.values()]),
    ];
  }

  private collapse(watched: Watched, folderKey: string, folder: string): void {
    const inside = (k: string) => k.startsWith(`${folderKey}/`);
    for (const k of [...watched.files.keys()]) if (inside(k)) watched.files.delete(k);
    for (const k of [...watched.folders.keys()]) if (inside(k)) watched.folders.delete(k);
    for (const k of [...watched.counts.keys()]) if (k === folderKey || inside(k)) watched.counts.delete(k);
    watched.folders.set(folderKey, folder);
  }

  private of(sessionId: string): Written {
    let written = this.sessions.get(sessionId);
    if (written === undefined) {
      written = { exact: new Map() };
      this.sessions.set(sessionId, written);
    }
    return written;
  }

  private watchedOf(sessionId: string, root: string): Watched {
    const written = this.of(sessionId);
    written.watched ??= {
      root,
      files: new Map(),
      folders: new Map(),
      counts: new Map(),
      whole: false,
    };
    return written.watched;
  }
}
