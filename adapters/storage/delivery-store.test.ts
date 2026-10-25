// The delivery store against the port (core/ports/delivery.ts): acceptance and receive counting,
// the single claim, sent and resolution writes, provisions and target binding. Records read back must
// satisfy the delivery contracts.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeliveryRecord, DeliveryTarget, deliveryTargetIssues } from '../../contracts';
import type { StoredDelivery } from '../../core/ports';
import { openDatabase } from './database';
import { SqliteDeliveryStore } from './delivery-store';
import { COUNT_KEY, THREAD, at, claimInput, hashOf, op, payloadInput, provisionInput } from './testing/fixtures';

const OP = op('op-1');
const ref = { sessionRef: THREAD, turnRef: 'turn-1', itemRef: 'item-1' };
const ack = { kind: 'live-ack' as const, at: at(11), detail: 'turn/start accepted' };

let dir = '';
let db: DatabaseSync;
let store: SqliteDeliveryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awg-t007-store-'));
  db = openDatabase(join(dir, 'app.sqlite'));
  store = new SqliteDeliveryStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Every record the store returns must parse as a DeliveryRecord and agree with its target. */
const valid = (record: StoredDelivery | undefined): StoredDelivery => {
  if (record === undefined) throw new Error('missing record');
  expect(DeliveryRecord.parse(record.delivery)).toEqual(record.delivery);
  expect(DeliveryTarget.parse(record.target)).toEqual(record.target);
  if (record.kind !== 'provision') expect(deliveryTargetIssues(record.delivery, record.target)).toEqual([]);
  return record;
};

const admissions = () => (db.prepare('SELECT count(*) AS n FROM receive_admission').get() as { n: number }).n;

describe('accept', () => {
  it('stores the fixed operation as pending and counts it once', async () => {
    const result = await store.accept(payloadInput());
    expect(result).toMatchObject({ status: 'accepted', count: 1 });
    const record = valid(await store.get(OP));
    expect(record).toEqual({ ...payloadInput(), count: undefined, at: undefined, acceptedAt: at(), delivery: { state: 'pending', attempts: [] } });
  });

  it('treats a resend with the same content, target and revision as a duplicate, even from another tool call', async () => {
    await store.accept(payloadInput());
    const again = await store.accept(payloadInput({ sourceCallRef: 'call-2', at: at(30) }));
    expect(again.status).toBe('duplicate');
    expect(admissions()).toBe(1);
    expect((await store.get(OP))?.sourceCallRef).toBe('call-1');
  });

  it.each([
    ['payload and hash', payloadInput({ payload: 'changed', payloadHash: hashOf('changed') })],
    ['payload text only', payloadInput({ payload: 'changed' })],
    ['hash only', payloadInput({ payloadHash: hashOf('changed') })],
    ['destination', payloadInput({ target: { ...payloadInput().target, nativeSessionRef: 'thread-B' } })],
    ['revision', payloadInput({ proposalRevision: 2 })],
    ['kind', payloadInput({ kind: 'transfer' })],
    ['dispatch context', payloadInput({ context: { ...payloadInput().context, cwd: 'E:/other' } })],
    ['count key', payloadInput({ count: { key: 'instance-1/task-1/node-other' } })],
    ['no count', payloadInput({ count: undefined })],
  ])('rejects the same operationId with a changed %s', async (_, changed) => {
    await store.accept(payloadInput());
    const result = await store.accept(changed);
    expect(result.status).toBe('conflict');
    expect(result.status === 'conflict' && result.existing).toEqual(await store.get(OP));
    expect(admissions()).toBe(1);
  });

  it('enforces the receive limit in the same transaction, and still recognises a resend once the limit is reached', async () => {
    const limit = { key: COUNT_KEY, limit: 2 };
    expect(await store.accept(payloadInput({ operationId: op('a'), count: limit }))).toMatchObject({ count: 1 });
    expect(await store.accept(payloadInput({ operationId: op('b'), count: limit }))).toMatchObject({ count: 2 });
    expect(await store.accept(payloadInput({ operationId: op('c'), count: limit }))).toEqual({ status: 'limit-exceeded', count: 2, limit: 2 });
    expect(await store.get(op('c'))).toBeUndefined();
    expect((await store.accept(payloadInput({ operationId: op('a'), count: limit }))).status).toBe('duplicate');
    // Other keys and uncounted operations are independent.
    expect(await store.accept(payloadInput({ operationId: op('d'), count: { key: 'other', limit: 2 } }))).toMatchObject({ count: 1 });
    expect(await store.accept(payloadInput({ operationId: op('e'), count: undefined }))).toEqual({ status: 'accepted', record: expect.anything() as unknown });
  });

  it('stores a provision with its spec and refuses a second provision for the same binding key', async () => {
    expect((await store.accept(provisionInput())).status).toBe('accepted');
    const record = valid(await store.get(op('provision-1')));
    expect(record.kind === 'provision' && record.spec).toEqual(provisionInput().spec);
    const rival = await store.accept(provisionInput({ operationId: op('provision-2') }));
    expect(rival).toMatchObject({ status: 'conflict', existing: { operationId: 'provision-1' } });
    expect(await store.get(op('provision-2'))).toBeUndefined();
  });

  it('requires a provision to describe itself in target.provision', async () => {
    const input = provisionInput();
    await expect(store.accept({ ...input, target: { sessionId: input.spec.sessionId } })).rejects.toThrow(TypeError);
  });
});

