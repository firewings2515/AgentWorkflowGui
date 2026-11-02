// T040 system-notice on the SQLite delivery store; a restart is a new connection to the same file.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach } from 'vitest';
import { openDatabase, SqliteDeliveryStore } from '../../adapters/storage';
import { t040DeliveryCases } from '../../core/delivery/testing/t040-cases';

const opened: { db: DatabaseSync; dir: string }[] = [];
afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

t040DeliveryCases('SQLite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'awg-t040-'));
  const path = join(dir, 'awg.sqlite');
  const entry = { db: openDatabase(path), dir };
  opened.push(entry);
  return {
    store: new SqliteDeliveryStore(entry.db),
    reopen: () => {
      entry.db.close();
      entry.db = openDatabase(path);
      return new SqliteDeliveryStore(entry.db);
    },
  };
});
