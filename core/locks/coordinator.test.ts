// The lock coordinator (T033, R-07, SP-06): the lock step before an approval, the events that end writes
// and turns, Codex holds, wait_for_file and unlocked writes. Written with the windows KNOWLEDGE §4-5 lists
// in mind: out-of-order and repeated events, a runtime that exits, a request withdrawn while it waits,
// and nothing awaited between the lock and the answer.
import { describe, expect, it } from 'vitest';
import {
  type FileLock,
  type ItemId,
  type LogicalSession,
  type PayloadHash,
  type PermissionDecision,
  type PermissionHold,
  type PermissionRequest,
  type PermissionRequestId,
  type SessionId,
  type SessionItem,
  type TurnId,
} from '../../contracts';
import type { PermissionHandle, RuntimeEvent } from '../ports';
import { type FileState, LockCoordinator, type LockEscalation } from './coordinator';
import { ManualClock } from './testing/clock';

const A = 'sess-a' as SessionId;
const B = 'sess-b' as SessionId;
const T1 = 'turn-1' as TurnId;
const TB = 'turn-b' as TurnId;
const ROOT = 'E:\\work';
const F = 'E:\\work\\shared.txt';
const G = 'E:\\work\\other.txt';
const fk = (p: string) => p.toLowerCase();
const h = (n: number): PayloadHash => `sha256:${String(n).repeat(64).slice(0, 64)}`;
const AT = '2026-10-31T00:00:00.000Z';

const session = (id: SessionId, extra: Partial<LogicalSession['folderScope']> = {}): LogicalSession =>
  ({ id, title: `title of ${id}`, cwd: ROOT, folderScope: { source: 'session-cwd', workspaceRoot: ROOT, writableRoots: [ROOT], readableRoots: [], ...extra } }) as unknown as LogicalSession;

interface FakeHandle extends PermissionHandle {
  answers: PermissionDecision[];
  holds: PermissionHold[];
  open: boolean;
  onAnswer?: () => void;
}

const handle = (request: PermissionRequest): FakeHandle => {
  const fake: FakeHandle = {
    request,
    answers: [],
    holds: [],
    open: true,
    hold(hold) {
      if (!fake.open) return false;
      fake.holds.push(hold);
      return true;
    },
    answer(decision) {
      if (!fake.open) return false;
      fake.onAnswer?.();
      fake.answers.push(decision);
      fake.open = false;
      return true;
    },
  };
  return fake;
};

let ids = 0;
const write = (sessionId: SessionId, paths: string[], o: { claude?: boolean; itemId?: string; turnId?: TurnId } = {}): PermissionRequest => ({
  id: `req-${++ids}` as PermissionRequestId,
  sessionId,
  turnId: o.turnId ?? (sessionId === A ? T1 : TB),
  itemId: (o.itemId ?? `item-${ids}`) as ItemId,
  kind: 'fileChange',
  ...(o.claude === true && { tool: 'Edit' }),
  summary: 'edit',
  paths,
  state: 'pending',
  createdAt: AT,
});
const read = (sessionId: SessionId, path: string, itemId: string): PermissionRequest => ({
  id: `req-${++ids}` as PermissionRequestId,
  sessionId,
  turnId: T1,
  itemId: itemId as ItemId,
  kind: 'permissions',
  tool: 'Read',
  summary: 'read',
  paths: [path],
  state: 'pending',
  createdAt: AT,
});
const approve: PermissionDecision = { outcome: 'approve', decidedBy: 'policy', at: AT };

