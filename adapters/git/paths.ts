// Path comparison and `git worktree list --porcelain -z` parsing (T030). git reports `C:/a/b`, the caller has
// `C:\a\b` or a short 8.3 / junction spelling of it: both sides are made canonical before they are compared.
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** The real path of `path`; a path that does not exist (yet, or any more) is its nearest existing parent's real path plus the rest. */
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonicalPath(parent), basename(absolute));
  }
}

const key = (path: string): string => canonicalPath(path).replace(/^\\\\\?\\/, '').replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();

export const samePath = (a: string, b: string): boolean => key(a) === key(b);

/** `child` is below `parent` (not the same folder). */
export const isInside = (parent: string, child: string): boolean => key(child).startsWith(`${key(parent)}/`);

export interface WorktreeEntry {
  path: string;
  head: string | undefined;
  /** The full ref, `refs/heads/<name>`; undefined when detached. */
  branch: string | undefined;
  /** Registered, but its folder is gone. */
  prunable: boolean;
  locked: boolean;
}

/** `git worktree list --porcelain -z`: NUL-terminated fields, an empty field ends each entry. The first entry is the main checkout. */
export function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  for (const field of output.split('\0')) {
    if (field === '') {
      current = undefined;
      continue;
    }
    const space = field.indexOf(' ');
    const name = space < 0 ? field : field.slice(0, space);
    const value = space < 0 ? '' : field.slice(space + 1);
    if (name === 'worktree') {
      current = { path: value, head: undefined, branch: undefined, prunable: false, locked: false };
      entries.push(current);
    } else if (current !== undefined) {
      if (name === 'HEAD') current.head = value;
      else if (name === 'branch') current.branch = value;
      else if (name === 'prunable') current.prunable = true;
      else if (name === 'locked') current.locked = true;
    }
  }
  return entries;
}

/** Git's own message made safe to show: no credentials in a URL, one bounded block of text. */
export function sanitizeDetail(text: string): string {
  const clean = text
    .replace(/:\/\/[^/@\s]+@/g, '://')
    .replace(/\s+$/g, '')
    .trim();
  return clean.length > 2000 ? `${clean.slice(0, 2000)}...` : clean;
}
