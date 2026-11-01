// T039 crash matrix on the real SQLite repositories and delivery store; the same cases run on memory storage in
// crash-memory.test.ts.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach } from 'vitest';
import { createRepositories, openDatabase, SqliteDeliveryStore } from '../../adapters/storage';
import { supWorldOn } from '../../core/supervisor/testing/harness';
import { worldOn } from '../../core/workflow/testing/harness';
import { crashCases } from './cases';

const opened: { db: DatabaseSync; dir: string }[] = [];
afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const database = () => {
  const dir = mkdtempSync(join(tmpdir(), 'awg-t039-crash-'));
  const db = openDatabase(join(dir, 'awg.sqlite'));
  opened.push({ db, dir });
  return db;
};

crashCases(
  'SQLite',
  (o) => {
    const db = database();
    return supWorldOn(createRepositories(db), new SqliteDeliveryStore(db), o);
  },
  (workflow) => {
    const db = database();
    return worldOn(createRepositories(db), new SqliteDeliveryStore(db), workflow);
  },
);
