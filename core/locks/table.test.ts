// The lock table (T033, R-07, SP-06): one holder per file, the write lifecycle, release after the turn and
// its background work, waits (free / not-locked / timeout / deadlock / cancelled) and unlocked writes.
import { describe, expect, it } from 'vitest';
import { FileLock, type LockWaiter, type PayloadHash, type SessionId, type TurnId } from '../../contracts';
import { MemoryLockTable } from './table';
import { ManualClock } from './testing/clock';

const A = 'sess-a' as SessionId;
const B = 'sess-b' as SessionId;
const C = 'sess-c' as SessionId;
const T1 = 'turn-1' as TurnId;
const T2 = 'turn-2' as TurnId;
const F = 'e:\\work\\shared.txt';
const G = 'e:\\work\\other.txt';
const h = (n: number): PayloadHash => `sha256:${String(n).repeat(64).slice(0, 64)}`;

const setup = (scope: (path: string) => boolean = () => false) => {
  const clock = new ManualClock();
  const published: FileLock[][] = [];
  const table = new MemoryLockTable({ now: clock.now, setTimer: clock.setTimer, inSameFolderScope: scope });
  table.subscribe((locks) => published.push(locks));
  /** `hash`: the file now; null when it does not exist. */
  const take = (sessionId: SessionId, path = F, turnId: TurnId | undefined = T1, hash: PayloadHash | null = h(1)) =>
    table.acquire({ path, sessionId, ...(turnId !== undefined && { turnId }), at: clock.now() }, hash ?? undefined);
  const waiter = (sessionId: SessionId, ms = 60_000, via: LockWaiter['via'] = 'wait_for_file'): LockWaiter => ({
    sessionId,
    via,
    ...(via === 'codex-approval' && { permissionRequestId: `req-${sessionId}` as LockWaiter['permissionRequestId'] }),
    since: clock.now(),
    deadline: new Date(Date.parse(clock.now()) + ms).toISOString(),
  });
  return { clock, table, published, take, waiter };
};

describe('acquire', () => {
  it('gives a file to one session at a time and says who holds it', () => {
    const { table, take } = setup();
    expect(take(A).status).toBe('acquired');
    const other = take(B);
    expect(other).toMatchObject({ status: 'held', lock: { holderSessionId: A, writing: 1 } });
    // Refused: nothing of B's started.
    expect(table.list()).toHaveLength(1);
    expect(take(A)).toMatchObject({ status: 'held-by-self', lock: { writing: 2 } });
  });

  it('counts each write started until writeEnded ends it exactly once', () => {
    const { table, take } = setup();
    take(A);
    take(A);
    table.writeEnded(A, F, { kind: 'failed' });
    expect(table.list()[0]!.writing).toBe(1);
    table.writeEnded(A, F, { kind: 'written', hash: h(2) });
    table.writeEnded(A, F, { kind: 'written', hash: h(3) });
    expect(table.list()[0]).toMatchObject({ writing: 0, lastWrite: { kind: 'written', hash: h(2) } });
    // Another session cannot end the holder's write.
    take(A, F, T1, h(2));
    table.writeEnded(B, F, { kind: 'failed' });
    expect(table.list()[0]!.writing).toBe(1);
  });

  it('refuses a write to a file that changed since the session read it, and takes nothing (SP-06 W4)', () => {
    const { table, take } = setup();
    table.recordRead(A, F, h(1));
    expect(take(A, F, T1, h(2))).toEqual({ status: 'changed-since-read', path: F });
    expect(take(A, F, T1, null)).toEqual({ status: 'changed-since-read', path: F });
    expect(table.list()).toEqual([]);
    expect(take(A, F, T1, h(1)).status).toBe('acquired');
  });

  it("checks the holder's next write against what it wrote, not its older read", () => {
    const { table, take } = setup();
    table.recordRead(A, F, h(1));
    take(A, F, T1, h(1));
    table.writeEnded(A, F, { kind: 'written', hash: h(2) });
    expect(take(A, F, T1, h(2)).status).toBe('held-by-self');
    table.writeEnded(A, F, { kind: 'deleted' });
    // Deleted: no read left to check; a new file may be written.
    expect(take(A, F, T1, null).status).toBe('held-by-self');
  });

  it('checks reads per session: another session that never read the file is not refused', () => {
    const { table, take } = setup();
    table.recordRead(A, F, h(1));
    expect(take(B, F, T1, h(9)).status).toBe('acquired');
  });
});