const fileItem = (request: PermissionRequest, state: 'proposed' | 'applied' | 'failed', changes = request.paths.map((path) => ({ path, change: 'update' as const }))): RuntimeEvent => ({
  type: 'item.updated',
  item: { id: request.itemId!, sessionId: request.sessionId, turnId: request.turnId!, kind: 'fileChange', changes, state, startedAt: AT, ...(state !== 'proposed' && { endedAt: AT }) } as SessionItem,
});
const turnEnd = (sessionId: SessionId, turnId: TurnId): RuntimeEvent => ({
  type: 'turn.updated',
  turn: { id: turnId, sessionId, state: 'completed', startedAt: AT, endedAt: AT } as never,
});
const turnRun = (sessionId: SessionId, turnId: TurnId): RuntimeEvent => ({ type: 'turn.updated', turn: { id: turnId, sessionId, state: 'running', startedAt: AT } as never });
const bgCommand = (sessionId: SessionId, id: string, state: 'running' | 'completed'): RuntimeEvent => ({
  type: 'item.updated',
  item: { id, sessionId, kind: 'command', command: 'sleep 9', cwd: ROOT, background: true, state, output: '', outputTruncated: false, startedAt: AT, ...(state !== 'running' && { endedAt: AT }) } as SessionItem,
});

const setup = (o: { holdMs?: number } = {}) => {
  const clock = new ManualClock(AT);
  const files = new Map<string, FileState>([
    [fk(F), h(1)],
    [fk(G), h(1)],
  ]);
  const escalations: LockEscalation[] = [];
  const published: FileLock[][] = [];
  const locks = new LockCoordinator({
    now: clock.now,
    setTimer: clock.setTimer,
    hashFile: (path) => files.get(fk(path)) ?? 'missing',
    resolveRealPath: (p) => p,
    escalate: (e) => {
      escalations.push(e);
      return Promise.resolve(`esc-${String(escalations.length)}` as never);
    },
    publish: (l) => published.push(l),
    ...(o.holdMs !== undefined && { holdMs: o.holdMs }),
  });
  locks.track(session(A));
  locks.track(session(B));
  const lockOf = (path: string) => locks.list().find((l) => l.path === fk(path));
  return { clock, files, escalations, published, locks, lockOf };
};

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('Claude writes (PreToolUse)', () => {
  it('takes the lock at the approval, with nothing awaited before the answer', () => {
    const { locks, lockOf } = setup();
    const req = write(A, [F], { claude: true });
    const hd = handle(req);
    let seenWhileAnswering: FileLock | undefined;
    hd.onAnswer = () => (seenWhileAnswering = lockOf(F));
    expect(locks.approve(hd, approve, session(A))).toBe('approved');
    expect(seenWhileAnswering).toMatchObject({ holderSessionId: A, writing: 1 });
  });

  it("refuses another session's write with who holds it and how to wait (SP-06 W3)", () => {
    const { locks } = setup();
    void locks.approve(handle(write(A, [F], { claude: true })), approve, session(A));
    const req = write(B, [F], { claude: true });
    const screened = locks.screen(req, session(B));
    expect(screened).toContain('title of sess-a');
    expect(screened).toContain('mcp__gui__wait_for_file');
    const hd = handle(req);
    expect(locks.approve(hd, approve, session(B))).toBe('refused');
    expect(hd.answers[0]).toMatchObject({ outcome: 'decline', reason: expect.stringContaining('sess-a') as unknown });
  });

  it('ends the write with the file it left, once its item ends; a repeated end changes nothing', () => {
    const { locks, files, lockOf } = setup();
    const req = write(A, [F], { claude: true });
    locks.observe(fileItem(req, 'proposed'));
    void locks.approve(handle(req), approve, session(A));
    files.set(fk(F), h(2));
    locks.observe(fileItem(req, 'applied'));
    expect(lockOf(F)).toMatchObject({ writing: 0, lastWrite: { kind: 'written', hash: h(2) } });
    locks.observe(fileItem(req, 'applied'));
    expect(lockOf(F)!.writing).toBe(0);
  });

  it('refuses a write after another session changed the file it read, and asks for a new read (SP-06 W4)', () => {
    const { locks, files } = setup();
    const r = read(A, F, 'read-1');
    expect(locks.approve(handle(r), approve, session(A))).toBe('approved');
    locks.observe({ type: 'item.updated', item: { id: 'read-1', sessionId: A, turnId: T1, kind: 'toolCall', tool: 'Read', summary: 'Read', state: 'completed', startedAt: AT, endedAt: AT } as SessionItem });
    // B writes it meanwhile and its turn ends.
    const bw = write(B, [F]);
    void locks.approve(handle(bw), approve, session(B));
    files.set(fk(F), h(5));
    locks.observe(fileItem(bw, 'applied'));
    locks.observe(turnEnd(B, TB));
    const hd = handle(write(A, [F], { claude: true }));
    expect(locks.approve(hd, approve, session(A))).toBe('refused');
    expect(hd.answers[0]!.reason).toContain('Read the file again');
  });

  it('counts a read during which the file changed as a read of the older content', () => {
    const { locks, files } = setup();
    void locks.approve(handle(read(A, F, 'read-2')), approve, session(A));
    files.set(fk(F), h(3));
    locks.observe({ type: 'item.updated', item: { id: 'read-2', sessionId: A, turnId: T1, kind: 'toolCall', tool: 'Read', summary: 'Read', state: 'completed', startedAt: AT, endedAt: AT } as SessionItem });
    const hd = handle(write(A, [F], { claude: true }));
    expect(locks.approve(hd, approve, session(A))).toBe('refused');
  });

  it('ends the writes it started when the request was withdrawn before the answer', () => {
    const { locks, lockOf } = setup();
    const hd = handle(write(A, [F, G], { claude: true }));
    hd.open = false;
    expect(locks.approve(hd, approve, session(A))).toBe('gone');
    expect(lockOf(F)!.writing).toBe(0);
    expect(lockOf(G)!.writing).toBe(0);
  });
});

