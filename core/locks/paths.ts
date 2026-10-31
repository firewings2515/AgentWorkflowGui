// How the lock table names a file (FileLock.path): absolute, links resolved, and case-folded with
// backslashes, as Windows compares paths. Every caller (hook, Codex approval, watcher, wait_for_file)
// goes through `lockPath`, so one file always has one key.
import { absolutePath } from '../sessions/written-paths';

/** Backslashes, no trailing separator, lower case (ASCII and beyond, like the NTFS default). */
export const foldPath = (path: string): string => path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

/**
 * The key of `path`, relative ones taken against `cwd`. `resolveRealPath` resolves the links in the part
 * that exists; when it cannot (null) the path is kept as written.
 */
export const lockPath = (path: string, cwd: string, resolveRealPath: (absolute: string) => string | null): string => {
  const absolute = absolutePath(path, cwd);
  return foldPath(resolveRealPath(absolute) ?? absolute);
};

/** Whether `path` is `root` or inside it; both already folded. */
export const isInside = (path: string, root: string): boolean => path === root || path.startsWith(`${root}\\`);

/**
 * Changes the watcher reports that are no one's work on a file: inside `.git`, and the temporary file
 * Claude's Edit writes before renaming it over the target (`<name>.tmp.<pid>.<id>`, SP-06 §4).
 */
export const isIgnoredChange = (path: string): boolean => /(^|\\)\.git(\\|$)/.test(path) || /\.tmp\.\d+\.[0-9a-z]+$/.test(path);
