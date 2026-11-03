// T048 on the real SQLite repositories and delivery store, with real folders in a temporary directory and the main
// process's own folder code (work-folders.ts, real-path.ts): the same cases as the memory run in core/sessions/t048.test.ts.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach } from 'vitest';
import { createRepositories, openDatabase, SqliteDeliveryStore } from '../../adapters/storage';
import { t048SessionCases } from '../../core/sessions/testing/t048-cases';
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

t048SessionCases('SQLite and real folders', () => {
  const dir = mkdtempSync(join(tmpdir(), 'awg-t048-'));
  const db = openDatabase(join(dir, 'awg.sqlite'));
  opened.push({ db, dir });
  return {
    repositories: createRepositories(db),
    store: new SqliteDeliveryStore(db),
    folders: {
      fs: nodeWorkFolderFs,
      location: join(dir, 'AgentWorkflowGui'),
      elsewhere: join(dir, 'elsewhere'),
      exists: (path) => existsSync(path),
      putFile: (folder, name) => writeFileSync(join(folder, name), 'x'),
      makeForeign: (path) => mkdirSync(path, { recursive: true }),
      realPath: (path) => resolveRealPath(path),
    },
  };
});
