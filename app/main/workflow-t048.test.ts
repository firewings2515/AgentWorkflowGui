// T048 a run's two folders on the real SQLite repositories and delivery store, with real work folders in a temporary
// directory (the main process's own folder code), and the same session service, engine and memory git as the memory
// run in core/workflow/t048.test.ts.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach } from 'vitest';
import { createRepositories, openDatabase, SqliteDeliveryStore } from '../../adapters/storage';
import { worldOn } from '../../core/workflow/testing/harness';
import { memoryRealPath, t048WorkflowCases } from '../../core/workflow/testing/t048-cases';
import { resolveRealPath } from './real-path';
import { nodeWorkFolderFs } from './work-folders';

const opened: { db: DatabaseSync; dir: string }[] = [];
afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.close();
    // Only the temporary directory this test made.
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The temporary directory of the case being set up: its folders first, then its database in it. */
let current: string | undefined;

t048WorkflowCases(
  'SQLite and real work folders',
  (workflow, extra) => {
    const dir = current ?? mkdtempSync(join(tmpdir(), 'awg-t048-'));
    current = undefined;
    const db = openDatabase(join(dir, 'awg.sqlite'));
    opened.push({ db, dir });
    return worldOn(createRepositories(db), new SqliteDeliveryStore(db), workflow, undefined, undefined, extra);
  },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'awg-t048-'));
    current = dir;
    const inside = (path: string) => path.toLowerCase().startsWith(dir.toLowerCase());
    return {
      fs: nodeWorkFolderFs,
      location: join(dir, 'AgentWorkflowGui'),
      elsewhere: join(dir, 'elsewhere'),
      exists: (path) => existsSync(path),
      makeForeign: (path) => void mkdirSync(path, { recursive: true }),
      // Real folders here; the project is the memory git's.
      realPath: (path) => (inside(path) ? resolveRealPath(path) : memoryRealPath(path)),
    };
  },
);
