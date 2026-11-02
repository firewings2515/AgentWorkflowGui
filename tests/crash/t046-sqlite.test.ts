// T046 cases on the real SQLite repositories and delivery store; the same cases run on memory storage in
// t046-memory.test.ts. Each restart reads its state back through a new connection to the same file, as in
// crash-sqlite.test.ts (T039 r1-P1-2).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach } from 'vitest';
import { createRepositories, openDatabase, SqliteDeliveryStore } from '../../adapters/storage';
import { supWorldOn } from '../../core/supervisor/testing/harness';
import { worldOn } from '../../core/workflow/testing/harness';
import { noHistoryCases } from './t046-cases';

// Every connection of a case, the abandoned ones included (a crashed run's connection is never closed by it).
const opened: DatabaseSync[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** One database file per case; each start (the first and every restart) opens its own connection to it. */
const database = () => {
  const dir = mkdtempSync(join(tmpdir(), 'awg-t046-crash-'));
  dirs.push(dir);
  const path = join(dir, 'awg.sqlite');
  return () => {
    const db = openDatabase(path);
    opened.push(db);
    return { repositories: createRepositories(db), store: new SqliteDeliveryStore(db) };
  };
};

noHistoryCases(
  'SQLite',
  (o) => {
    const open = database();
    const first = open();
    return supWorldOn(first.repositories, first.store, { ...o, reopen: open });
  },
  (workflow) => {
    const open = database();
    const first = open();
    return worldOn(first.repositories, first.store, workflow, undefined, open);
  },
);
