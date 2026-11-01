// T039 crash matrix on the real SQLite repositories and delivery store; the same cases run on memory storage in
// crash-memory.test.ts. Each restart reads its state back through a new connection to the same file (r1-P1-2).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, expect } from 'vitest';
import { createRepositories, openDatabase, SqliteDeliveryStore } from '../../adapters/storage';
import { supWorldOn } from '../../core/supervisor/testing/harness';
import { worldOn } from '../../core/workflow/testing/harness';
import { crashCases } from './cases';

// Every connection of a case, the abandoned ones included (a crashed run's connection is never closed by it).
const opened: DatabaseSync[] = [];
const dirs: string[] = [];
afterEach(() => {
  const connections = opened.length;
  try {
    // Every case restarts: its restart read through a connection of its own.
    expect(connections).toBeGreaterThanOrEqual(2);
  } finally {
    // Cleaned up even when the check fails (r2): the error is thrown after.
    for (const db of opened.splice(0)) db.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  }
});

/** One database file per case; each start (the first and every restart) opens its own connection to it. */
const database = () => {
  const dir = mkdtempSync(join(tmpdir(), 'awg-t039-crash-'));
  dirs.push(dir);
  const path = join(dir, 'awg.sqlite');
  return () => {
    const db = openDatabase(path);
    opened.push(db);
    // New repositories and store on the new connection: what the restart sees is only what the file holds (r1-P1-2).
    return { repositories: createRepositories(db), store: new SqliteDeliveryStore(db) };
  };
};

crashCases(
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
