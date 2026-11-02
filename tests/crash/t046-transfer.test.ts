// T046 r2 P1: a transfer's payload whose outcome stayed unknown, retried by the user after a restart, to a Codex target
// whose thread its runtime never stored (no turn ran, so no rollout): the retry is answered plainly, the payload stays
// saved and unsent, the target shows error. The transfer world on memory storage (core/transfer/testing).
import { describe, expect, it } from 'vitest';
import { TransferId } from '../../contracts';
import { RuntimeDisk } from '../../core/sessions/testing/fake-adapter';
import { targetSessionOf } from '../../core/transfer/ids';
import { confirm, dispatches, prepare, proposal, rid, settle, source, world, type World } from '../../core/transfer/testing/harness';

const T = TransferId.parse('tr-t046');
const target = targetSessionOf(T);

describe('T046 r2 P1: a transfer retry its Codex target cannot take', () => {
  it('is answered runtime_unavailable with the reason; the payload stays pending and unsent; the target shows error', async () => {
    const w = await world();
    const s = await source(w);
    expect(await prepare(w, s, T)).toMatchObject({ ok: true });
    // The payload leaves without an ack and the runtime stores nothing of it: unknown, escalated at the source.
    const disk = new RuntimeDisk();
    w.configure = (adapter, sessionId) => {
      if (sessionId !== target) return;
      adapter.dispatchModes = ['lost'];
      adapter.diskOf = () => disk;
    };
    expect(await confirm(w, T)).toMatchObject({ ok: false, code: 'unknown_outcome' });
    const toTarget = (x: World) => dispatches(x).filter((d) => x.refs.get(d.nativeSessionRef) === target);
    expect(toTarget(w)).toHaveLength(1);

    const after = await w.restart();
    const [escalation] = (await after.repositories.escalations.list({ state: 'open' })).filter((e) => e.kind === 'delivery-unknown');
    expect(escalation?.ref).toMatchObject({ kind: 'transfer', transferId: T });
    const result = await after.run({ type: 'delivery.resolve', requestId: rid(), escalationId: escalation!.id, decision: 'retry', acceptDuplicateRisk: true });
    await settle();
    expect(result).toMatchObject({ ok: false, code: 'runtime_unavailable' });
    expect(result.ok ? '' : result.message).toMatch(/^The retry is saved, but it cannot be sent: /);
    expect((await proposal(after, T)).delivery).toMatchObject({ state: 'pending', attempts: [{ state: 'unknown', resolution: { decision: 'retry' } }] });
    expect(toTarget(after)).toEqual([]);
    expect((await after.repositories.sessions.get(target))?.activity).toBe('error');
  });
});
