// T033 (R-07): a file-change approval that arrives before its `item/started` waits for the item, so the GUI
// knows which files to lock; without the item it goes up as it is after a short wait.
import { describe, expect, it } from 'vitest';
import { loadFixture, notify, out, outResponse, recordedResult, reply, type ReplayRecord, serverRequest } from './testing/fake-app-server';
import { expectValidEvents, SESSION, setup, until } from './testing/harness';

const sp01 = loadFixture('sp01-create.jsonl');
const THREAD_ID = '01a16795-2bff-74f2-9fd1-6198ee6b4ee7';
const TURN_ID = '01a16795-3172-7802-a04e-3b9e5974a6f9';

const handshake = (): ReplayRecord[] => [
  out('initialize', 1),
  reply(1, recordedResult(sp01, 'initialize')),
  out('initialized'),
  out('thread/resume', 2),
  reply(2, recordedResult(sp01, 'thread/start')),
];

const started = async (records: ReplayRecord[], options: Parameters<typeof setup>[1] = {}) => {
  const h = setup([...handshake(), ...records], options);
  await h.adapter.start();
  await h.adapter.resumeThread({ sessionId: SESSION, threadId: THREAD_ID });
  return h;
};

const turnStarted = notify('turn/started', {
  threadId: THREAD_ID,
  turn: { id: TURN_ID, items: [], status: 'inProgress', error: null, startedAt: 1792739193, completedAt: null },
});
const approval = serverRequest(12, 'item/fileChange/requestApproval', { threadId: THREAD_ID, turnId: TURN_ID, itemId: 'patch-1', startedAtMs: 1, reason: null, grantRoot: null });
const patchStarted = notify('item/started', {
  threadId: THREAD_ID,
  turnId: TURN_ID,
  startedAtMs: 1792739195000,
  item: { type: 'fileChange', id: 'patch-1', status: 'inProgress', changes: [{ path: 'E:\\work\\shared\\a.txt', kind: { type: 'update', move_path: null }, diff: '' }] },
});

describe('file-change approval before its item (R-07)', () => {
  it('goes up only once item/started named the files, with those paths', async () => {
    const h = await started([turnStarted, approval, patchStarted, outResponse(12)]);
    await until(() => h.permissions.length === 1, 'approval after the item');
    // The item came first in what the upper layer saw, then the request with its files.
    const kinds = h.events.filter((e) => e.type === 'item.updated' || e.type === 'permission.updated').map((e) => e.type);
    expect(kinds.slice(0, 2)).toEqual(['item.updated', 'permission.updated']);
    expect(h.permissions[0]!.request).toMatchObject({ kind: 'fileChange', itemId: 'patch-1', paths: ['E:\\work\\shared\\a.txt'] });
    h.permissions[0]!.answer({ outcome: 'approve', decidedBy: 'policy', at: '2026-10-24T12:00:00.000Z' });
    await until(() => h.fake.finished, 'script');
    expect(h.fake.received.at(-1)).toEqual({ id: 12, result: { decision: 'accept' } });
    expect(h.fake.mismatches).toEqual([]);
    expectValidEvents(h.events);
  });

  it('goes up without files after the wait when no item comes', async () => {
    const h = await started([turnStarted, approval, outResponse(12)], { fileChangeItemWaitMs: 20 });
    await until(() => h.permissions.length === 1, 'approval after the wait');
    expect(h.permissions[0]!.request).toMatchObject({ kind: 'fileChange', paths: [] });
    h.permissions[0]!.answer({ outcome: 'decline', decidedBy: 'policy', at: '2026-10-24T12:00:00.000Z' });
    await until(() => h.fake.finished, 'script');
    expect(h.fake.received.at(-1)).toEqual({ id: 12, result: { decision: 'decline' } });
  });
});
