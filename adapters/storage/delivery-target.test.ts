import { afterEach, describe, expect, it } from 'vitest';
import { SessionId } from '../../contracts';
import type { DeliveryStore } from '../../core/ports';
import { MemoryDeliveryStore } from '../../core/delivery/testing/memory-store';
import { StoredDataError } from './codec';
import { openDatabase } from './database';
import { SqliteDeliveryStore } from './delivery-store';
import { DELIVERY_BY_TARGET_SQL } from './delivery-target-query';
import { at, claimInput, op, payloadInput, provisionInput, THREAD } from './testing/fixtures';

const databases: ReturnType<typeof openDatabase>[] = [];
const database = () => { const db = openDatabase(':memory:'); databases.push(db); return db; };
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const target = SessionId.parse('session-target');
const other = SessionId.parse('session-other');

describe.each(['memory', 'SQLite'] as const)('C-20 shared target scenarios: %s', (adapter) => {
  it('tracks binding CAS, duplicate/conflicting resends and pending/unknown/sent work', async () => {
    const store: DeliveryStore = adapter === 'memory' ? new MemoryDeliveryStore() : new SqliteDeliveryStore(database());
    const provision = provisionInput();
    const destination = provision.spec.sessionId;
    const nativeRef = provision.spec.preallocatedRef!;
    expect((await store.accept(provision)).status).toBe('accepted');
    const input = payloadInput({ target: { provision: provision.target.provision! }, counts: undefined });
    expect((await store.accept(input)).status).toBe('accepted');
    expect((await store.listByTarget(destination)).map((r) => r.operationId)).toEqual([provision.operationId]);
    const create = claimInput(provision.operationId, { expectedNativeSessionRef: undefined });
    expect((await store.claim(create)).status).toBe('claimed');
    expect(await store.recordSent(provision.operationId, create.attemptId, { sessionRef: nativeRef }, { kind: 'live-ack', at: at(11), detail: 'ack' })).toBe('recorded');
    const bound = (await store.get(provision.operationId))!.target;
    expect(await store.updateTarget(input.operationId, input.target, bound)).toBe('recorded');
    expect(await store.updateTarget(input.operationId, {}, { sessionId: other })).toBe('stale');
    expect((await store.accept(input)).status).toBe('duplicate');
    expect((await store.accept({ ...input, payload: 'different' })).status).toBe('conflict');
    expect((await store.listByTarget(destination)).map((r) => r.delivery.state)).toEqual(['sent', 'pending']);
    const claim = claimInput(input.operationId, { expectedNativeSessionRef: nativeRef });
    expect((await store.claim(claim)).status).toBe('claimed');
    expect((await store.listByTarget(destination)).map((r) => r.delivery.state)).toEqual(['sent', 'unknown']);
    expect(await store.recordSent(input.operationId, claim.attemptId, { sessionRef: nativeRef }, { kind: 'live-ack', at: at(11), detail: 'ack' })).toBe('recorded');
    expect((await store.listByTarget(destination)).map((r) => r.delivery.state)).toEqual(['sent', 'sent']);
    expect(await store.updateTarget(input.operationId, { sessionId: target, nativeSessionRef: THREAD }, { sessionId: other })).toBe('stale');
    expect((await store.listByTarget(destination)).map((r) => r.operationId)).toEqual([provision.operationId, input.operationId]);
    expect(await store.listByTarget(other)).toEqual([]);
  });

  it('orders matching records by acceptance time, with insertion order for ties', async () => {
    const store: DeliveryStore = adapter === 'memory' ? new MemoryDeliveryStore() : new SqliteDeliveryStore(database());
    for (const [id, second, sessionId] of [['later', 2, target], ['first', 1, target], ['unrelated', 0, other], ['tied', 1, target]] as const) {
      expect((await store.accept(payloadInput({ operationId: op(id), at: at(second), counts: undefined, target: { sessionId } }))).status).toBe('accepted');
    }
    expect((await store.listByTarget(target)).map((r) => r.operationId)).toEqual(['first', 'tied', 'later']);
  });
});