describe('Codex writes (held approval, SP-06 W3)', () => {
  it('holds the approval until the lock frees, then takes it and approves', async () => {
    const { locks, lockOf } = setup();
    const aw = write(A, [F]);
    void locks.approve(handle(aw), approve, session(A));
    const hd = handle(write(B, [F]));
    const step = locks.approve(hd, approve, session(B));
    expect(step).toBeInstanceOf(Promise);
    expect(hd.holds).toEqual([{ reason: 'file-lock', until: '2026-10-31T00:05:00.000Z', lockPath: fk(F) }]);
    expect(lockOf(F)!.waiters).toEqual([expect.objectContaining({ sessionId: B, via: 'codex-approval', permissionRequestId: hd.request.id })]);
    locks.observe(fileItem(aw, 'failed'));
    locks.observe(turnEnd(A, T1));
    expect(await step).toBe('approved');
    expect(hd.answers).toEqual([approve]);
    expect(lockOf(F)).toMatchObject({ holderSessionId: B, writing: 1 });
  });

  // T028 r2 P2: a multi-file change whose second file is held.
  it('ends the writes it started before waiting, so a change of those files meanwhile is flagged', async () => {
    const { locks, files, escalations, lockOf } = setup();
    locks.observe(turnRun(A, T1));
    void locks.approve(handle(write(A, [F])), approve, session(A));
    const hd = handle(write(B, [G, F]));
    const step = locks.approve(hd, approve, session(B));
    expect(lockOf(G)).toMatchObject({ holderSessionId: B, writing: 0 });
    files.set(fk(G), h(8));
    locks.fileChanged(A, G);
    await flush();
    expect(escalations).toEqual([expect.objectContaining({ kind: 'unlocked-write', path: fk(G), holderSessionId: B })]);
    // The read check runs again once the request may go: B read G before it changed.
    locks.table.recordRead(B, fk(G), h(1));
    locks.stopped(A);
    expect(await step).toBe('refused');
    expect(hd.answers[0]!.reason).toContain('changed after this session last read it');
  });

  it('declines and escalates once the hold passes its limit', async () => {
    const { clock, locks, escalations } = setup({ holdMs: 1000 });
    void locks.approve(handle(write(A, [F])), approve, session(A));
    const hd = handle(write(B, [F]));
    const step = locks.approve(hd, approve, session(B));
    clock.advance(1000);
    expect(await step).toBe('refused');
    expect(hd.answers[0]).toMatchObject({ outcome: 'decline', decidedBy: 'policy' });
    await flush();
    expect(escalations).toEqual([expect.objectContaining({ kind: 'lock-timeout', sessionId: B, holderSessionId: A, path: fk(F), title: 'File lock wait timed out' })]);
  });

  it('refuses a wait that would deadlock, and escalates it', async () => {
    const { locks, escalations } = setup();
    void locks.approve(handle(write(A, [F])), approve, session(A));
    void locks.approve(handle(write(B, [G])), approve, session(B));
    const aWaits = handle(write(A, [G]));
    void locks.approve(aWaits, approve, session(A));
    const bWaits = handle(write(B, [F]));
    expect(await locks.approve(bWaits, approve, session(B))).toBe('refused');
    await flush();
    expect(escalations).toEqual([expect.objectContaining({ kind: 'lock-timeout', sessionId: B, title: 'File lock deadlock' })]);
    expect(aWaits.answers).toEqual([]);
  });

  it('cancels the wait of a request the runtime withdrew', async () => {
    const { locks, lockOf } = setup();
    void locks.approve(handle(write(A, [F])), approve, session(A));
    const hd = handle(write(B, [F]));
    const step = locks.approve(hd, approve, session(B));
    hd.open = false;
    locks.observe({ type: 'permission.updated', request: { ...hd.request, state: 'withdrawn' } });
    expect(await step).toBe('gone');
    expect(lockOf(F)!.waiters).toEqual([]);
  });

  it('lets the held write go when the holder’s runtime exits', async () => {
    const { locks, lockOf } = setup();
    void locks.approve(handle(write(A, [F])), approve, session(A));
    const hd = handle(write(B, [F]));
    const step = locks.approve(hd, approve, session(B));
    locks.observe({ type: 'runtime.exited', runtime: 'claude', sessionIds: [A], expected: false, code: 1, signal: null, at: AT });
    expect(await step).toBe('approved');
    expect(lockOf(F)!.holderSessionId).toBe(B);
  });

  it('declines a held write when the GUI begins closing', async () => {
    const { locks } = setup();
    void locks.approve(handle(write(A, [F])), approve, session(A));
    const hd = handle(write(B, [F]));
    const step = locks.approve(hd, approve, session(B));
    locks.beginClose();
    expect(await step).toBe('refused');
    expect(hd.answers[0]!.reason).toBe('the GUI is closing');
  });

  it('locks the files the item announced, not the grant root of the request', () => {
    const { locks, lockOf } = setup();
    const req = { ...write(B, [F]), paths: [F, ROOT] };
    locks.observe(fileItem(write(B, [F], { itemId: req.itemId! }), 'proposed'));
    void locks.approve(handle(req), approve, session(B));
    expect(locks.list().map((l) => l.path)).toEqual([fk(F)]);
    expect(lockOf(ROOT)).toBeUndefined();
  });

  it('refuses a change whose files are not known (fail closed)', () => {
    const { locks } = setup();
    const hd = handle({ ...write(B, []), paths: [] });
    expect(locks.approve(hd, approve, session(B))).toBe('refused');
  });

  it('ends a move as the old path deleted and the new one written', () => {
    const { locks, files, lockOf } = setup();
    const NEW = 'E:\\work\\moved.txt';
    const req = write(B, [F, NEW]);
    const changes = [{ path: F, change: 'update' as const, movePath: NEW }];
    locks.observe(fileItem(req, 'proposed', changes));
    void locks.approve(handle(req), approve, session(B));
    files.set(fk(F), 'missing');
    files.set(fk(NEW), h(4));
    locks.observe(fileItem(req, 'applied', changes));
    expect(lockOf(F)!.lastWrite).toEqual({ kind: 'deleted' });
    expect(lockOf(NEW)!.lastWrite).toEqual({ kind: 'written', hash: h(4) });
  });
});