describe('claim', () => {
  beforeEach(async () => {
    await store.accept(payloadInput());
  });

  it('moves pending to unknown with the new attempt, exactly once', async () => {
    const input = claimInput(OP);
    const first = await store.claim(input);
    expect(first).toEqual({
      status: 'claimed',
      attempt: { state: 'unknown', attemptId: input.attemptId, clientMessageId: input.clientMessageId, dispatchStartedAt: input.at },
    });
    expect(await store.claim(claimInput(OP))).toEqual({ status: 'not-pending' });
    expect(valid(await store.get(OP)).delivery).toEqual({ state: 'unknown', attempts: [first.status === 'claimed' && first.attempt] });
  });

  it('re-checks the operation, revision and bound target inside the transaction', async () => {
    expect(await store.claim(claimInput(op('missing')))).toEqual({ status: 'not-found' });
    expect(await store.claim(claimInput(OP, { expectedProposalRevision: 2 }))).toEqual({ status: 'revision-changed' });
    expect(await store.claim(claimInput(OP, { expectedNativeSessionRef: 'thread-B' }))).toEqual({ status: 'target-changed' });
    expect(await store.claim(claimInput(OP, { expectedNativeSessionRef: undefined }))).toEqual({ status: 'target-changed' });
    expect((await store.get(OP))?.delivery.state).toBe('pending');
  });

  it('refuses a payload whose target is not bound yet', async () => {
    await store.accept(payloadInput({ operationId: op('unbound'), target: {} }));
    expect(await store.claim(claimInput(op('unbound')))).toEqual({ status: 'target-not-ready' });
  });

  it('lets two connections race for the claim and gives it to one', async () => {
    const other = openDatabase(join(dir, 'app.sqlite'));
    try {
      const results = await Promise.all([store.claim(claimInput(OP)), new SqliteDeliveryStore(other).claim(claimInput(OP))]);
      expect(results.map((r) => r.status).sort()).toEqual(['claimed', 'not-pending']);
    } finally {
      other.close();
    }
  });

  it('rolls back when the attempt cannot be stored (reused clientMessageId)', async () => {
    const first = claimInput(OP);
    await store.claim(first);
    await store.accept(payloadInput({ operationId: op('op-2') }));
    await expect(store.claim(claimInput(op('op-2'), { clientMessageId: first.clientMessageId }))).rejects.toThrow(/UNIQUE/);
    expect(valid(await store.get(op('op-2'))).delivery).toEqual({ state: 'pending', attempts: [] });
  });
});

