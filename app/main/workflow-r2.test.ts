// T024 review r2 reproductions on the real SQLite repositories and delivery store (T022), with the same
// session service, engine and fake runtimes as the memory run in core/workflow/review-r2.test.ts.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach } from 'vitest';
import { createRepositories, openDatabase, SqliteDeliveryStore } from '../../adapters/storage';
import { worldOn } from '../../core/workflow/testing/harness';
import { r2Cases } from '../../core/workflow/testing/r2-cases';

const opened: { db: DatabaseSync; dir: string }[] = [];
afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

r2Cases('SQLite', (workflow) => {
  const dir = mkdtempSync(join(tmpdir(), 'awg-t024-r2-'));
  const db = openDatabase(join(dir, 'awg.sqlite'));
  opened.push({ db, dir });
  return worldOn(createRepositories(db), new SqliteDeliveryStore(db), workflow);
});
