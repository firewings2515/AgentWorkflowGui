// The work folders' file system on Windows (T048, core/ports/work-folders.ts): one folder made at a time, never its
// parents except for the location itself, and only an empty folder removed (non-recursive rmdir), so nothing the
// user put in one is ever deleted.
import { mkdirSync, readdirSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { win32 } from 'node:path';
import type { WorkFolderFs } from '../../core/ports';

/** The default work folder location (Q-1): `%USERPROFILE%\AgentWorkflowGui`. Only the packaged app's start uses it. */
export const defaultWorkFolderRoot = (home: string = homedir()): string => win32.join(home, 'AgentWorkflowGui');

const code = (error: unknown) => (error as NodeJS.ErrnoException).code ?? '';

export const nodeWorkFolderFs: WorkFolderFs = {
  list(folder) {
    try {
      return readdirSync(folder);
    } catch (error) {
      if (code(error) === 'ENOENT') return [];
      throw error;
    }
  },
  makeTree(folder) {
    // The first folder it made, or undefined when all of them were there: the made ones are that one and below it.
    const first = mkdirSync(folder, { recursive: true });
    if (first === undefined) return [];
    const created = [first];
    const rest = win32.relative(first, folder);
    if (rest === '') return created;
    for (const part of rest.split(win32.sep)) created.push(win32.join(created.at(-1)!, part));
    return created;
  },
  make(folder) {
    try {
      mkdirSync(folder);
      return 'created';
    } catch (error) {
      if (code(error) === 'EEXIST') return 'exists';
      throw error;
    }
  },
  removeEmpty(folder) {
    try {
      rmdirSync(folder);
      return 'removed';
    } catch (error) {
      if (code(error) === 'ENOENT') return 'missing';
      if (code(error) === 'ENOTEMPTY' || code(error) === 'EEXIST' || code(error) === 'ENOTDIR') return 'not-empty';
      throw error;
    }
  },
};