describe('recordSent', () => {
  it('records sent only for the live unknown attempt and its target', async () => {
    await store.accept(payloadInput());
    expect(await store.recordSent(OP, claimInput(OP).attemptId, ref, ack)).toBe('stale');
    const claim = claimInput(OP);
    await store.claim(claim);
    expect(await store.recordSent(OP, claimInput(OP).attemptId, ref, ack)).toBe('stale');
    expect(await store.recordSent(OP, claim.attemptId, { ...ref, sessionRef: 'thread-B' }, ack)).toBe('stale');
    expect(await store.recordSent(OP, claim.attemptId, ref, ack)).toBe('recorded');
    expect(await store.recordSent(OP, claim.attemptId, ref, ack)).toBe('stale');
    const record = valid(await store.get(OP));
    expect(record.delivery).toEqual({
      state: 'sent',
      attempts: [{ state: 'sent', attemptId: claim.attemptId, clientMessageId: claim.clientMessageId, dispatchStartedAt: claim.at, nativeRef: ref, evidence: ack }],
    });
    expect(await store.listByState('sent')).toEqual([record]);
  });
});

describe('recordResolution', () => {
  beforeEach(async () => {
    await store.accept(payloadInput());
  });

  it('keeps wait or cancel on the unknown attempt, and keeps it when the attempt is reconciled later', async () => {
    const claim = claimInput(OP);
    await store.claim(claim);
    expect(await store.recordResolution(OP, claim.attemptId, { decision: 'wait', at: at(20) })).toBe('recorded');
    expect(await store.recordResolution(OP, claim.attemptId, { decision: 'cancel', at: at(21), note: 'stop the branch' })).toBe('recorded');
    const cancelled = valid(await store.get(OP));
    expect(cancelled.delivery.state).toBe('unknown');
    expect(cancelled.delivery.attempts[0]?.resolution).toEqual({ decision: 'cancel', decidedBy: 'user', at: at(21), note: 'stop the branch' });
    expect(await store.recordSent(OP, claim.attemptId, ref, { ...ack, kind: 'reconciled' })).toBe('recorded');
    expect(valid(await store.get(OP)).delivery.attempts[0]).toMatchObject({ state: 'sent', resolution: { decision: 'cancel' } });
  });

  it('retry abandons the attempt, returns to pending without recounting, and the next claim adds an attempt', async () => {
    const first = claimInput(OP);
    await store.claim(first);
    expect(await store.recordResolution(OP, first.attemptId, { decision: 'retry', at: at(20) })).toBe('recorded');
    const retried = valid(await store.get(OP));
    expect(retried.delivery.state).toBe('pending');
    expect(retried.delivery.attempts).toMatchObject([{ attemptId: first.attemptId, state: 'unknown', resolution: { decision: 'retry' } }]);
    expect(await store.listByState('pending')).toEqual([retried]);
    expect(await store.recordResolution(OP, first.attemptId, { decision: 'cancel', at: at(21) })).toBe('stale');

    const second = claimInput(OP);
    expect((await store.claim(second)).status).toBe('claimed');
    expect(await store.recordSent(OP, first.attemptId, ref, ack)).toBe('stale');
    expect(await store.recordSent(OP, second.attemptId, ref, ack)).toBe('recorded');
    expect(valid(await store.get(OP)).delivery.attempts.map((a) => a.state)).toEqual(['unknown', 'sent']);
    expect(admissions()).toBe(1);
  });

  it('is stale for a pending or sent delivery', async () => {
    expect(await store.recordResolution(OP, claimInput(OP).attemptId, { decision: 'wait', at: at(20) })).toBe('stale');
    const claim = claimInput(OP);
    await store.claim(claim);
    await store.recordSent(OP, claim.attemptId, ref, ack);
    expect(await store.recordResolution(OP, claim.attemptId, { decision: 'retry', at: at(20) })).toBe('stale');
  });
});