describe('release', () => {
  it('keeps the lock through background commands after the turn, and ends unfinished writes as failed', () => {
    const { locks, lockOf } = setup();
    locks.observe(turnRun(A, T1));
    const req = write(A, [F], { claude: true });
    void locks.approve(handle(req), approve, session(A));
    locks.observe(bgCommand(A, 'bg-1', 'running'));
    locks.observe(turnEnd(A, T1));
    expect(lockOf(F)).toMatchObject({ writing: 0, waitingForBackground: true });
    // The item's late end after the turn: the write already ended.
    locks.observe(fileItem(req, 'applied'));
    expect(lockOf(F)!.writing).toBe(0);
    locks.observe(bgCommand(A, 'bg-1', 'completed'));
    expect(lockOf(F)).toBeUndefined();
  });

  it('drops a late running of a turn that ended', () => {
    const { locks, lockOf } = setup();
    locks.observe(turnEnd(A, T1));
    locks.observe(turnRun(A, T1));
    const req = write(A, [F], { claude: true, turnId: T1 });
    void locks.approve(handle(req), approve, session(A));
    locks.observe(fileItem(req, 'applied'));
    expect(lockOf(F)).toBeUndefined();
  });

  it('releases on stop and on close', () => {
    const { locks } = setup();
    void locks.approve(handle(write(A, [F])), approve, session(A));
    void locks.approve(handle(write(B, [G])), approve, session(B));
    locks.stopped(A);
    locks.closed(B);
    expect(locks.list()).toEqual([]);
  });

  it('never locks in worktree mode', () => {
    const { locks } = setup();
    const wt = session(A, { source: 'task-worktree' });
    expect(locks.approve(handle(write(A, [F])), approve, wt)).toBe('approved');
    expect(locks.list()).toEqual([]);
  });
});

