import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { SessionId } from '../../contracts';
import { StoredDataError } from './codec';
import { SqliteDeliveryStore } from './delivery-store';
import { DELIVERY_BY_TARGET_SQL } from './delivery-target-query';
import { MIGRATIONS, migrate } from './migrations';
import { claimInput, op, payloadInput, provisionInput } from './testing/fixtures';

const connections: DatabaseSync[] = [];
const database = (version: number) => { const db = new DatabaseSync(':memory:'); connections.push(db); db.exec('PRAGMA foreign_keys = ON'); migrate(db, MIGRATIONS.slice(0, version)); return db; };
afterEach(() => { for (const db of connections.splice(0)) db.close(); });

it('v9 preserves rowid gaps, all delivery columns, child foreign keys and the exact existing index DDL', async () => {
  const db = database(8); const store = new SqliteDeliveryStore(db);
  await store.accept(payloadInput({ operationId: op('first') }));
  await store.accept(provisionInput());
  await store.claim(claimInput(op('first')));
  db.exec("UPDATE delivery SET rowid = 100 WHERE operation_id = 'first'");
  const rows = db.prepare('SELECT rowid, * FROM delivery ORDER BY rowid').all();
  const indexes = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'delivery' ORDER BY name").all();
  const children = ['dispatch_attempt', 'provision', 'receive_admission'].map((name) => ({ name, rows: db.prepare(`SELECT * FROM ${name}`).all(), fk: db.prepare(`PRAGMA foreign_key_list(${name})`).all() }));
  migrate(db);
  expect(db.prepare('SELECT rowid, * FROM delivery ORDER BY rowid').all()).toEqual(rows.map((r) => ({ ...r, target_ambiguous: 0 })));
  for (const index of indexes) expect(db.prepare('SELECT name, sql FROM sqlite_schema WHERE name = ?').get(index.name!)).toEqual(index);
  for (const child of children) {
    expect(db.prepare(`SELECT * FROM ${child.name}`).all()).toEqual(child.rows);
    expect(db.prepare(`PRAGMA foreign_key_list(${child.name})`).all()).toEqual(child.fk);
  }
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${DELIVERY_BY_TARGET_SQL}`).all('session-target').map((r) => String(r.detail));
  expect(plan.filter((p) => p.includes('SEARCH delivery USING INDEX delivery_by_target'))).toHaveLength(2);
  const input = payloadInput({ operationId: op('notice'), kind: 'system-notice', counts: undefined });
  expect((await store.accept(input)).status).toBe('invalid');
  input.context.origin = { kind: 'system' };
  expect((await store.accept(input)).status).toBe('accepted');
  expect(await store.get(input.operationId)).toMatchObject({ kind: 'system-notice', context: { origin: { kind: 'system' } } });
  await store.claim(claimInput(input.operationId));
  expect((await store.get(input.operationId))?.delivery.state).toBe('unknown');
});

it.each([true, false])('duplicate target keys fail closed for both sessions, including existing v8 rows: %s', async (beforeMigration) => {
  const db = database(beforeMigration ? 8 : 10); const store = new SqliteDeliveryStore(db);
  await store.accept(payloadInput());
  db.prepare('UPDATE delivery SET target = ?').run('{"sessionId":"secret-first","sessionId":"secret-last"}');
  if (beforeMigration) migrate(db);
  for (const session of ['secret-first', 'secret-last', 'other']) {
    await expect(store.listByTarget(SessionId.parse(session))).rejects.toBeInstanceOf(StoredDataError);
    await expect(store.listByTarget(SessionId.parse(session))).rejects.not.toThrow('secret');
  }
  await expect(store.get(op('op-1'))).rejects.toBeInstanceOf(StoredDataError);
  const plan = db.prepare('EXPLAIN QUERY PLAN SELECT 1 FROM delivery WHERE target_ambiguous = 1 LIMIT 1').all().map((r) => String(r.detail));
  expect(plan.join()).toContain('SEARCH delivery USING COVERING INDEX delivery_ambiguous');
  db.prepare('UPDATE delivery SET target = ?').run('{"sessionId":"session-target"}');
  expect(await store.listByTarget(SessionId.parse('session-target'))).toHaveLength(1);
});

it('v9 rolls back the rebuilt table and child data when recording the migration fails', async () => {
  const db = database(8); const store = new SqliteDeliveryStore(db);
  await store.accept(payloadInput()); await store.claim(claimInput(op('op-1')));
  db.exec("CREATE TRIGGER refuse_v9 BEFORE INSERT ON schema_migration WHEN NEW.version = 9 BEGIN SELECT RAISE(ABORT, 'migration:v9-record-failure'); END");
  const schema = db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all();
  const rows = db.prepare('SELECT * FROM delivery').all();
  expect(() => migrate(db)).toThrow('migration:v9-record-failure');
  expect(db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all()).toEqual(schema);
  expect(db.prepare('SELECT * FROM delivery').all()).toEqual(rows);
  expect(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
  expect((await store.get(op('op-1')))?.delivery.state).toBe('unknown');
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
