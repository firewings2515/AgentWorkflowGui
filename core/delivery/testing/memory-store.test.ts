// The in-memory store must answer like the SQLite store (adapters/storage/delivery-store.test.ts, T007),
// or the service tests would prove nothing; these are the semantics the service relies on.
import { describe, expect, it } from 'vitest';
import { AttemptId, ClientMessageId, DeliveryRecord } from '../../../contracts';
import type { ClaimInput } from '../../ports';
import { CommitUncertainError } from '../../ports';
import { COUNT_KEY, OP, THREAD, at, op, payloadInput, provisionInput, uuid, waitingPayload } from './fixtures';
import { MemoryDeliveryStore } from './memory-store';

const claimInput = (operationId = OP, overrides: Partial<ClaimInput> = {}): ClaimInput => ({
  operationId,
  expectedProposalRevision: 1,
  expectedNativeSessionRef: THREAD,
  attemptId: AttemptId.parse(`attempt-${uuid()}`),
  clientMessageId: ClientMessageId.parse(uuid()),
  at: at(10),
  ...overrides,
});
const ack = { kind: 'live-ack' as const, at: at(11), detail: 'accepted' };

describe('MemoryDeliveryStore (T007 semantics)', () => {
  it('counts once, enforces the limit, and rejects a changed resend', async () => {
    const store = new MemoryDeliveryStore();
    expect(await store.accept(payloadInput())).toMatchObject({ status: 'accepted', counts: [{ key: COUNT_KEY, count: 1 }] });
    expect((await store.accept(payloadInput({ sourceCallRef: 'call-2' }))).status).toBe('duplicate');
    expect((await store.accept(payloadInput({ context: { ...payloadInput().context, cwd: 'E:/other' } }))).status).toBe('conflict');
    expect((await store.accept(payloadInput({ counts: undefined }))).status).toBe('conflict');
    for (const id of ['op-2', 'op-3']) await store.accept(payloadInput({ operationId: op(id) }));
    expect(await store.accept(payloadInput({ operationId: op('op-4') }))).toEqual({ status: 'limit-exceeded', key: COUNT_KEY, count: 3, limit: 3 });
    expect(store.admissions(COUNT_KEY)).toBe(3);
  });

  it('claims once, re-checks revision and target, and records sent only for the live attempt and its target', async () => {
    const store = new MemoryDeliveryStore();
    await store.accept(payloadInput());
    expect(await store.claim(claimInput(OP, { expectedProposalRevision: 2 }))).toEqual({ status: 'revision-changed' });
    expect(await store.claim(claimInput(OP, { expectedNativeSessionRef: 'thread-B' }))).toEqual({ status: 'target-changed' });
    const input = claimInput();
    expect((await store.claim(input)).status).toBe('claimed');
    expect(await store.claim(claimInput())).toEqual({ status: 'not-pending' });
    expect(await store.recordSent(OP, input.attemptId, { sessionRef: 'thread-B' }, ack)).toBe('stale');
    expect(await store.recordSent(OP, claimInput().attemptId, { sessionRef: THREAD }, ack)).toBe('stale');
    expect(await store.recordSent(OP, input.attemptId, { sessionRef: THREAD }, ack)).toBe('recorded');
    const record = await store.get(OP);
    expect(DeliveryRecord.parse(record?.delivery)).toMatchObject({ state: 'sent' });
  });

  it('retry abandons the attempt and returns to pending; wait and cancel keep it', async () => {
    const store = new MemoryDeliveryStore();
    await store.accept(payloadInput());
    const first = claimInput();
    await store.claim(first);
    expect(await store.recordResolution(OP, first.attemptId, { decision: 'wait', at: at(20) })).toBe('recorded');
    expect((await store.get(OP))?.delivery.state).toBe('unknown');
    expect(await store.recordResolution(OP, first.attemptId, { decision: 'retry', at: at(21) })).toBe('recorded');
    expect(await store.recordResolution(OP, first.attemptId, { decision: 'retry', at: at(22) })).toBe('stale');
    const second = claimInput();
    expect((await store.claim(second)).status).toBe('claimed');
    expect(DeliveryRecord.parse((await store.get(OP))?.delivery).attempts.map((a) => a.attemptId)).toEqual([first.attemptId, second.attemptId]);
    expect(store.admissions(COUNT_KEY)).toBe(1);
  });

  it('binds a waiting payload only to the session its own provision created; same target again is recorded', async () => {
    const store = new MemoryDeliveryStore();
    await store.accept(provisionInput());
    const waiting = waitingPayload();
    await store.accept(waiting);
    const payload = waiting.operationId;
    const created = provisionInput().spec.preallocatedRef ?? '';
    expect(await store.claim(claimInput(payload, { expectedNativeSessionRef: created }))).toEqual({ status: 'target-not-ready' });
    expect((await store.accept(provisionInput('1', { operationId: op('provision-rival') }))).status).toBe('conflict');

    // A provision creates its target, so its claim names no bound session.
    const create = claimInput(op('provision-1'));
    delete create.expectedNativeSessionRef;
    await store.claim(create);
    expect(await store.recordSent(op('provision-1'), create.attemptId, { sessionRef: 'elsewhere' }, ack)).toBe('stale');
    expect(await store.recordSent(op('provision-1'), create.attemptId, { sessionRef: created }, ack)).toBe('recorded');
    const provision = (await store.get(op('provision-1')))?.target;
    if (provision?.provision === undefined) throw new Error('no provision');
    const bound = { sessionId: provisionInput().spec.sessionId, nativeSessionRef: created, provision: provision.provision };
    expect(await store.updateTarget(payload, waiting.target, { ...bound, nativeSessionRef: 'elsewhere' })).toBe('stale');
    expect(await store.updateTarget(payload, waiting.target, bound)).toBe('recorded');
    expect(await store.updateTarget(payload, bound, bound)).toBe('recorded');
    expect(await store.updateTarget(payload, waiting.target, bound)).toBe('stale');
    expect((await store.claim(claimInput(payload, { expectedNativeSessionRef: created }))).status).toBe('claimed');
  });

  it('keeps attempt and client message IDs unique across deliveries, as SQLite’s keys do', async () => {
    const store = new MemoryDeliveryStore();
    await store.accept(payloadInput());
    await store.accept(payloadInput({ operationId: op('op-2') }));
    const first = claimInput();
    expect((await store.claim(first)).status).toBe('claimed');
    await expect(store.claim(claimInput(op('op-2'), { attemptId: first.attemptId }))).rejects.toThrow('unique');
    await expect(store.claim(claimInput(op('op-2'), { clientMessageId: first.clientMessageId }))).rejects.toThrow('unique');
    expect((await store.get(op('op-2')))?.delivery).toEqual({ state: 'pending', attempts: [] });
    expect((await store.claim(claimInput(op('op-2')))).status).toBe('claimed');
  });

  it('injects failed, uncertain and hanging writes', async () => {
    const store = new MemoryDeliveryStore();
    await store.accept(payloadInput());
    store.inject('claim', 'error').inject('claim', 'uncertain').inject('claim', 'uncertain-applied').inject('get', 'hang');
    await expect(store.claim(claimInput())).rejects.toThrow('injected claim failure');
    await expect(store.claim(claimInput())).rejects.toBeInstanceOf(CommitUncertainError);
    await expect(store.claim(claimInput())).rejects.toBeInstanceOf(CommitUncertainError);
    let settled = false;
    void store.get(OP).then(() => (settled = true));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(settled).toBe(false);
    expect((await store.get(OP))?.delivery.state).toBe('unknown');
  });
});
