// The CR-2 delivery service over the two ports (T008). Tests 1-10 follow CR2_DELIVERY_FIX §6 (the spike's
// cr2-outbox-test.mjs scenarios) on the in-memory store and a fake runtime whose history survives a GUI
// restart; the rest cover the user's decisions, provisions and the dispatch entry.
import { describe, expect, it } from 'vitest';
import { DeliveryRecord, DeliveryTarget, deliveryTargetIssues } from '../../contracts';
import type { AcceptInput, StoredDelivery } from '../ports';
import { COUNT_KEY, OP, THREAD, at, flush, gui, hashOf, op, payloadInput, provisionInput, waitingPayload } from './testing/fixtures';
import { MemoryDeliveryStore } from './testing/memory-store';

/** Every record the store holds must parse as a DeliveryRecord and agree with its target. */
const valid = (record: StoredDelivery | undefined): StoredDelivery => {
  if (record === undefined) throw new Error('missing record');
  expect(DeliveryRecord.parse(record.delivery)).toEqual(record.delivery);
  expect(DeliveryTarget.parse(record.target)).toEqual(record.target);
  if (record.kind !== 'provision') expect(deliveryTargetIssues(record.delivery, record.target)).toEqual([]);
  return record;
};

const accepted = async (g: ReturnType<typeof gui>, input: AcceptInput = payloadInput()) => {
  expect((await g.service.accept(input)).status).toBe('accepted');
  return g;
};

const stateOf = async (g: ReturnType<typeof gui>, operationId = OP) => valid(await g.store.get(operationId)).delivery.state;

/** Restarts and recovers twice, as a GUI that keeps crashing at startup would. */
const recoverTwice = async (g: ReturnType<typeof gui>) => {
  const first = g.restart();
  await first.service.recover();
  const second = first.restart();
  const report = await second.service.recover();
  return { first, second, report };
};