describe('release', () => {
  it('holds the lock until the turn ended and its background commands ended (SP-06 W3)', () => {
    const { table, take } = setup();
    take(A);
    table.writeEnded(A, F, { kind: 'written', hash: h(2) });
    table.backgroundCommands(A, 1);
    table.turnEnded(A, T1);
    expect(table.list()[0]).toMatchObject({ holderSessionId: A, waitingForBackground: true });
    expect(take(B).status).toBe('held');
    table.backgroundCommands(A, 0);
    expect(table.list()).toEqual([]);
  });

  it('keeps the lock when the background work ends before the turn', () => {
    const { table, take } = setup();
    take(A);
    table.writeEnded(A, F, { kind: 'failed' });
    table.backgroundCommands(A, 1);
    table.backgroundCommands(A, 0);
    expect(table.list()).toHaveLength(1);
    table.turnEnded(A, T1);
    expect(table.list()).toEqual([]);
  });

  it('ignores the late end of an older turn while a newer one writes', () => {
    const { table, take } = setup();
    take(A, F, T2);
    table.turnEnded(A, T1);
    table.writeEnded(A, F, { kind: 'failed' });
    expect(table.list()).toHaveLength(1);
    table.turnEnded(A, T2);
    expect(table.list()).toEqual([]);
  });

  it('lets a write named after an ended turn go once it ends (a late sub-agent write)', () => {
    const { table, take } = setup();
    table.turnEnded(A, T1);
    take(A, F, T1);
    expect(table.list()).toHaveLength(1);
    table.writeEnded(A, F, { kind: 'written', hash: h(2) });
    expect(table.list()).toEqual([]);
  });

  it('a new turn takes over a lock held for an earlier turn’s background work', () => {
    const { table, take } = setup();
    take(A, F, T1);
    table.writeEnded(A, F, { kind: 'failed' });
    table.backgroundCommands(A, 1);
    table.turnEnded(A, T1);
    take(A, F, T2);
    expect(table.list()[0]).toMatchObject({ holderTurnId: T2, waitingForBackground: false });
    table.writeEnded(A, F, { kind: 'failed' });
    table.backgroundCommands(A, 0);
    // T2 still runs.
    expect(table.list()).toHaveLength(1);
  });

  it('releaseAll ends writes, cancels its own waits, frees its locks and forgets its reads', async () => {
    const { table, take, waiter } = setup();
    take(A, F);
    take(B, G);
    table.recordRead(A, G, h(1));
    const aWaits = table.wait(G, waiter(A));
    const cWaits = table.wait(F, waiter(C));
    table.releaseAll(A, 'runtime-exited');
    expect(await aWaits).toEqual({ status: 'cancelled' });
    expect(await cWaits).toEqual({ status: 'free' });
    expect(table.list().map((l) => l.path)).toEqual([G]);
    expect(table.list()[0]!.waiters).toEqual([]);
    expect(take(A, F, T1, h(5)).status).toBe('acquired');
  });
});

