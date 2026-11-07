// T065 in the delivery service: an insert whose ack timed out may be reconciled later (`reconcileLater`): it stays
// unknown with `deferred` and no escalation; `reconcile` with `escalate: false` looks without asking the user. Every
// other dispatch is reconciled at once, as before.
import { describe, expect, it } from 'vitest';
import { OP, gui, payloadInput } from './testing/fixtures';

const INSERT = { entry: { kind: 'insert' as const }, reconcileLater: true };

const ready = async () => {
  const g = gui();
  expect((await g.service.accept(payloadInput())).status).toBe('accepted');
  return g;
};

describe('T065: reconcileLater', () => {
  it('an insert that timed out: unknown and deferred, not reconciled, nothing escalated', async () => {
    const g = await ready();
    g.codex.dispatchModes.push('timeout');
    expect(await g.service.dispatch(OP, INSERT)).toMatchObject({ status: 'unknown', deferred: true, failure: { reason: 'timeout', written: true } });
    expect(g.codex.reconciled).toEqual([]);
    expect(g.escalations).toEqual([]);
    expect((await g.store.get(OP))?.delivery.state).toBe('unknown');
    // Reconciled later (the runtime stored it meanwhile): sent, once.
    expect(await g.service.reconcile(OP, { escalate: false })).toMatchObject({ status: 'sent' });
    expect((await g.store.get(OP))?.delivery.state).toBe('sent');
    expect(g.codex.dispatched).toHaveLength(1);
  });

  it('escalate: false finds nothing: unconfirmed, nothing escalated; the default reconcile escalates then', async () => {
    const g = await ready();
    g.codex.dispatchModes.push('timeout');
    const outcome = await g.service.dispatch(OP, INSERT);
    if (outcome.status !== 'unknown') throw new Error(outcome.status);
    g.codex.reconcileModes.push('read-failed', 'read-failed');
    expect(await g.service.reconcile(OP, { escalate: false })).toEqual({ status: 'unconfirmed', attemptId: outcome.attemptId, reason: 'read-failed', detail: 'paging failed' });
    expect(g.escalations).toEqual([]);
    expect(await g.service.reconcile(OP)).toMatchObject({ status: 'unknown', escalation: { reason: 'read-failed', operationId: OP } });
    expect(g.escalations).toHaveLength(1);
    expect(g.codex.dispatched).toHaveLength(1);
  });

  it('only an insert that timed out waits: a new turn, or another failure of an insert, is reconciled at once', async () => {
    for (const [mode, options] of [
      ['timeout', { reconcileLater: true }],
      ['throw', INSERT],
    ] as const) {
      const g = await ready();
      g.codex.dispatchModes.push(mode);
      const outcome = await g.service.dispatch(OP, options);
      expect(outcome).not.toHaveProperty('deferred');
      expect(g.codex.reconciled).toHaveLength(1);
    }
  });

  it('without reconcileLater an insert that timed out is reconciled at once, as before T065', async () => {
    const g = await ready();
    g.codex.dispatchModes.push('timeout');
    expect(await g.service.dispatch(OP, { entry: { kind: 'insert' } })).toMatchObject({ status: 'sent' });
    expect(g.codex.reconciled).toHaveLength(1);
  });
});
