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

const setup = (o: { holdMs?: number; announce?: boolean } = {}) => {
  // Links: a path resolves through this map (prefix → real prefix), changeable while a write waits.
  const links = new Map<string, string>();
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
    resolveRealPath: (p) => {
      for (const [from, to] of links) if (p.toLowerCase().startsWith(from.toLowerCase())) return to + p.slice(from.length);
      return p;
    },
    escalate: (e) => {
      escalations.push(e);
      return Promise.resolve(`esc-${String(escalations.length)}` as never);
    },
    publish: (l) => published.push(l),
    ...(o.holdMs !== undefined && { holdMs: o.holdMs }),
  });
  // Codex announces a change's files with item/started before it asks (SP-06 W2): the tests ask the same way.
  const approveAsCodex = locks.approve.bind(locks);
  locks.approve = (hd, decision, s, decidedFor) => {
    const r = hd.request;
    if (o.announce !== false && r.kind === 'fileChange' && r.tool === undefined && r.paths.length > 0) locks.observe(fileItem(r, 'proposed'));
    return approveAsCodex(hd, decision, s, decidedFor);
  };
  locks.track(session(A));
  locks.track(session(B));
  const lockOf = (path: string) => locks.list().find((l) => l.path === fk(path));
  return { clock, files, escalations, published, locks, lockOf, links };
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

  // V-24 run 1: Codex's second patch after Claude's change was refused as "changed since read".
  it('never refuses a Codex patch for a read check: the GUI does not see its reads', () => {
    const { locks, files } = setup();
    const first = write(B, [F]);
    void locks.approve(handle(first), approve, session(B));
    files.set(fk(F), h(2));
    locks.observe(fileItem(first, 'applied'));
    locks.observe(turnEnd(B, TB));
    const claude = write(A, [F], { claude: true });
    void locks.approve(handle(claude), approve, session(A));
    files.set(fk(F), h(3));
    locks.observe(fileItem(claude, 'applied'));
    locks.observe(turnEnd(A, T1));
    const second = handle(write(B, [F]));
    expect(locks.approve(second, approve, session(B))).toBe('approved');
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
    const { locks, lockOf } = setup({ announce: false });
    const req = { ...write(B, [F]), paths: [F, ROOT] };
    locks.observe(fileItem(write(B, [F], { itemId: req.itemId! }), 'proposed'));
    void locks.approve(handle(req), approve, session(B));
    expect(locks.list().map((l) => l.path)).toEqual([fk(F)]);
    expect(lockOf(ROOT)).toBeUndefined();
  });

  it('refuses a change whose files are not known (fail closed)', () => {
    const { locks } = setup({ announce: false });
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
    const outWrite = write(A, [OUT]);
    locks.observe(fileItem(outWrite, 'proposed'));
    void locks.approve(handle(outWrite), approve, session(A));
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

// Review r1 (Astra): one regression test per finding, built from the reviewer's repro.
describe('review r1', () => {
  it('P1-1 a Codex request with only its grant root and no item is refused, and no folder is locked', () => {
    const { locks, lockOf } = setup({ announce: false });
    void locks.approve(handle(write(A, ['E:\\work\\a.txt'], { claude: true })), approve, session(A));
    const hd = handle({ ...write(B, []), paths: [ROOT] });
    expect(locks.approve(hd, approve, session(B))).toBe('refused');
    expect(hd.answers[0]!.reason).toContain('files of this change are not known');
    expect(lockOf(ROOT)).toBeUndefined();
    expect(locks.list().map((l) => l.path)).toEqual(['e:\\work\\a.txt']);
  });

  it('P1-2 a held write whose link changed while it waited is decided again, not let through on the old file', async () => {
    const { locks, links, lockOf } = setup();
    links.set('E:\\work\\link', 'E:\\work\\old');
    void locks.approve(handle(write(A, ['E:\\work\\old\\a.txt'], { claude: true })), approve, session(A));
    const req = write(B, ['E:\\work\\link\\a.txt']);
    locks.observe(fileItem(req, 'proposed'));
    const decidedFor = locks.pathsOf(req, session(B));
    expect(decidedFor).toEqual(['e:\\work\\old\\a.txt']);
    const hd = handle(req);
    const step = locks.approve(hd, approve, session(B), decidedFor);
    expect(hd.holds).toHaveLength(1);
    links.set('E:\\work\\link', 'E:\\work\\new');
    locks.stopped(A);
    expect(await step).toBe('recheck');
    expect(hd.answers).toEqual([]);
    expect(lockOf('E:\\work\\old\\a.txt')).toBeUndefined();
    expect(lockOf('E:\\work\\new\\a.txt')).toBeUndefined();
    // The same before any wait: a decision made for other files is not used.
    expect(locks.approve(handle(req), approve, session(B), decidedFor)).toBe('recheck');
  });

  it('P1-3 a second approval of an answered request neither replaces nor removes its write', () => {
    const { locks, lockOf } = setup();
    const req = write(B, [F]);
    const first = handle(req);
    expect(locks.approve(first, approve, session(B))).toBe('approved');
    // The same request again (e.g. a second escalation.respond) with a handle that can no longer answer.
    const again = handle(req);
    again.open = false;
    expect(locks.approve(again, approve, session(B))).toBe('gone');
    expect(lockOf(F)!.writing).toBe(1);
    locks.observe(fileItem(req, 'applied'));
    locks.observe(turnEnd(B, TB));
    expect(lockOf(F)).toBeUndefined();
  });

  it('P1-4 a git-ignore check that throws never escapes the watcher path', () => {
    const clock = new ManualClock(AT);
    const locks = new LockCoordinator({
      now: clock.now,
      setTimer: clock.setTimer,
      hashFile: () => h(1),
      resolveRealPath: (p) => p,
      escalate: () => Promise.resolve(undefined),
      publish: () => undefined,
      isIgnored: () => {
        throw new SyntaxError('Range out of order in character class');
      },
    });
    locks.track(session(A));
    locks.observe(turnRun(A, T1));
    expect(() => locks.fileChanged(A, F)).not.toThrow();
  });

  it('P1-5 a Codex hold ends at its own limit even when the session already waits longer for the file', async () => {
    const { clock, locks, escalations } = setup({ holdMs: 1000 });
    void locks.approve(handle(write(A, [F])), approve, session(A));
    const longWait = locks.waitForFile({ path: F, timeoutMs: 600_000 }, B);
    const hd = handle(write(B, [F]));
    const step = locks.approve(hd, approve, session(B));
    clock.advance(1001);
    expect(await step).toBe('refused');
    await flush();
    expect(escalations).toEqual([expect.objectContaining({ kind: 'lock-timeout', sessionId: B })]);
    let settled = false;
    void longWait.then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);
  });

  it('P1-6 a failed tool that changed one of its files ends that file as written, the other as not', async () => {
    const { locks, files, lockOf, escalations } = setup();
    locks.observe(turnRun(B, TB));
    const req = write(B, [F, G]);
    void locks.approve(handle(req), approve, session(B));
    files.set(fk(F), h(5));
    locks.observe(fileItem(req, 'failed'));
    expect(lockOf(F)!.lastWrite).toEqual({ kind: 'written', hash: h(5) });
    expect(lockOf(G)!.lastWrite).toBeUndefined();
    // Its own change, seen by the watcher: not an unlocked write.
    locks.fileChanged(B, F);
    await flush();
    expect(escalations).toEqual([]);
  });

  it('P1-7 a watcher event through an alias is the locked file itself', async () => {
    const { locks, files, links, lockOf, escalations } = setup();
    links.set('E:\\work\\alias', 'E:\\work\\real');
    const REAL = 'E:\\work\\real\\a.txt';
    files.set(fk(REAL), h(1));
    locks.observe(turnRun(A, T1));
    void locks.approve(handle(write(A, ['E:\\work\\alias\\a.txt'], { claude: true })), approve, session(A));
    expect(lockOf(REAL)).toMatchObject({ writing: 1 });
    files.set(fk(REAL), h(2));
    locks.fileChanged(A, 'E:\\work\\alias\\a.txt');
    locks.fileChanged(A, REAL);
    await flush();
    expect(escalations).toEqual([]);
  });

  it('P1-8 a file read small and grown past the hash limit still locks, without a read check', () => {
    const { locks, files, lockOf } = setup();
    void locks.approve(handle(read(A, F, 'read-big')), approve, session(A));
    locks.observe({ type: 'item.updated', item: { id: 'read-big', sessionId: A, turnId: T1, kind: 'toolCall', tool: 'Read', summary: 'Read', state: 'completed', startedAt: AT, endedAt: AT } as SessionItem });
    files.set(fk(F), 'unreadable');
    const hd = handle(write(A, [F], { claude: true }));
    expect(locks.approve(hd, approve, session(A))).toBe('approved');
    expect(lockOf(F)).toMatchObject({ holderSessionId: A, writing: 1 });
  });

  it('P1-10 a deleted folder is no unlocked write; a deleted file seen as a file is', async () => {
    const { locks, files, escalations } = setup();
    locks.observe(turnRun(A, T1));
    const DIR = 'E:\\work\\newdir';
    files.set(fk(DIR), 'directory');
    locks.fileChanged(A, DIR);
    files.delete(fk(DIR));
    locks.fileChanged(A, DIR);
    // Never seen: what was there is unknown, so it is not escalated.
    locks.fileChanged(A, 'E:\\work\\unknown.txt');
    // A folder known as the parent of a changed path, deleted with its file.
    files.set(fk('E:\\work\\d2\\x.txt'), h(1));
    locks.fileChanged(A, 'E:\\work\\d2\\x.txt');
    await flush();
    const before = escalations.length;
    files.delete(fk('E:\\work\\d2\\x.txt'));
    locks.fileChanged(A, 'E:\\work\\d2');
    await flush();
    expect(escalations.length).toBe(before);
    expect(escalations.map((e) => e.path)).not.toContain(fk(DIR));
    expect(escalations.map((e) => e.path)).not.toContain(fk('E:\\work\\unknown.txt'));
    // A file seen before, then deleted by a shell: escalated.
    const SEEN = 'E:\\work\\seen.txt';
    files.set(fk(SEEN), h(3));
    locks.fileChanged(A, SEEN);
    await flush();
    const n = escalations.filter((e) => e.path === fk(SEEN)).length;
    locks.escalationClosed(`esc-${String(escalations.length)}` as never);
    files.delete(fk(SEEN));
    locks.fileChanged(A, SEEN);
    await flush();
    expect(escalations.filter((e) => e.path === fk(SEEN)).length).toBe(n + 1);
  });
});

// Review r2 (Astra): regression tests from the reviewer's repros.
describe('review r2', () => {
  const C = 'sess-c' as SessionId;

  it('P1 a recheck keeps the hold limit of the request: refused and escalated at 1000 ms, not later', async () => {
    const { clock, locks, links, escalations } = setup({ holdMs: 1000 });
    locks.track(session(C));
    links.set('E:\\work\\link', 'E:\\work\\old');
    void locks.approve(handle(write(A, ['E:\\work\\old\\a.txt'], { claude: true })), approve, session(A));
    void locks.approve(handle(write(C, ['E:\\work\\new\\a.txt'], { claude: true })), approve, session(C));
    const req = write(B, ['E:\\work\\link\\a.txt']);
    locks.observe(fileItem(req, 'proposed'));
    const hd = handle(req);
    let step = locks.approve(hd, approve, session(B), locks.pathsOf(req, session(B)));
    clock.advance(900);
    links.set('E:\\work\\link', 'E:\\work\\new');
    locks.stopped(A);
    expect(await step).toBe('recheck');
    // The gate decides again, for the file the link names now (C holds it).
    step = locks.approve(hd, approve, session(B), locks.pathsOf(req, session(B)));
    expect(step).toBeInstanceOf(Promise);
    expect(hd.holds.at(-1)).toMatchObject({ until: '2026-10-31T00:00:01.000Z' });
    clock.advance(100);
    expect(await step).toBe('refused');
    await flush();
    expect(escalations).toEqual([expect.objectContaining({ kind: 'lock-timeout', sessionId: B, holderSessionId: C })]);
  });

  it('P1 changing the link again and again never extends the hold', async () => {
    const { clock, locks, links } = setup({ holdMs: 1000 });
    locks.track(session(C));
    links.set('E:\\work\\link', 'E:\\work\\old');
    const req = write(B, ['E:\\work\\link\\a.txt']);
    locks.observe(fileItem(req, 'proposed'));
    const hd = handle(req);
    let holder = A;
    void locks.approve(handle(write(A, ['E:\\work\\old\\a.txt'], { claude: true })), approve, session(A));
    let step = locks.approve(hd, approve, session(B), locks.pathsOf(req, session(B)));
    for (const [target, next] of [
      ['new', C],
      ['old', A],
    ] as const) {
      clock.advance(400);
      void locks.approve(handle(write(next, [`E:\\work\\${target}\\a.txt`], { claude: true })), approve, session(next));
      links.set('E:\\work\\link', `E:\\work\\${target}`);
      locks.stopped(holder);
      holder = next;
      expect(await step).toBe('recheck');
      step = locks.approve(hd, approve, session(B), locks.pathsOf(req, session(B)));
    }
    clock.advance(200);
    expect(await step).toBe('refused');
  });

  it('P2 a file only read (no watcher event before) and then deleted is escalated', async () => {
    const { locks, files, escalations } = setup();
    locks.observe(turnRun(A, T1));
    void locks.approve(handle(read(A, F, 'read-r2')), approve, session(A));
    locks.observe({ type: 'item.updated', item: { id: 'read-r2', sessionId: A, turnId: T1, kind: 'toolCall', tool: 'Read', summary: 'Read', state: 'completed', startedAt: AT, endedAt: AT } as SessionItem });
    files.delete(fk(F));
    locks.fileChanged(A, F);
    await flush();
    expect(escalations).toEqual([expect.objectContaining({ kind: 'unlocked-write', path: fk(F) })]);
  });

  it('P2 a path that was a folder and is now a file is a file when it is deleted', async () => {
    const { locks, files, escalations } = setup();
    locks.observe(turnRun(A, T1));
    const P = 'E:\\work\\thing';
    files.set(fk(P), 'directory');
    locks.fileChanged(A, P);
    files.set(fk(P), h(4));
    locks.fileChanged(A, P);
    await flush();
    const before = escalations.length;
    locks.escalationClosed(`esc-${String(escalations.length)}` as never);
    files.delete(fk(P));
    locks.fileChanged(A, P);
    await flush();
    expect(escalations.length).toBe(before + 1);
    expect(escalations.at(-1)).toMatchObject({ path: fk(P) });
  });
});
