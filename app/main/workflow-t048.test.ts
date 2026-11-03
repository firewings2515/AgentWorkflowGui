// T048 a run's two folders on the real SQLite repositories and delivery store, with the same session service, engine,
// memory git and folders as the memory run in core/workflow/t048.test.ts.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach } from 'vitest';
import { createRepositories, openDatabase, SqliteDeliveryStore } from '../../adapters/storage';
import { worldOn } from '../../core/workflow/testing/harness';
import { t048WorkflowCases } from '../../core/workflow/testing/t048-cases';

const opened: { db: DatabaseSync; dir: string }[] = [];
afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

t048WorkflowCases('SQLite', (workflow, extra) => {
  const dir = mkdtempSync(join(tmpdir(), 'awg-t048-'));
  const db = openDatabase(join(dir, 'awg.sqlite'));
  opened.push({ db, dir });
  return worldOn(createRepositories(db), new SqliteDeliveryStore(db), workflow, undefined, undefined, extra);
});
