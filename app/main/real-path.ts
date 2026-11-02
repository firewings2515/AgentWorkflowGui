// PolicyContext.resolveRealPath on Windows (T017, R-08): junctions and symbolic links in the part of the
// path that exists are resolved by the file system; a tail that does not exist yet is kept as written.
// Anything that cannot be confirmed is null, which the policy treats as `unrecognised`.
import { realpathSync, statSync } from 'node:fs';
import { win32 } from 'node:path';

const MISSING = new Set(['ENOENT', 'ENOTDIR']);

/** `realpath` is the file system's (tests replace it). */
export const resolveRealPath = (absolutePath: string, realpath: (path: string) => string = realpathSync.native): string | null => {
  // Drive and UNC paths only, with either slash (the policy writes UNC as //server/share, r1-P2); device
  // paths (\\?\, \\.\, //?/, //./) skip the normalisation the policy relies on.
  if (!/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/?.])/.test(absolutePath)) return null;
  const tail: string[] = [];
  let existing = absolutePath.replace(/\//g, '\\');
  for (;;) {
    try {
      const real = realpath(existing);
      return tail.length === 0 ? real : win32.join(real, ...tail.reverse());
    } catch (error) {
      if (!MISSING.has((error as NodeJS.ErrnoException).code ?? '')) return null;
    }
    const name = win32.basename(existing);
    const parent = win32.dirname(existing);
    // `.` or `..` in a part that does not exist would move the path after the links were resolved.
    if (parent === existing || name === '' || name === '.' || name === '..') return null;
    tail.push(name);
    existing = parent;
  }
};

/** Whether a folder is there, as the file system says (T040 r1 P1-4); see `FolderState`. */
export type FolderState = 'exists' | 'missing' | 'unknown';

/**
 * A session's folder (C-30 `folder-missing`, R-06). `resolveRealPath` cannot tell: it keeps a tail that does not exist,
 * and is null for anything it cannot confirm. Here `missing` only when the file system says the path (or a part of it)
 * does not exist, or is not a folder; any other failure (access denied, a drive that does not answer) is `unknown`,
 * never reported as gone.
 */
export const folderState = (absolutePath: string, stat: (path: string) => { isDirectory(): boolean } = statSync): FolderState => {
  try {
    return stat(absolutePath).isDirectory() ? 'exists' : 'missing';
  } catch (error) {
    return MISSING.has((error as NodeJS.ErrnoException).code ?? '') ? 'missing' : 'unknown';
  }
};
