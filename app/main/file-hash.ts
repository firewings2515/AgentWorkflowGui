// The file hash the same-folder locks compare (T033, R-07). Read synchronously on purpose: the lock is
// taken right after, with nothing able to run in between (KNOWLEDGE §5).
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { FileState } from '../../core/locks';

const MISSING = new Set(['ENOENT', 'ENOTDIR']);

/**
 * Files above this are not read (16 MiB: the main process would stall on each write and watcher event).
 * Such a file still locks; it only gets no read check and no unlocked-write check.
 */
export const MAX_HASHED_BYTES = 16 * 1024 * 1024;

export interface HashFs {
  size(path: string): { size: number; isFile: boolean };
  read(path: string): Buffer;
}

const nodeFs: HashFs = {
  size: (path) => {
    const s = statSync(path);
    return { size: s.size, isFile: s.isFile() };
  },
  read: (path) => readFileSync(path),
};

export const hashFile = (path: string, fs: HashFs = nodeFs, max = MAX_HASHED_BYTES): FileState => {
  try {
    const { size, isFile } = fs.size(path);
    // A folder, or too large to read on the main process.
    if (!isFile || size > max) return 'unreadable';
    return `sha256:${createHash('sha256').update(fs.read(path)).digest('hex')}`;
  } catch (error) {
    // A file opened exclusively, no access: nothing to compare.
    return MISSING.has((error as NodeJS.ErrnoException).code ?? '') ? 'missing' : 'unreadable';
  }
};

/** A timer that never keeps the process alive; returns what cancels it. */
export const setTimer = (ms: number, fn: () => void): (() => void) => {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return () => clearTimeout(timer);
};