describe('wait', () => {
  it('is free when the lock goes, not-locked when there is none, free at once for the holder', async () => {
    const { table, take, waiter } = setup();
    expect(await table.wait(F, waiter(B))).toEqual({ status: 'not-locked' });
    take(A);
    expect(await table.wait(F, waiter(A))).toEqual({ status: 'free' });
    const waiting = table.wait(F, waiter(B, 60_000, 'codex-approval'));
    expect(table.list()[0]!.waiters).toEqual([expect.objectContaining({ sessionId: B, via: 'codex-approval' })]);
    table.writeEnded(A, F, { kind: 'failed' });
    table.turnEnded(A, T1);
    expect(await waiting).toEqual({ status: 'free' });
  });

  it('ends at the deadline at the latest', async () => {
    const { clock, table, take, waiter } = setup();
    take(A);
    const waiting = table.wait(F, waiter(B, 1000));
    clock.advance(999);
    clock.advance(1);
    expect(await waiting).toEqual({ status: 'timeout' });
    expect(table.list()[0]!.waiters).toEqual([]);
    expect(await table.wait(F, waiter(B, 0))).toEqual({ status: 'timeout' });
  });

  it('refuses a wait that would close a cycle of two or three sessions', async () => {
    const { table, take, waiter } = setup();
    const H = 'e:\\work\\third.txt';
    take(A, F);
    take(B, G);
    take(C, H);
    void table.wait(G, waiter(A));
    expect(await table.wait(F, waiter(B))).toEqual({ status: 'deadlock', cycle: [B, A] });
    void table.wait(H, waiter(B));
    expect(await table.wait(F, waiter(C))).toEqual({ status: 'deadlock', cycle: [C, A, B] });
    // Refused waits were not added.
    expect(table.list().find((l) => l.path === F)!.waiters).toEqual([]);
  });

  it('joins a second wait of the same session, so waiters stay distinct', async () => {
    const { table, take, waiter } = setup();
    take(A);
    const one = table.wait(F, waiter(B));
    const two = table.wait(F, waiter(B));
    expect(table.list()[0]!.waiters).toHaveLength(1);
    table.cancelWait(B, F);
    expect(await one).toEqual({ status: 'cancelled' });
    expect(await two).toEqual({ status: 'cancelled' });
  });
});

describe('fileChanged (R-07, SP-06 W5/W6)', () => {
  it('expects the holder’s changes only while a write is in progress', () => {
    const { table, take } = setup();
    take(A);
    expect(table.fileChanged(F, h(7))).toBe(false);
    table.writeEnded(A, F, { kind: 'written', hash: h(2) });
    // A late event of the holder's own write: the same content.
    expect(table.fileChanged(F, h(2))).toBe(false);
    expect(table.fileChanged(F, h(3))).toBe(true);
    expect(table.fileChanged(F, undefined)).toBe(true);
  });

  it('flags any change while the holder applied nothing yet, and a re-created file after its delete', () => {
    const { table, take } = setup();
    take(A);
    table.writeEnded(A, F, { kind: 'failed' });
    expect(table.fileChanged(F, h(1))).toBe(true);
    take(A);
    table.writeEnded(A, F, { kind: 'deleted' });
    expect(table.fileChanged(F, undefined)).toBe(false);
    expect(table.fileChanged(F, h(1))).toBe(true);
  });

  it('flags an unlocked file only in same-folder scope', () => {
    const { table } = setup((path) => path.startsWith('e:\\work\\'));
    expect(table.fileChanged(F, h(1))).toBe(true);
    expect(table.fileChanged('e:\\elsewhere\\x.txt', h(1))).toBe(false);
  });
});

describe('locks.updated', () => {
  it('publishes the whole list after each change, every entry a valid FileLock', async () => {
    const { table, published, take, waiter } = setup();
    take(A);
    const waiting = table.wait(F, waiter(B, 60_000, 'codex-approval'));
    table.writeEnded(A, F, { kind: 'written', hash: h(2) });
    table.backgroundCommands(A, 1);
    table.turnEnded(A, T1);
    table.backgroundCommands(A, 0);
    await waiting;
    expect(published.length).toBeGreaterThanOrEqual(5);
    expect(published.at(-1)).toEqual([]);
    for (const locks of published) for (const lock of locks) expect(FileLock.safeParse(lock).success).toBe(true);
    expect(published.some((locks) => locks[0]?.waitingForBackground === true && locks[0].waiters.length === 1)).toBe(true);
  });
});