describe('v7 target index and fail closed', () => {
  it('the actual query seeks the target index for both the session and NULL bucket', async () => {
    const db = database();
    const store = new SqliteDeliveryStore(db);
    for (let i = 0; i < 100; i++) await store.accept(payloadInput({ operationId: op(`other-${i}`), counts: undefined, target: { sessionId: other } }));
    await store.accept(payloadInput());
    await store.accept(payloadInput({ operationId: op('unbound'), counts: undefined, target: {} }));
    db.exec('ANALYZE');
    const details = db.prepare(`EXPLAIN QUERY PLAN ${DELIVERY_BY_TARGET_SQL}`).all(target).map((r) => String(r.detail));
    expect(details.filter((d) => /SEARCH delivery USING INDEX delivery_by_target/.test(d))).toHaveLength(2);
    expect(details.some((d) => /SCAN delivery/.test(d))).toBe(false);
    expect((await store.listByTarget(target)).map((r) => r.operationId)).toEqual(['op-1']);
  });

  it.each(['{', 'null', '[]', '42', '"secret"', '{"sessionId":42}', '{"sessionId":null}', '{"sessionId":false}', '{"sessionId":[]}', '{"sessionId":{}}', '{"sessionId":""}', '{"nativeSessionRef":42}', '{"provision":null}'])(
    'validates undecidable target %s for every queried session', async (damaged) => {
      const db = database();
      const store = new SqliteDeliveryStore(db);
      await store.accept(payloadInput());
      db.prepare('UPDATE delivery SET target = ?').run(damaged);
      for (const sessionId of [target, other]) {
        await expect(store.listByTarget(sessionId)).rejects.toBeInstanceOf(StoredDataError);
        await expect(store.listByTarget(sessionId)).rejects.not.toThrow('secret');
      }
    },
  );

  it.each(['targeted', 'unbound'] as const)('fully validates a %s row, including its body', async (kind) => {
    const db = database();
    const store = new SqliteDeliveryStore(db);
    await store.accept(payloadInput({ target: kind === 'unbound' ? {} : { sessionId: target } }));
    db.prepare('UPDATE delivery SET body = ?').run('secret damaged body');
    await expect(store.listByTarget(target)).rejects.toMatchObject({ table: 'delivery', problems: ['$:json'] });
    await expect(store.listByTarget(target)).rejects.not.toThrow('secret');
  });

  it('skips only a row positively naming another session, even if other fields are damaged', async () => {
    const db = database();
    const store = new SqliteDeliveryStore(db);
    await store.accept(payloadInput());
    db.prepare('UPDATE delivery SET target = ?, body = ?').run(JSON.stringify({ sessionId: other, nativeSessionRef: 42 }), 'secret');
    expect(await store.listByTarget(target)).toEqual([]);
    await expect(store.listByTarget(other)).rejects.toBeInstanceOf(StoredDataError);
    await expect(store.listByState('pending')).rejects.toBeInstanceOf(StoredDataError);
  });

  it('sorts timestamps by instant across offsets and refuses changing the accepted destination', async () => {
    const db = database();
    const store = new SqliteDeliveryStore(db);
    for (const [i, timestamp] of ['2026-10-26T09:00:00.002+08:00', '2026-10-26T01:00:00.001Z', '2026-10-26T09:00:00.001+08:00'].entries()) {
      await store.accept(payloadInput({ operationId: op(`offset-${i}`), at: timestamp, counts: undefined, target: { sessionId: target } }));
    }
    expect((await store.listByTarget(target)).map((r) => r.operationId)).toEqual(['offset-1', 'offset-2', 'offset-0']);
    expect(await store.updateTarget(op('offset-1'), { sessionId: target }, { sessionId: other })).toBe('stale');
    expect((await store.listByTarget(target)).map((r) => r.operationId)).toEqual(['offset-1', 'offset-2', 'offset-0']);
    expect(await store.listByTarget(other)).toEqual([]);
  });
});
