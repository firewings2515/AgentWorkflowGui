// Folder requests from the renderer (C-24): pick a folder with the native dialog, or show a folder the app
// already knows in the file explorer. A folder to open is named by what it belongs to (a session, a task, a
// project, the app's data), never by a path from the renderer, and is looked up in the current Snapshot.
import { FolderRequest, FolderResult, RequestId, type FolderTarget, type Snapshot } from '../../contracts';

export interface FolderDeps {
  snapshot(): Promise<Snapshot> | Snapshot;
  /** The folder holding the app's database (the `damaged` screen points at it). */
  dataFolder: string;
  /** The native folder dialog; the chosen folder, or null when cancelled. */
  pickFolder(title: string | undefined): Promise<string | null>;
  /** Shows the folder in the file explorer; an error message, or '' on success (Electron `shell.openPath`). */
  openPath(path: string): Promise<string>;
  /**
   * The real path of an existing folder, or undefined: a file is never handed to `openPath`, which would run it.
   * The real path is what is opened, so a link swapped after the check does not move it (T042 F2, r1-P1-3).
   */
  realFolder(path: string): string | undefined;
}

const requestIdOf = (raw: unknown): RequestId | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const parsed = RequestId.safeParse((raw as { requestId?: unknown }).requestId);
  return parsed.success ? parsed.data : null;
};

/** The known folder of a target, or undefined when the Snapshot has none. */
export const folderOf = (snapshot: Snapshot, target: FolderTarget, dataFolder: string): string | undefined => {
  switch (target.kind) {
    case 'session-cwd':
      return snapshot.sessions.find((s) => s.id === target.sessionId)?.cwd;
    case 'task-worktree':
      return snapshot.instances.find((i) => i.id === target.instanceId)?.tasks.find((t) => t.id === target.taskId)?.worktree?.path;
    case 'project':
      return snapshot.projects.find((p) => p.id === target.projectId)?.rootPath;
    case 'app-data':
      return dataFolder;
  }
};

/** Runs one folder request. Never throws: anything that goes wrong comes back as a failed FolderResult. */
export async function handleFolderRequest(raw: unknown, deps: FolderDeps): Promise<FolderResult> {
  const parsed = FolderRequest.safeParse(raw);
  if (!parsed.success) return { ok: false, requestId: requestIdOf(raw), code: 'invalid_request', message: 'Invalid folder request' };
  const request = parsed.data;
  const fail = (code: 'not_found' | 'internal_error', message: string): FolderResult => ({ ok: false, requestId: request.requestId, code, message });
  try {
    if (request.type === 'folder.pick') return { ok: true, requestId: request.requestId, path: await deps.pickFolder(request.title) };
    const path = folderOf(await deps.snapshot(), request.target, deps.dataFolder);
    const real = path === undefined ? undefined : deps.realFolder(path);
    if (real === undefined) return fail('not_found', 'The folder is not known, is not a folder or no longer exists');
    const error = await deps.openPath(real);
    return error === '' ? { ok: true, requestId: request.requestId } : fail('internal_error', 'The file explorer could not open the folder');
  } catch {
    return fail('internal_error', 'The folder request failed');
  }
}
