// T063 workflow.delete and workflow.addStarter on the real SQLite repositories and delivery store, with the same session service, engine and
// memory git as the memory run in core/workflow/t063.test.ts; a restart reopens the database file.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach } from 'vitest';
import { createRepositories, openDatabase, SqliteDeliveryStore } from '../../adapters/storage';
import { worldOn } from '../../core/workflow/testing/harness';
import { t063WorkflowCases } from '../../core/workflow/testing/t063-cases';

const databases: DatabaseSync[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close();
  // Only the temporary directories these tests made.
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

t063WorkflowCases('SQLite', (workflow) => {
  const dir = mkdtempSync(join(tmpdir(), 'awg-t063-'));
  dirs.push(dir);
  const file = join(dir, 'awg.sqlite');
  const open = () => {
    const db = openDatabase(file);
    databases.push(db);
    return { repositories: createRepositories(db), store: new SqliteDeliveryStore(db) };
  };
  const first = open();
  return worldOn(first.repositories, first.store, workflow, undefined, open);
});
