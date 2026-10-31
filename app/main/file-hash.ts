// The file hash the same-folder locks compare (T033, R-07). Read synchronously on purpose: the lock is
// taken right after, with nothing able to run in between (KNOWLEDGE §5).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FileState } from '../../core/locks';

const MISSING = new Set(['ENOENT', 'ENOTDIR']);

export const hashFile = (path: string, read: (path: string) => Buffer = readFileSync): FileState => {
  try {
    return `sha256:${createHash('sha256').update(read(path)).digest('hex')}`;
  } catch (error) {
    // A folder, a file opened exclusively, no access: nothing to compare.
    return MISSING.has((error as NodeJS.ErrnoException).code ?? '') ? 'missing' : 'unreadable';
  }
};

/** A timer that never keeps the process alive; returns what cancels it. */
export const setTimer = (ms: number, fn: () => void): (() => void) => {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return () => clearTimeout(timer);
};
