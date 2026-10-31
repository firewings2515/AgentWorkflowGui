// T036 idle supervisor on the real SQLite repositories and delivery store, with the same session service, fake
// runtimes and cases as the memory run in core/supervisor/supervisor.test.ts.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach } from 'vitest';
import { createRepositories, openDatabase, SqliteDeliveryStore } from '../../adapters/storage';
import { supervisorCases } from '../../core/supervisor/testing/cases';
import { supWorldOn } from '../../core/supervisor/testing/harness';

const opened: { db: DatabaseSync; dir: string }[] = [];
afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

supervisorCases('SQLite', (o) => {
  const dir = mkdtempSync(join(tmpdir(), 'awg-t036-'));
  const db = openDatabase(join(dir, 'awg.sqlite'));
  opened.push({ db, dir });
  return supWorldOn(createRepositories(db), new SqliteDeliveryStore(db), o);
});