describe('CR2_DELIVERY_FIX §6 scenarios', () => {
  it('1. accepts once with a fixed payload, hash and revision; a changed resend is rejected and never counted', async () => {
    const g = gui();
    expect(await g.service.accept(payloadInput())).toMatchObject({ status: 'accepted', count: 1 });
    expect(await g.service.accept(payloadInput({ sourceCallRef: 'call-1-resent', at: at(5) }))).toMatchObject({ status: 'duplicate' });
    expect(await g.service.accept(payloadInput({ target: { ...payloadInput().target, nativeSessionRef: 'thread-B' } }))).toMatchObject({ status: 'conflict' });
    expect(await g.service.accept(payloadInput({ payload: 'changed' }))).toMatchObject({ status: 'conflict' });
    expect(await g.service.accept(payloadInput({ proposalRevision: 2 }))).toMatchObject({ status: 'conflict' });
    // A hash that does not describe the payload is refused before the store.
    expect(await g.service.accept(payloadInput({ operationId: op('op-2'), payloadHash: hashOf('something else') }))).toEqual({
      status: 'invalid',
      issues: ['payloadHash does not match the payload'],
    });
    expect(g.store.admissions(COUNT_KEY)).toBe(1);
    expect(valid(await g.store.get(OP))).toMatchObject({ payload: 'payload', payloadHash: hashOf('payload'), proposalRevision: 1, delivery: { state: 'pending', attempts: [] } });
  });

  it('1b. an uncertain acceptance commit is reported, and accepting again with the same operationId settles it without a second count', async () => {
    const g = gui();
    g.store.inject('accept', 'uncertain-applied');
    expect((await g.service.accept(payloadInput())).status).toBe('commit-uncertain');
    expect((await g.service.accept(payloadInput())).status).toBe('duplicate');
    expect(g.store.admissions(COUNT_KEY)).toBe(1);
  });

  it('2. two dispatchers on the same store deliver once', async () => {
    const a = await accepted(gui());
    const b = a.restart();
    const [ra, rb] = await Promise.all([a.service.dispatch(OP), b.service.dispatch(OP)]);
    expect([ra.status, rb.status].sort()).toEqual(['not-dispatched', 'sent']);
    expect([ra, rb].find((r) => r.status === 'not-dispatched')).toMatchObject({ reason: 'not-pending' });
    // Both reached the claim; only the winner called the runtime.
    expect(a.store.calls.filter((c) => c === 'claim')).toHaveLength(2);
    expect(a.codex.dispatched.length + b.codex.dispatched.length).toBe(1);
    expect(a.history.received()).toHaveLength(1);
    expect(await stateOf(a)).toBe('sent');
  });

  // 3-6: the four crash positions, each followed by repeated recovery that must never resend.
  it('3. crash after the claim, before the call: stays unknown, is escalated, never resent', async () => {
    const g = await accepted(gui());
    g.codex.dispatchModes.push('crash-before-send');
    void g.service.dispatch(OP);
    await flush();
    expect(await stateOf(g)).toBe('unknown');
    const { first, second, report } = await recoverTwice(g);
    expect(first.codex.dispatched.length + second.codex.dispatched.length).toBe(0);
    expect(g.history.received()).toHaveLength(0);
    expect(report.reconciled).toEqual([{ operationId: OP, outcome: { status: 'unknown', escalation: expect.objectContaining({ reason: 'not-found', duplicateRisk: 'possible' }) as unknown } }]);
    expect(report.dispatched).toEqual([]);
    expect(second.escalations).toHaveLength(1);
    // The same attempt gives the same key on every restart, so the layer above keeps one escalation.
    expect(first.escalations[0]?.key).toBe(second.escalations[0]?.key);
    expect(await stateOf(g)).toBe('unknown');
  });

  it('4. crash after the runtime received it: recovery reconciles it to sent, never resends', async () => {
    const g = await accepted(gui());
    g.codex.dispatchModes.push('crash-after-receive');
    void g.service.dispatch(OP);
    await flush();
    expect(await stateOf(g)).toBe('unknown');
    const { first, second } = await recoverTwice(g);
    expect(first.codex.dispatched.length + second.codex.dispatched.length).toBe(0);
    expect(g.history.received()).toHaveLength(1);
    expect(valid(await g.store.get(OP)).delivery).toMatchObject({ state: 'sent', attempts: [{ state: 'sent', evidence: { kind: 'reconciled' } }] });
    expect(first.escalations).toEqual([]);
  });

  it('5. crash after the ack, before sent was written: recovery reconciles it to sent, never resends', async () => {
    const g = await accepted(gui());
    g.store.inject('recordSent', 'hang');
    void g.service.dispatch(OP);
    await flush();
    expect(g.codex.dispatched).toHaveLength(1);
    expect(await stateOf(g)).toBe('unknown');
    const { first, second } = await recoverTwice(g);
    expect(first.codex.dispatched.length + second.codex.dispatched.length).toBe(0);
    expect(g.history.received()).toHaveLength(1);
    expect(await stateOf(g)).toBe('sent');
  });

  it('6. crash after sent was written: recovery does nothing', async () => {
    const g = await accepted(gui());
    expect(await g.service.dispatch(OP)).toMatchObject({ status: 'sent', nativeRef: { sessionRef: THREAD }, evidence: { kind: 'live-ack' } });
    const { first, second, report } = await recoverTwice(g);
    expect(first.codex.dispatched.length + second.codex.dispatched.length + first.codex.reconciled.length + second.codex.reconciled.length).toBe(0);
    expect(report).toEqual({ reconciled: [], dispatched: [], failed: [] });
    expect(g.history.received()).toHaveLength(1);
  });

  it('7. pending at restart goes through the same committed claim; a second crash cannot duplicate', async () => {
    // The first GUI dies with only the acceptance committed.
    const g = await accepted(gui());
    // The recovering GUI crashes again after the runtime received it.
    const second = g.restart();
    second.codex.dispatchModes.push('crash-after-receive');
    void second.service.recover();
    await flush();
    expect(second.store.calls).toContain('claim');
    expect(await stateOf(g)).toBe('unknown');
    // Two more restarts: reconciled once, then nothing to do.
    const third = second.restart();
    expect((await third.service.recover()).reconciled).toEqual([{ operationId: OP, outcome: expect.objectContaining({ status: 'sent' }) as unknown }]);
    const fourth = third.restart();
    expect(await fourth.service.recover()).toEqual({ reconciled: [], dispatched: [], failed: [] });
    expect(second.codex.dispatched.length + third.codex.dispatched.length + fourth.codex.dispatched.length).toBe(1);
    expect(g.history.received()).toHaveLength(1);
  });

  it('8. a failed claim transaction keeps the runtime untouched and the delivery pending', async () => {
    const g = await accepted(gui());
    g.store.inject('claim', 'error');
    expect(await g.service.dispatch(OP)).toMatchObject({ status: 'not-dispatched', reason: 'store-failed' });
    expect(g.codex.dispatched).toHaveLength(0);
    expect(valid(await g.store.get(OP)).delivery).toEqual({ state: 'pending', attempts: [] });
    // Nothing was claimed, so the next dispatch is a normal first one.
    expect((await g.service.dispatch(OP)).status).toBe('sent');
    expect(g.history.received()).toHaveLength(1);
  });

  it('8b. an uncertain claim commit never calls the runtime, whether or not it applied', async () => {
    const g = await accepted(gui());
    g.store.inject('claim', 'uncertain');
    expect(await g.service.dispatch(OP)).toMatchObject({ status: 'not-dispatched', reason: 'commit-uncertain' });
    expect(valid(await g.store.get(OP)).delivery).toEqual({ state: 'pending', attempts: [] });

    g.store.inject('claim', 'uncertain-applied');
    expect(await g.service.dispatch(OP)).toMatchObject({ status: 'not-dispatched', reason: 'commit-uncertain' });
    // It did apply: the attempt is unknown although nothing left the GUI, and it is only reconciled.
    expect(await stateOf(g)).toBe('unknown');
    expect(await g.service.dispatch(OP)).toMatchObject({ status: 'not-dispatched', reason: 'not-pending' });
    expect((await g.service.recover()).reconciled[0]?.outcome).toMatchObject({ status: 'unknown', escalation: { reason: 'not-found' } });
    expect(g.codex.dispatched).toHaveLength(0);
    expect(g.history.received()).toHaveLength(0);
  });

  it('9. a failed sent write stays unknown, is not resent, and recovery reconciles it', async () => {
    const g = await accepted(gui());
    // Both the write after the ack and the one after the immediate reconcile fail.
    g.store.inject('recordSent', 'error', 2);
    const outcome = await g.service.dispatch(OP);
    expect(outcome).toMatchObject({ status: 'unknown', failure: { reason: 'record-failed', written: true }, escalation: { reason: 'record-failed' } });
    expect(await stateOf(g)).toBe('unknown');
    expect(await g.service.dispatch(OP)).toMatchObject({ status: 'not-dispatched', reason: 'not-pending' });
    expect(g.codex.dispatched).toHaveLength(1);
    const next = g.restart();
    expect((await next.service.recover()).reconciled[0]?.outcome.status).toBe('sent');
    expect(next.codex.dispatched).toHaveLength(0);
    expect(g.history.received()).toHaveLength(1);
  });

  it('10. absent, unreadable, mismatched or duplicated evidence never clears unknown', async () => {
    const g = await accepted(gui());
    g.codex.dispatchModes.push('timeout');
    g.codex.reconcileModes.push('lagging');
    // Not flushed yet right after the timeout: not-found is not proof of non-delivery.
    expect(await g.service.dispatch(OP)).toMatchObject({ status: 'unknown', failure: { reason: 'timeout', written: true }, escalation: { reason: 'not-found' } });
    const live = valid(await g.store.get(OP)).delivery.attempts[0];
    if (live === undefined) throw new Error('no attempt');

    g.codex.reconcileModes.push('read-failed', 'throw');
    expect(await g.service.reconcile(OP)).toMatchObject({ status: 'unknown', escalation: { reason: 'read-failed' } });
    expect(await g.service.reconcile(OP)).toMatchObject({ status: 'unknown', escalation: { reason: 'read-failed', detail: 'history read threw' } });

    // Same clientMessageId with other content.
    const [stored] = g.history.messages;
    if (stored === undefined) throw new Error('nothing stored');
    stored.text = 'other content';
    expect(await g.service.reconcile(OP)).toMatchObject({ status: 'unknown', escalation: { reason: 'content-mismatch' } });
    // Two stored messages carry the ID: a suspected duplicate, never picked as the normal one.
    stored.text = 'payload';
    g.history.messages.push({ ...stored, itemRef: 'item-copy' });
    expect(await g.service.reconcile(OP)).toMatchObject({ status: 'unknown', escalation: { reason: 'duplicate', duplicateRisk: 'suspected', matches: [{}, {}] } });
    expect(await stateOf(g)).toBe('unknown');
    expect(g.codex.dispatched).toHaveLength(1);

    // After a user retry the old attempt is stale: evidence for it no longer counts.
    g.history.messages.pop();
    expect(await g.service.resolve({ operationId: OP, attemptId: live.attemptId, decision: 'retry', acceptDuplicateRisk: true })).toEqual({ status: 'recorded', decision: 'retry' });
    expect(await g.service.reconcile(OP)).toEqual({ status: 'not-unknown', state: 'pending' });
    expect(await g.store.recordSent(OP, live.attemptId, { sessionRef: THREAD }, { kind: 'reconciled', at: at(5), detail: 'late' })).toBe('stale');
  });

  it('10b. an ack for another session is refused by the store and stays unknown', async () => {
    const g = await accepted(gui());
    g.codex.dispatchModes.push('ack-elsewhere');
    g.codex.reconcileModes.push('lagging');
    expect(await g.service.dispatch(OP)).toMatchObject({ status: 'unknown', failure: { reason: 'evidence-rejected' } });
    expect(await stateOf(g)).toBe('unknown');
    // The stored message is under the right session, so a later read-only reconcile can settle it.
    expect((await g.service.reconcile(OP)).status).toBe('sent');
  });
});

