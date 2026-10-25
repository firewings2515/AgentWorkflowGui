import { describe, expect, it } from 'vitest';
import { CommandResult, Snapshot, type Command, type EventEnvelope } from '../../contracts';
import { fixtureSnapshot } from '../../contracts/fixtures/snapshot';
import { EventBus } from './event-bus';
import { createFakeFacade } from './facade';

const setup = () => {
  const bus = new EventBus({ seq: fixtureSnapshot.seq });
  const events: EventEnvelope[] = [];
  bus.subscribe((envelope) => events.push(envelope));
  const facade = createFakeFacade({ bus, now: () => new Date('2026-10-26T02:00:00Z') });
  return { bus, events, facade };
};

const reparent = (sessionId: string, parentId: string | null, expectedRevision: number) =>
  ({ type: 'session.reparent', requestId: `req-${sessionId}`, sessionId, parentId, expectedRevision }) as unknown as Command;

describe('fake facade', () => {
  it('starts from a Snapshot that matches the contract and the bus seq', () => {
    const { facade } = setup();
    const snapshot = facade.snapshot();
    expect(Snapshot.safeParse(snapshot).success).toBe(true);
    expect(snapshot.seq).toBe(fixtureSnapshot.seq);
  });

  it('keeps preferences.set in memory', () => {
    const { facade, events } = setup();
    const before = facade.snapshot().preferences.theme;
    const next = before === 'dark' ? 'light' : 'dark';

    const result = facade.execute({ type: 'preferences.set', requestId: 'req-pref', preferences: { theme: next } } as unknown as Command);

    expect(CommandResult.parse(result)).toMatchObject({ ok: true, requestId: 'req-pref' });
    expect(facade.snapshot().preferences.theme).toBe(next);
    expect(events).toEqual([]); // no event type exists for preferences
  });

  it('answers unsupported for commands it does not implement', async () => {
    const { facade } = setup();
    const result = await facade.execute({ type: 'session.interrupt', requestId: 'req-int', sessionId: 's-research' } as unknown as Command);
    expect(result).toMatchObject({ ok: false, requestId: 'req-int', code: 'unsupported', retryable: false, mayHaveSideEffects: false });
  });

  it('reparents an ordinary session, publishes session.updated and moves the Snapshot seq with it', async () => {
    const { facade, events } = setup();

    const result = await facade.execute(reparent('s-research', null, 2));

    expect(result).toMatchObject({ ok: true, revision: 3 });
    expect(events).toHaveLength(1);
    expect(events[0]?.seq).toBe(fixtureSnapshot.seq + 1);
    expect(events[0]?.event).toMatchObject({ type: 'session.updated', session: { id: 's-research', revision: 3 } });
    const moved = facade.snapshot();
    expect(moved.seq).toBe(fixtureSnapshot.seq + 1);
    const session = moved.sessions.find((s) => s.id === 's-research');
    expect(session?.revision).toBe(3);
    expect(session?.parentId).toBeUndefined();
  });

  it.each([
    ['an unknown session', reparent('s-missing', null, 1), 'not_found'],
    ['an unknown parent', reparent('s-research', 's-missing', 2), 'not_found'],
    ['a stale revision', reparent('s-research', null, 1), 'stale_revision'],
    ['a move below itself', reparent('s-plan-notes', 's-research', 4), 'invalid_request'],
    ['a workflow session', reparent('s-wf-build-a', null, 3), 'invalid_transition'],
  ])('rejects %s without changing anything', async (_name, command, code) => {
    const { facade, events, bus } = setup();
    const before = facade.snapshot();

    const result = await facade.execute(command);

    expect(result).toMatchObject({ ok: false, code });
    expect(facade.snapshot()).toEqual(before);
    expect(events).toEqual([]);
    expect(bus.seq).toBe(fixtureSnapshot.seq);
  });
});
