// T023 on the real SQLite repositories and delivery store (T022): the same session service, transfer service
// and fake runtimes as the memory runs in core/transfer, so the store's own transfer checks (the payload must
// match the approved proposal, the provision link) and its read-back projection see every step.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach } from 'vitest';
import { createRepositories, openDatabase, SqliteDeliveryStore } from '../../adapters/storage';
import { commandCases } from '../../core/transfer/testing/command-cases';
import { worldOn } from '../../core/transfer/testing/harness';
import { lifecycleCases } from '../../core/transfer/testing/lifecycle-cases';

const opened: { db: DatabaseSync; dir: string }[] = [];
afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const sqlite = () => {
  const dir = mkdtempSync(join(tmpdir(), 'awg-t023-'));
  const db = openDatabase(join(dir, 'awg.sqlite'));
  opened.push({ db, dir });
  return worldOn(createRepositories(db), new SqliteDeliveryStore(db));
};

commandCases('SQLite', sqlite);
lifecycleCases('SQLite', sqlite);
