// T036 idle supervisor on memory storage; the same cases run on SQLite in app/main/supervisor-sqlite.test.ts.
import { describe, expect, it } from 'vitest';
import { MemoryDeliveryStore } from '../delivery/testing/memory-store';
import { MemoryRepositories } from '../sessions/testing/memory-repositories';
import { busyReasons, type IdleFacts } from './idle';
import { supervisorCases } from './testing/cases';
import { supWorldOn } from './testing/harness';

supervisorCases('memory', (o) => supWorldOn(new MemoryRepositories(), new MemoryDeliveryStore(), o));

describe('busyReasons', () => {
  const idle: IdleFacts = {
    activity: 'idle',
    turns: [],
    items: [],
    nativeTasks: [],
    ackedTurns: 0,
    handoffTurn: false,
    heldRequests: 0,
    deliveries: { pending: 0, unknown: 0 },
    locks: 0,
    ownedCommands: 0,
  };

  it('is empty only when nothing runs, waits or is on its way', () => {
    expect(busyReasons(idle)).toEqual([]);
    expect(busyReasons({ ...idle, activity: 'closed' })).toEqual([]);
  });

  it('names every reason', () => {
    expect(
      busyReasons({
        activity: 'waiting-user',
        turns: [{ state: 'running' } as never],
        items: [{ state: 'proposed' } as never],
        nativeTasks: [{ state: 'running' } as never],
        ackedTurns: 1,
        handoffTurn: true,
        heldRequests: 1,
        deliveries: { pending: 1, unknown: 1 },
        locks: 1,
        ownedCommands: 1,
      }),
    ).toEqual([
      'busy-activity',
      'turn-running',
      'turn-acked',
      'handoff-turn',
      'command-running',
      'native-task-running',
      'held-request',
      'delivery-pending',
      'delivery-unknown',
      'lock-held',
      'owned-process',
    ]);
  });

  it('a reconciling session (its last delivery unknown) is not idle', () => {
    expect(busyReasons({ ...idle, activity: 'reconciling' })).toEqual(['busy-activity']);
  });
});