describe('dispatch entry', () => {
  it('passes the stored payload, attempt and the caller’s entry; reconciles with the stored payload and clientMessageId', async () => {
    const g = await accepted(gui());
    g.codex.dispatchModes.push('crash-after-receive');
    void g.service.dispatch(OP, { entry: { kind: 'insert', expectedTurnRef: 'turn-7' }, timeoutMs: 5000 });
    await flush();
    const [request] = g.codex.dispatched;
    const attempt = valid(await g.store.get(OP)).delivery.attempts[0];
    expect(request).toEqual({ nativeSessionRef: THREAD, attempt, text: 'payload', entry: { kind: 'insert', expectedTurnRef: 'turn-7' }, timeoutMs: 5000 });
    // A restarted GUI knows nothing but the store.
    const next = g.restart();
    await next.service.recover();
    expect(next.codex.reconciled).toEqual([{ nativeSessionRef: THREAD, cwd: 'E:/work', clientMessageId: attempt?.clientMessageId, text: 'payload' }]);
  });

  it('defaults to the entry stored at acceptance', async () => {
    const g = await accepted(gui());
    await g.service.dispatch(OP);
    expect(g.codex.dispatched[0]?.entry).toEqual({ kind: 'new-turn' });
  });

  it('re-checks the confirmed revision and the bound session in the claim, before any runtime call', async () => {
    const g = await accepted(gui());
    expect(await g.service.dispatch(OP, { expectedProposalRevision: 2 })).toMatchObject({ status: 'not-dispatched', reason: 'revision-changed' });
    expect(await g.service.dispatch(OP, { expectedNativeSessionRef: 'thread-B' })).toMatchObject({ status: 'not-dispatched', reason: 'target-changed' });
    expect(await g.service.dispatch(op('missing'))).toMatchObject({ status: 'not-dispatched', reason: 'not-found' });
    expect(g.codex.dispatched).toHaveLength(0);
    expect(await stateOf(g)).toBe('pending');
  });

  it('does not claim when the runtime has no adapter or the target cannot be prepared', async () => {
    const store = new MemoryDeliveryStore();
    const g = await accepted(gui(store, undefined, { runtimes: {} }));
    expect(await g.service.dispatch(OP)).toMatchObject({ status: 'not-dispatched', reason: 'no-runtime' });
    const prepared = gui(store, g.history, { prepareTarget: () => Promise.reject(new Error('resume failed')) });
    expect(await prepared.service.dispatch(OP)).toEqual({ status: 'not-dispatched', reason: 'prepare-failed', detail: 'resume failed' });
    expect(store.calls).not.toContain('claim');
    expect(await stateOf(g)).toBe('pending');
  });

  it('treats a throwing or refusing adapter as unknown, and says how likely a duplicate is', async () => {
    const g = await accepted(gui());
    g.codex.dispatchModes.push('throw');
    expect(await g.service.dispatch(OP)).toMatchObject({ status: 'unknown', failure: { reason: 'adapter-error' }, escalation: { duplicateRisk: 'possible' } });
    const other = await accepted(g, payloadInput({ operationId: op('op-2') }));
    other.codex.dispatchModes.push('reject');
    expect(await other.service.dispatch(op('op-2'))).toMatchObject({ status: 'unknown', failure: { reason: 'rejected', written: false }, escalation: { duplicateRisk: 'unlikely' } });
    expect(g.codex.dispatched).toHaveLength(2);
    expect(g.history.received()).toHaveLength(0);
  });
});