describe('provision and target binding', () => {
  const PROVISION = op('provision-1');
  const created = provisionInput().spec.preallocatedRef ?? '';

  it('dispatches a payload only after its provision is sent and its target bound by compare-and-set', async () => {
    await store.accept(provisionInput());
    const provision = valid(await store.get(PROVISION)).target.provision;
    if (provision === undefined) throw new Error('no provision');
    const waiting = { sessionId: provisionInput().spec.sessionId, provision };
    await store.accept(payloadInput({ target: waiting }));
    expect(await store.claim(claimInput(OP, { expectedNativeSessionRef: created }))).toEqual({ status: 'target-not-ready' });

    // The provision is its own operation with its own claim.
    const createClaim = claimInput(PROVISION, { expectedNativeSessionRef: undefined });
    expect((await store.claim(createClaim)).status).toBe('claimed');
    expect(valid(await store.get(PROVISION)).target.provision?.state).toBe('unknown');
    expect(await store.recordSent(PROVISION, createClaim.attemptId, { sessionRef: 'some-other-session' }, ack)).toBe('stale');
    expect(await store.recordSent(PROVISION, createClaim.attemptId, { sessionRef: created }, ack)).toBe('recorded');
    const sentProvision = valid(await store.get(PROVISION)).target;
    expect(sentProvision).toMatchObject({ nativeSessionRef: created, provision: { state: 'sent', nativeSessionRef: created } });

    const bound = { ...waiting, nativeSessionRef: created, provision: sentProvision.provision };
    expect(await store.updateTarget(OP, { sessionId: waiting.sessionId }, bound)).toBe('stale');
    expect(await store.updateTarget(OP, waiting, bound)).toBe('recorded');
    expect(await store.updateTarget(OP, waiting, bound)).toBe('stale');
    expect(valid(await store.get(OP)).target).toEqual(bound);
    expect((await store.claim(claimInput(OP, { expectedNativeSessionRef: created }))).status).toBe('claimed');
    expect(await store.updateTarget(OP, bound, waiting)).toBe('stale');
  });

  it('refuses a payload bound to a session other than the one its provision created', async () => {
    await store.accept(provisionInput());
    const createClaim = claimInput(PROVISION, { expectedNativeSessionRef: undefined });
    await store.claim(createClaim);
    await store.recordSent(PROVISION, createClaim.attemptId, { sessionRef: created }, ack);
    const provision = valid(await store.get(PROVISION)).target.provision;
    await store.accept(payloadInput({ target: { sessionId: provisionInput().spec.sessionId, nativeSessionRef: THREAD, ...(provision && { provision: { ...provision, nativeSessionRef: THREAD } }) } }));
    expect(await store.claim(claimInput(OP))).toEqual({ status: 'target-changed' });
  });

  it('a retried provision goes back to pending in its own target', async () => {
    await store.accept(provisionInput());
    const createClaim = claimInput(PROVISION, { expectedNativeSessionRef: undefined });
    await store.claim(createClaim);
    await store.recordResolution(PROVISION, createClaim.attemptId, { decision: 'retry', at: at(20) });
    expect(valid(await store.get(PROVISION)).target.provision?.state).toBe('pending');
  });

  // Review r1 P1: the destination is fixed at acceptance; binding may only follow the payload's own provision.
  /** Accepts provision `name`; with `send`, also claims it and records the pre-allocated session as created. */
  const provisionTarget = async (name: string, send: boolean) => {
    const input = provisionInput({}, name);
    await store.accept(input);
    const waiting = { sessionId: input.spec.sessionId, provision: valid(await store.get(input.operationId)).target.provision };
    const created = input.spec.preallocatedRef ?? '';
    if (send) {
      const createClaim = claimInput(input.operationId, { expectedNativeSessionRef: undefined });
      await store.claim(createClaim);
      expect(await store.recordSent(input.operationId, createClaim.attemptId, { sessionRef: created }, ack)).toBe('recorded');
    }
    const record = valid(await store.get(input.operationId)).target.provision;
    if (waiting.provision === undefined || record === undefined) throw new Error('no provision');
    return { waiting: { ...waiting, provision: waiting.provision }, bound: { sessionId: input.spec.sessionId, nativeSessionRef: created, provision: record }, created };
  };

  it('cannot re-point a payload waiting for provision B at the finished provision A', async () => {
    const a = await provisionTarget('A', true);
    const b = await provisionTarget('B', false);
    await store.accept(payloadInput({ target: b.waiting }));
    expect(await store.updateTarget(OP, b.waiting, a.bound)).toBe('stale');
    expect(await store.updateTarget(OP, b.waiting, { ...a.bound, sessionId: b.waiting.sessionId })).toBe('stale');
    expect(await store.updateTarget(OP, b.waiting, { ...a.bound, provision: { ...a.bound.provision, operationId: b.waiting.provision.operationId } })).toBe('stale');
    // B is not created yet, so binding it early is refused too.
    expect(await store.updateTarget(OP, b.waiting, { ...b.waiting, nativeSessionRef: b.created })).toBe('stale');
    expect(await store.claim(claimInput(OP, { expectedNativeSessionRef: a.created }))).toEqual({ status: 'target-not-ready' });
    expect(valid(await store.get(OP)).target).toEqual(b.waiting);
    expect((await store.get(op('provision-B')))?.delivery.state).toBe('pending');
    expect(admissions()).toBe(1);
  });

  it('refuses targets that mix provision A with provision B’s binding key or session', async () => {
    const a = await provisionTarget('A', true);
    const b = await provisionTarget('B', false);
    const mixed = [
      // A's operationId, B's binding key.
      { ...a.bound, provision: { ...a.bound.provision, bindingKey: b.waiting.provision.bindingKey } },
      // A's operationId and binding key, B's session.
      { ...a.bound, sessionId: b.waiting.sessionId },
      // Still waiting: A's operationId with B's binding key.
      { sessionId: b.waiting.sessionId, provision: { ...a.waiting.provision, bindingKey: b.waiting.provision.bindingKey } },
    ];
    for (const [i, target] of mixed.entries()) {
      const operationId = op(`mixed-${i}`);
      await store.accept(payloadInput({ operationId, target }));
      expect(await store.claim(claimInput(operationId, { expectedNativeSessionRef: a.created }))).toEqual({ status: 'target-changed' });
      expect(await store.updateTarget(operationId, target, a.bound)).toBe('stale');
      expect(valid(await store.get(operationId)).delivery).toEqual({ state: 'pending', attempts: [] });
    }
    expect(admissions()).toBe(mixed.length);
  });

  it('cannot re-bind a payload that was accepted bound, or change a provision’s own target', async () => {
    await store.accept(payloadInput());
    const accepted = payloadInput().target;
    expect(await store.updateTarget(OP, accepted, { ...accepted, nativeSessionRef: 'thread-B' })).toBe('stale');
    expect(await store.updateTarget(OP, accepted, { sessionId: provisionInput().spec.sessionId, nativeSessionRef: THREAD })).toBe('stale');
    expect(await store.claim(claimInput(OP, { expectedNativeSessionRef: 'thread-B' }))).toEqual({ status: 'target-changed' });
    expect(valid(await store.get(OP)).target).toEqual(accepted);

    const a = await provisionTarget('A', false);
    expect(await store.updateTarget(op('provision-A'), a.waiting, { ...a.waiting, nativeSessionRef: 'elsewhere' })).toBe('stale');
    expect(admissions()).toBe(1);
    expect((await store.claim(claimInput(OP))).status).toBe('claimed');
  });

  // Review r2 P1: whether a payload is bound depends on its target, not on whether it changed since acceptance.
  /** Claims provision `name` and records its pre-allocated session as created; returns its binding. */
  const sendProvision = async (name: string) => {
    const input = provisionInput({}, name);
    const createClaim = claimInput(input.operationId, { expectedNativeSessionRef: undefined });
    await store.claim(createClaim);
    expect(await store.recordSent(input.operationId, createClaim.attemptId, { sessionRef: input.spec.preallocatedRef ?? '' }, ack)).toBe('recorded');
    const record = valid(await store.get(input.operationId)).target.provision;
    if (record === undefined) throw new Error('no provision');
    return { sessionId: input.spec.sessionId, nativeSessionRef: input.spec.preallocatedRef ?? '', provision: record };
  };

  it('claims a payload accepted already bound to its sent provision; setting the same target again changes nothing', async () => {
    const a = await provisionTarget('A', true);
    await store.accept(payloadInput({ target: a.bound }));
    expect(await store.updateTarget(OP, a.bound, a.bound)).toBe('recorded');
    expect(valid(await store.get(OP))).toMatchObject({ target: a.bound, delivery: { state: 'pending', attempts: [] } });
    expect((await store.claim(claimInput(OP, { expectedNativeSessionRef: a.created }))).status).toBe('claimed');
    expect(admissions()).toBe(1);
  });

  it('still binds a payload accepted before its provision was sent, through updateTarget', async () => {
    const a = await provisionTarget('A', false);
    await store.accept(payloadInput({ target: a.waiting }));
    expect(await store.claim(claimInput(OP, { expectedNativeSessionRef: a.created }))).toEqual({ status: 'target-not-ready' });
    const bound = await sendProvision('A');
    expect(await store.claim(claimInput(OP, { expectedNativeSessionRef: a.created }))).toEqual({ status: 'target-not-ready' });
    expect(await store.updateTarget(OP, a.waiting, bound)).toBe('recorded');
    expect((await store.claim(claimInput(OP, { expectedNativeSessionRef: a.created }))).status).toBe('claimed');
  });

  it('moves a payload accepted with the pre-allocated session to its provision’s sent record, and nowhere else', async () => {
    const a = await provisionTarget('A', false);
    const early = { ...a.waiting, nativeSessionRef: a.created };
    await store.accept(payloadInput({ target: early }));
    expect(await store.claim(claimInput(OP, { expectedNativeSessionRef: a.created }))).toEqual({ status: 'target-not-ready' });
    const bound = await sendProvision('A');
    // Created, but the payload's own snapshot has not caught up yet.
    expect(await store.claim(claimInput(OP, { expectedNativeSessionRef: a.created }))).toEqual({ status: 'target-not-ready' });
    expect(await store.updateTarget(OP, early, { ...bound, nativeSessionRef: 'elsewhere' })).toBe('stale');
    expect(await store.updateTarget(OP, early, bound)).toBe('recorded');
    expect((await store.claim(claimInput(OP, { expectedNativeSessionRef: a.created }))).status).toBe('claimed');
    expect(admissions()).toBe(1);
  });
});

describe('listByState', () => {
  it('lists records in acceptance order, with everything needed to dispatch or reconcile them', async () => {
    await store.accept(payloadInput({ operationId: op('b'), at: at(2) }));
    await store.accept(payloadInput({ operationId: op('a'), at: at(1) }));
    await store.accept(provisionInput({ at: at(3) }));
    expect((await store.listByState('pending')).map((r) => r.operationId)).toEqual(['a', 'b', 'provision-1']);
    await store.claim(claimInput(op('a')));
    expect((await store.listByState('unknown')).map((r) => [r.operationId, r.kind === 'provision' ? r.spec : r.context])).toEqual([['a', payloadInput().context]]);
    expect(await store.listByState('sent')).toEqual([]);
  });
});
