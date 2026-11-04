// Folder helpers for the v0.4 shell: recent folders from the sessions (U2_PLAN §2: no backend list) and the
// system folder picker (C-24) as a function, for the composer's folder chip.
import { FolderResult, RequestId } from '../../../../contracts';
import type { FolderTarget, Snapshot } from '../../../../contracts';

const normalize = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const AUTO_NAME = /^\d{4}-\d{2}-\d{2}-\d{3,}$/;

/** Where folders made for a session without one go (Q-1): the preference, else the default location. */
export const workFolderRoot = (snapshot: Snapshot) => snapshot.preferences.workFolderRoot ?? snapshot.defaultWorkFolderRoot;

/** A folder the main process made by itself (Q-2): `YYYY-MM-DD-NNN` directly inside the work folder root. */
export function isAutoFolder(path: string, root: string): boolean {
  const folder = normalize(path);
  const base = normalize(root);
  const name = folder.slice(folder.lastIndexOf('/') + 1);
  return folder === `${base}/${name}` && AUTO_NAME.test(name);
}

/** Up to five folders of recent sessions, newest first, without duplicates and without auto-created folders. */
export function recentFolders(snapshot: Snapshot, limit = 5): string[] {
  const root = workFolderRoot(snapshot);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const session of [...snapshot.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    const key = normalize(session.cwd);
    if (!session.cwd || seen.has(key) || isAutoFolder(session.cwd, root)) continue;
    seen.add(key);
    result.push(session.cwd);
    if (result.length >= limit) break;
  }
  return result;
}

export type FolderOutcome = { kind: 'picked'; path: string } | { kind: 'cancelled' } | { kind: 'opened' } | { kind: 'failed'; message: string };

/** One folder request through the optional C-24 bridge; the reply must match the request ID. Error prose is never shown. */
export async function requestFolder(target?: FolderTarget): Promise<FolderOutcome> {
  const bridge = window.awg?.folders;
  if (!bridge) return { kind: 'failed', message: '資料夾服務尚未接入。' };
  const requestId = RequestId.parse(crypto.randomUUID());
  try {
    const result = FolderResult.parse(await bridge.request(target ? { type: 'folder.open', requestId, target } : { type: 'folder.pick', requestId }));
    if (result.requestId !== requestId) return { kind: 'failed', message: '資料夾回覆無法核對，請重新操作。' };
    if (!result.ok) return { kind: 'failed', message: ({ not_found: '找不到資料夾。', invalid_request: '資料夾要求無效。', internal_error: '無法開啟資料夾視窗。' })[result.code] };
    if (!target && typeof result.path === 'string') return { kind: 'picked', path: result.path };
    return target ? { kind: 'opened' } : { kind: 'cancelled' };
  } catch { return { kind: 'failed', message: '無法取得資料夾操作結果。' }; }
}