describe('user decisions on unknown', () => {
  const unknownDelivery = async () => {
    const g = await accepted(gui());
    g.codex.dispatchModes.push('timeout');
    g.codex.reconcileModes.push('lagging');
    const outcome = await g.service.dispatch(OP);
    if (outcome.status !== 'unknown') throw new Error('expected unknown');
    return { g, attemptId: outcome.attemptId };
  };

  it('wait and cancel keep the attempt unknown and reconcilable; the decision is kept when it turns out sent', async () => {
    const { g, attemptId } = await unknownDelivery();
    g.codex.reconcileModes.push('lagging');
    expect(await g.service.resolve({ operationId: OP, attemptId, decision: 'wait', acceptDuplicateRisk: false })).toEqual({ status: 'recorded', decision: 'wait' });
    expect(await g.service.reconcile(OP)).toMatchObject({ status: 'unknown', escalation: { decision: 'wait' } });
    expect((await g.service.reconcile(OP)).status).toBe('sent');
    expect(valid(await g.store.get(OP)).delivery.attempts).toMatchObject([{ state: 'sent', resolution: { decision: 'wait', decidedBy: 'user' } }]);

    const other = await unknownDelivery();
    expect(await other.g.service.resolve({ operationId: OP, attemptId: other.attemptId, decision: 'cancel', acceptDuplicateRisk: false, note: 'stop the task' })).toMatchObject({
      status: 'recorded',
    });
    expect(await stateOf(other.g)).toBe('unknown');
    expect(await other.g.service.dispatch(OP)).toMatchObject({ status: 'not-dispatched', reason: 'not-pending' });
    expect(other.g.codex.dispatched).toHaveLength(1);
  });

  it('retry needs acceptDuplicateRisk, keeps the old attempt, makes new IDs and does not recount', async () => {
    const { g, attemptId } = await unknownDelivery();
    expect(await g.service.resolve({ operationId: OP, attemptId, decision: 'retry', acceptDuplicateRisk: false })).toEqual({ status: 'refused', reason: 'duplicate-risk-not-accepted' });
    expect(await stateOf(g)).toBe('unknown');
    expect(await g.service.resolve({ operationId: OP, attemptId, decision: 'retry', acceptDuplicateRisk: true })).toEqual({ status: 'recorded', decision: 'retry' });
    expect(await stateOf(g)).toBe('pending');
    // The retry itself does not dispatch; the caller does, through the same entry.
    expect(g.codex.dispatched).toHaveLength(1);
    expect((await g.service.dispatch(OP)).status).toBe('sent');
    const [old, next] = valid(await g.store.get(OP)).delivery.attempts;
    expect(old).toMatchObject({ attemptId, state: 'unknown', resolution: { decision: 'retry', decidedBy: 'user' } });
    expect(next?.attemptId).not.toBe(old?.attemptId);
    expect(next?.clientMessageId).not.toBe(old?.clientMessageId);
    expect(g.codex.dispatched.map((d) => d.attempt.clientMessageId)).toEqual([old?.clientMessageId, next?.clientMessageId]);
    expect(g.store.admissions(COUNT_KEY)).toBe(1);
    // A stale attempt cannot be decided on again.
    expect(await g.service.resolve({ operationId: OP, attemptId, decision: 'retry', acceptDuplicateRisk: true })).toEqual({ status: 'stale' });
  });

  it('refuses a retry while this process is still inside the attempt’s runtime call, but records wait or cancel', async () => {
    const g = await accepted(gui());
    g.codex.dispatchModes.push('crash-before-send');
    void g.service.dispatch(OP);
    await flush();
    const attempt = valid(await g.store.get(OP)).delivery.attempts[0];
    if (attempt === undefined) throw new Error('no attempt');
    const decide = (decision: 'wait' | 'cancel' | 'retry') => g.service.resolve({ operationId: OP, attemptId: attempt.attemptId, decision, acceptDuplicateRisk: true });
    expect(await decide('retry')).toEqual({ status: 'refused', reason: 'in-flight' });
    expect(await g.service.reconcile(OP)).toEqual({ status: 'in-flight' });
    expect(await decide('wait')).toEqual({ status: 'recorded', decision: 'wait' });
    expect(await decide('cancel')).toEqual({ status: 'recorded', decision: 'cancel' });
    expect(valid(await g.store.get(OP)).delivery).toMatchObject({ state: 'unknown', attempts: [{ resolution: { decision: 'cancel' } }] });
  });

  // Review r1 P2: IDs are unique across deliveries, as in SQLite; a collision fails the claim before the runtime.
  it('a reused attempt or client message ID fails the claim, keeps the delivery pending and never calls the runtime', async () => {
    const g = gui(new MemoryDeliveryStore(), undefined, { uuid: () => '00000000-0000-4000-8000-00000000abcd' });
    await accepted(g);
    await accepted(g, payloadInput({ operationId: op('op-2') }));
    expect((await g.service.dispatch(OP)).status).toBe('sent');
    expect(await g.service.dispatch(op('op-2'))).toMatchObject({ status: 'not-dispatched', reason: 'store-failed' });
    expect(g.codex.dispatched).toHaveLength(1);
    expect(valid(await g.store.get(op('op-2'))).delivery).toEqual({ state: 'pending', attempts: [] });
  });
});

