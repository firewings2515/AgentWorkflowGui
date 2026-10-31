// T032 task pipeline on the real SQLite repositories and delivery store, with the same session service, engine,
// memory git and fake runtimes as the memory run in core/pipeline/pipeline.test.ts.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach } from 'vitest';
import { createRepositories, openDatabase, SqliteDeliveryStore } from '../../adapters/storage';
import { t032Cases } from '../../core/pipeline/testing/t032-cases';
import { worldOn } from '../../core/workflow/testing/harness';

const opened: { db: DatabaseSync; dir: string }[] = [];
afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

t032Cases('SQLite', (workflow) => {
  const dir = mkdtempSync(join(tmpdir(), 'awg-t032-'));
  const db = openDatabase(join(dir, 'awg.sqlite'));
  opened.push({ db, dir });
  return worldOn(createRepositories(db), new SqliteDeliveryStore(db), workflow);
});
