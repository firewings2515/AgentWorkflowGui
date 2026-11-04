// T050 pinned lists and session.rename sent again, on the real SQLite repositories and delivery store: the same cases
// as the memory run in core/sessions/t050.test.ts.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach } from 'vitest';
import { createRepositories, openDatabase, SqliteDeliveryStore } from '../../adapters/storage';
import { t050SessionCases } from '../../core/sessions/testing/t050-cases';

const opened: { db: DatabaseSync; dir: string }[] = [];
afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.close();
    // Only the temporary directory this test made.
    rmSync(dir, { recursive: true, force: true });
  }
});

t050SessionCases('SQLite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'awg-t050-'));
  const db = openDatabase(join(dir, 'awg.sqlite'));
  opened.push({ db, dir });
  return { repositories: createRepositories(db), store: new SqliteDeliveryStore(db) };
});