describe('wait_for_file', () => {
  it('returns free once the holder is done, not-locked when nothing holds it', async () => {
    const { locks } = setup();
    expect(await locks.waitForFile({ path: F }, B)).toEqual({ status: 'not-locked' });
    void locks.approve(handle(write(A, [F])), approve, session(A));
    const waiting = locks.waitForFile({ path: 'shared.txt' }, B);
    locks.stopped(A);
    expect(await waiting).toEqual({ status: 'free' });
  });

  it('times out and escalates to root', async () => {
    const { clock, locks, escalations } = setup();
    void locks.approve(handle(write(A, [F])), approve, session(A));
    const waiting = locks.waitForFile({ path: F, timeoutMs: 500 }, B);
    clock.advance(500);
    expect(await waiting).toEqual({ status: 'timeout', escalationId: 'esc-1' });
    expect(escalations[0]).toMatchObject({ kind: 'lock-timeout', sessionId: B, holderSessionId: A });
  });

  it('ends its wait when the call is aborted', async () => {
    const { locks, lockOf } = setup();
    void locks.approve(handle(write(A, [F])), approve, session(A));
    // Core has no DOM types: the part of an AbortSignal the coordinator uses.
    const listeners: (() => void)[] = [];
    const signal = {
      aborted: false,
      addEventListener: (_: 'abort', l: () => void) => listeners.push(l),
      removeEventListener: () => undefined,
    };
    const waiting = locks.waitForFile({ path: F }, B, signal);
    signal.aborted = true;
    for (const l of listeners) l();
    expect(await waiting).toEqual({ status: 'timeout' });
    expect(lockOf(F)!.waiters).toEqual([]);
  });

  it('is never locked in worktree mode', async () => {
    const { locks } = setup();
    void locks.approve(handle(write(A, [F])), approve, session(A));
    locks.track(session(B, { source: 'task-worktree' }));
    expect(await locks.waitForFile({ path: F }, B)).toEqual({ status: 'not-locked' });
  });
});

