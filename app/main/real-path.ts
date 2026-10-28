// PolicyContext.resolveRealPath on Windows (T017, R-08): junctions and symbolic links in the part of the
// path that exists are resolved by the file system; a tail that does not exist yet is kept as written.
// Anything that cannot be confirmed is null, which the policy treats as `unrecognised`.
import { realpathSync } from 'node:fs';
import { win32 } from 'node:path';

const MISSING = new Set(['ENOENT', 'ENOTDIR']);

export const resolveRealPath = (absolutePath: string): string | null => {
  // Drive and UNC paths only: device paths (\\?\, \\.\) skip the normalisation the policy relies on.
  if (!/^(?:[A-Za-z]:[\\/]|\\\\[^\\?.])/.test(absolutePath)) return null;
  const tail: string[] = [];
  let existing = absolutePath;
  for (;;) {
    try {
      const real = realpathSync.native(existing);
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