describe('provision and payload are separate deliveries', () => {
  const created = provisionInput().spec.preallocatedRef ?? '';

  it('a payload waits for its provision, then binds to the created session and is sent there', async () => {
    const g = gui();
    await accepted(g, provisionInput());
    await accepted(g, waitingPayload());
    const payload = op('payload-for-1');
    expect(await g.service.dispatch(payload)).toMatchObject({ status: 'not-dispatched', reason: 'provision-not-sent', provisionState: 'pending' });
    expect(g.claude.started.length + g.claude.dispatched.length).toBe(0);

    expect(await g.service.dispatch(op('provision-1'))).toMatchObject({ status: 'sent', nativeRef: { sessionRef: created } });
    expect(g.claude.started).toEqual([{ sessionId: 'session-new-1', cwd: 'E:/work', model: { runtime: 'claude', model: 'claude-sonnet-5-5' }, readOnly: true, preallocatedRef: created }]);
    expect(g.claude.dispatched).toHaveLength(0);

    expect(await g.service.dispatch(payload)).toMatchObject({ status: 'sent', nativeRef: { sessionRef: created } });
    expect(valid(await g.store.get(payload)).target).toMatchObject({ nativeSessionRef: created, provision: { state: 'sent', nativeSessionRef: created } });
    expect(g.history.received(created)).toHaveLength(1);
  });

  it('a lost create response leaves the provision unknown: never created again, payload kept pending and blocked', async () => {
    const g = gui();
    await accepted(g, provisionInput());
    await accepted(g, waitingPayload());
    g.claude.startModes.push('lost-response');
    expect(await g.service.dispatch(op('provision-1'))).toMatchObject({
      status: 'unknown',
      failure: { reason: 'adapter-error' },
      escalation: { reason: 'provision-unverifiable', deliveryKind: 'provision', blocked: ['payload-for-1'] },
    });
    // The runtime did create it, but nothing proves that read-only.
    expect(g.history.sessions).toEqual([created]);
    const { first, second, report } = await recoverTwice(g);
    expect(first.claude.started.length + second.claude.started.length + first.claude.dispatched.length + second.claude.dispatched.length).toBe(0);
    expect(report.dispatched).toEqual([{ operationId: 'payload-for-1', outcome: expect.objectContaining({ reason: 'provision-not-sent', provisionState: 'unknown' }) as unknown }]);
    expect(await stateOf(g, op('payload-for-1'))).toBe('pending');

    // Only the user's explicit retry creates it again (the pre-allocated ID is reused).
    const attempt = valid(await g.store.get(op('provision-1'))).delivery.attempts[0];
    if (attempt === undefined) throw new Error('no attempt');
    expect((await second.service.resolve({ operationId: op('provision-1'), attemptId: attempt.attemptId, decision: 'retry', acceptDuplicateRisk: true })).status).toBe('recorded');
    const after = await second.service.recover();
    expect(after.dispatched.map((d) => [d.operationId, d.outcome.status])).toEqual([
      ['provision-1', 'sent'],
      ['payload-for-1', 'sent'],
    ]);
    expect(second.claude.started).toHaveLength(1);
    expect(g.history.received(created)).toHaveLength(1);
  });

  // Review r1 P1: a cancel recorded after the create call left keeps the created session but sends no payload (CR2 §3).
  it('a cancel recorded by another GUI while the create call runs keeps the session and never sends the payload', async () => {
    const a = gui();
    await accepted(a, provisionInput());
    await accepted(a, waitingPayload());
    a.claude.startModes.push('held');
    const creating = a.service.dispatch(op('provision-1'));
    await flush();
    const attempt = valid(await a.store.get(op('provision-1'))).delivery.attempts[0];
    if (attempt === undefined) throw new Error('no attempt');
    const b = a.restart();
    expect(await b.service.resolve({ operationId: op('provision-1'), attemptId: attempt.attemptId, decision: 'cancel', acceptDuplicateRisk: false })).toEqual({
      status: 'recorded',
      decision: 'cancel',
    });
    // The create response arrives afterwards: the session is recorded, the cancel kept.
    a.claude.release();
    expect(await creating).toMatchObject({ status: 'sent', nativeRef: { sessionRef: created } });
    expect(valid(await a.store.get(op('provision-1')))).toMatchObject({
      target: { nativeSessionRef: created },
      delivery: { state: 'sent', attempts: [{ state: 'sent', resolution: { decision: 'cancel', decidedBy: 'user' } }] },
    });
    const report = await b.service.recover();
    expect(report.dispatched).toEqual([
      { operationId: 'payload-for-1', outcome: expect.objectContaining({ status: 'not-dispatched', reason: 'provision-cancelled', provisionState: 'sent' }) as unknown },
    ]);
    expect(await a.service.dispatch(op('payload-for-1'))).toMatchObject({ status: 'not-dispatched', reason: 'provision-cancelled' });
    expect(a.claude.dispatched.length + b.claude.dispatched.length).toBe(0);
    // Left pending and unbound: cancel is the operation's outcome, kept by the layer above, not a delivery state.
    expect(valid(await a.store.get(op('payload-for-1')))).toMatchObject({ target: waitingPayload().target, delivery: { state: 'pending', attempts: [] } });
    expect(a.history.received()).toHaveLength(0);
  });

  it('the same GUI records a cancel while its own create call runs, but refuses a retry', async () => {
    const g = gui();
    await accepted(g, provisionInput());
    await accepted(g, waitingPayload());
    g.claude.startModes.push('held');
    const creating = g.service.dispatch(op('provision-1'));
    await flush();
    const attempt = valid(await g.store.get(op('provision-1'))).delivery.attempts[0];
    if (attempt === undefined) throw new Error('no attempt');
    const decide = (decision: 'cancel' | 'retry') => g.service.resolve({ operationId: op('provision-1'), attemptId: attempt.attemptId, decision, acceptDuplicateRisk: true });
    expect(await decide('retry')).toEqual({ status: 'refused', reason: 'in-flight' });
    expect(await decide('cancel')).toEqual({ status: 'recorded', decision: 'cancel' });
    g.claude.release();
    expect((await creating).status).toBe('sent');
    expect(await g.service.dispatch(op('payload-for-1'))).toMatchObject({ status: 'not-dispatched', reason: 'provision-cancelled' });
    expect((await g.service.recover()).dispatched.map((d) => d.outcome)).toMatchObject([{ reason: 'provision-cancelled' }]);
    expect(g.claude.started).toHaveLength(1);
    expect(g.claude.dispatched).toHaveLength(0);
  });

  it('a cancelled provision whose result stays unknown blocks its payload as cancelled', async () => {
    const g = gui();
    await accepted(g, provisionInput());
    await accepted(g, waitingPayload());
    g.claude.startModes.push('lost-response');
    const outcome = await g.service.dispatch(op('provision-1'));
    if (outcome.status !== 'unknown') throw new Error('expected unknown');
    await g.service.resolve({ operationId: op('provision-1'), attemptId: outcome.attemptId, decision: 'cancel', acceptDuplicateRisk: false });
    expect(await g.service.dispatch(op('payload-for-1'))).toMatchObject({ status: 'not-dispatched', reason: 'provision-cancelled', provisionState: 'unknown' });
    expect(g.claude.started).toHaveLength(1);
    expect(g.claude.dispatched).toHaveLength(0);
  });

  it('recovery dispatches provisions before the payloads that wait for them', async () => {
    const g = gui();
    // The payload is accepted first, so acceptance order alone would try it before its provision.
    await accepted(g, waitingPayload('1', { at: at(-1) }));
    await accepted(g, provisionInput());
    const report = await g.restart().service.recover();
    expect(report.dispatched.map((d) => [d.operationId, d.outcome.status])).toEqual([
      ['provision-1', 'sent'],
      ['payload-for-1', 'sent'],
    ]);
  });

  it('recovery leaves pending deliveries the caller skips for its own schedule', async () => {
    const g = await accepted(gui());
    const report = await g.service.recover({ select: (r) => (r.kind === 'handoff' ? 'skip' : {}) });
    expect(report.dispatched).toEqual([]);
    expect(await stateOf(g)).toBe('pending');
  });
});
