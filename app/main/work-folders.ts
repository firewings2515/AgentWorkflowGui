// The work folders' file system on Windows (T048, core/ports/work-folders.ts): one folder made at a time, never its
// parents except for the location itself. It removes nothing (T048 r2): a folder made once stays.
import { mkdirSync, readdirSync } from 'node:fs';
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
    mkdirSync(folder, { recursive: true });
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
};
