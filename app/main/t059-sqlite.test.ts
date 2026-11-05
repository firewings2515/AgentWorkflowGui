// T059 archiving (U4), on the real SQLite repositories and delivery store: the same cases
// as the memory run in core/sessions/t059.test.ts.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach } from 'vitest';
import { createRepositories, openDatabase, SqliteDeliveryStore } from '../../adapters/storage';
import { t059Cases } from '../../core/sessions/testing/t059-cases';

const opened: { db: DatabaseSync; dir: string }[] = [];
afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.close();
    // Only the temporary directory this test made.
    rmSync(dir, { recursive: true, force: true });
  }
});

t059Cases('SQLite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'awg-t059-'));
  const db = openDatabase(join(dir, 'awg.sqlite'));
  opened.push({ db, dir });
  return { repositories: createRepositories(db), store: new SqliteDeliveryStore(db) };
});