describe('unlocked writes (R-07, SP-06 W5/W6)', () => {
  it('flags a change of a locked file while its holder writes nothing, once per open escalation', async () => {
    const { locks, files, escalations } = setup();
    const req = write(A, [F], { claude: true });
    void locks.approve(handle(req), approve, session(A));
    files.set(fk(F), h(2));
    // The holder's own write, seen by the watcher while in progress and again after: expected.
    locks.fileChanged(A, F);
    locks.observe(fileItem(req, 'applied'));
    locks.fileChanged(B, F);
    expect(escalations).toEqual([]);
    // A shell write by B.
    files.set(fk(F), h(6));
    locks.fileChanged(A, F);
    locks.fileChanged(B, F);
    files.set(fk(F), h(7));
    locks.fileChanged(A, F);
    await flush();
    expect(escalations).toEqual([expect.objectContaining({ kind: 'unlocked-write', path: fk(F), sessionId: A, holderSessionId: A })]);
    locks.escalationClosed('esc-1' as never);
    files.set(fk(F), h(8));
    locks.fileChanged(A, F);
    await flush();
    expect(escalations).toHaveLength(2);
  });

  it('flags an unlocked file only while a same-folder session works in its folder; never .git or Claude temp files', async () => {
    const { locks, files, escalations } = setup();
    files.set(fk(G), h(2));
    locks.fileChanged(A, G);
    expect(escalations).toEqual([]);
    locks.observe(turnRun(B, TB));
    files.set(fk(G), h(3));
    locks.fileChanged(A, G);
    locks.fileChanged(A, 'E:\\work\\.git\\index');
    locks.fileChanged(A, 'E:\\work\\shared.txt.tmp.1234.abcd12');
    files.set('e:\\elsewhere\\x.txt', h(1));
    locks.fileChanged(A, 'E:\\elsewhere\\x.txt');
    await flush();
    expect(escalations).toEqual([expect.objectContaining({ kind: 'unlocked-write', path: fk(G), sessionId: B })]);
    expect(escalations[0]!.holderSessionId).toBeUndefined();
  });
});

describe('unlocked writes: what git ignores, and the at-work scope', () => {
  const ignoredSetup = () => {
    const clock = new ManualClock(AT);
    const files = new Map<string, FileState>();
    const escalations: LockEscalation[] = [];
    const locks = new LockCoordinator({
      now: clock.now,
      setTimer: clock.setTimer,
      hashFile: (path) => files.get(fk(path)) ?? 'missing',
      resolveRealPath: (p) => p,
      escalate: (e) => {
        escalations.push(e);
        return Promise.resolve(`esc-${String(escalations.length)}` as never);
      },
      publish: () => undefined,
      isIgnored: (path) => path.includes('\\node_modules\\') || path.includes('\\out\\'),
    });
    locks.track(session(A));
    return { files, escalations, locks };
  };

  it('skips an ignored path that no lock covers, but still checks a locked one', async () => {
    const { files, escalations, locks } = ignoredSetup();
    locks.observe(turnRun(A, T1));
    files.set(fk('E:\\work\\node_modules\\x.js'), h(1));
    locks.fileChanged(A, 'E:\\work\\node_modules\\x.js');
    await flush();
    expect(escalations).toEqual([]);
    const OUT = 'E:\\work\\out\\main.js';
    files.set(fk(OUT), h(1));
    void locks.approve(handle(write(A, [OUT])), approve, session(A));
    locks.observe(fileItem(write(A, [OUT], { itemId: 'none' }), 'failed'));
    // A's write never reported its end; it ends with the turn, then background work keeps the lock.
    locks.observe(bgCommand(A, 'bg-9', 'running'));
    locks.observe(turnEnd(A, T1));
    files.set(fk(OUT), h(2));
    locks.fileChanged(A, OUT);
    await flush();
    expect(escalations).toEqual([expect.objectContaining({ kind: 'unlocked-write', path: fk(OUT), holderSessionId: A })]);
  });

  it('counts a session whose only work left is a background command as at work', async () => {
    const { files, escalations, locks } = ignoredSetup();
    locks.observe(bgCommand(A, 'bg-1', 'running'));
    files.set(fk(G), h(4));
    locks.fileChanged(A, G);
    locks.observe(bgCommand(A, 'bg-1', 'completed'));
    files.set(fk(F), h(4));
    locks.fileChanged(A, F);
    await flush();
    expect(escalations.map((e) => e.path)).toEqual([fk(G)]);
  });
});
