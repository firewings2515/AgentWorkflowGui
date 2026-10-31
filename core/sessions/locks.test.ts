// T033 (R-07): the session service with same-folder locks. The policy (or the user) decides first and the
// lock only makes an approval wait or turns it into a refusal; a held write shows `waiting-lock`; lock
// escalations reach root and are closed by the user; a restart starts with no locks.
import { describe, expect, it } from 'vitest';
import { type AppEvent, type ItemId, RequestId, type SessionId, type SessionItem } from '../../contracts';
import { type FakeHandle, permissionRequest } from './testing/fake-adapter';
import { created, session, settle, world, type World } from './testing/harness';

const FILE = 'E:\\work\\project\\shared.txt';
const KEY = 'e:\\real\\project\\shared.txt';
const AT = '2026-10-29T01:00:00.000Z';
let n = 0;
const rid = () => RequestId.parse(`lock-r-${++n}`);
const hash = (c: string) => `sha256:${c.repeat(64)}`;

const codexWrite = (w: World, sessionId: SessionId, path = FILE): FakeHandle => {
  const id = `perm-${++n}`;
  const itemId = `patch-${n}` as ItemId;
  const adapter = w.codex.get(sessionId)!;
  adapter.emit({
    type: 'item.updated',
    item: { id: itemId, sessionId, turnId: `turn-${sessionId}`, kind: 'fileChange', changes: [{ path, change: 'update' }], state: 'proposed', startedAt: AT } as SessionItem,
  } as AppEvent as never);
  return adapter.ask(permissionRequest(sessionId, { id: id as never, kind: 'fileChange', itemId, turnId: `turn-${sessionId}` as never, summary: 'patch', paths: [path] }));
};
const claudeWrite = (w: World, sessionId: SessionId, path = FILE): FakeHandle =>
  w.claude.ask(permissionRequest(sessionId, { id: `perm-${++n}` as never, kind: 'fileChange', tool: 'Edit', itemId: `tool-${n}` as ItemId, turnId: `turn-${sessionId}` as never, summary: 'Edit', paths: [path] }));
const turnEnd = (w: World, sessionId: SessionId, runtime: 'codex' | 'claude' = 'codex') =>
  (runtime === 'codex' ? w.codex.get(sessionId)! : w.claude).emit({
    type: 'turn.updated',
    turn: { id: `turn-${sessionId}`, sessionId, state: 'completed', startedAt: AT, endedAt: AT } as never,
  } as never);
const locksOf = (w: World) => w.service.locks!.list();
const lockEvents = (w: World) => w.events.filter((e) => e.type === 'locks.updated');

const two = async () => {
  const w = await world({ locks: true });
  w.files.set(KEY, hash('1'));
  const { sessionId: a } = await created(w, 'codex', 'session-a');
  const { sessionId: b } = await created(w, 'codex', 'session-b');
  return { w, a, b };
};

describe('same-folder locks in the session service (R-07)', () => {
  it('holds a Codex write behind another session’s lock, shows waiting-lock, and applies it once the lock frees', async () => {
    const { w, a, b } = await two();
    const first = codexWrite(w, a);
    await settle();
    expect(first.decision).toMatchObject({ outcome: 'approve', decidedBy: 'policy' });
    expect(locksOf(w)).toEqual([expect.objectContaining({ path: KEY, holderSessionId: a, writing: 1 })]);
    expect(lockEvents(w).at(-1)).toMatchObject({ locks: [{ path: KEY, holderSessionId: a }] });

    const second = codexWrite(w, b);
    await settle();
    expect(second.decision).toBeUndefined();
    expect(second.holdState).toMatchObject({ reason: 'file-lock', lockPath: KEY });
    // The adapter would report the hold; the service shows the session waiting for the lock.
    w.codex.get(b)!.emit({ type: 'permission.updated', request: second.request } as never);
    await settle();
    expect((await session(w, b)).activity).toBe('waiting-lock');

    turnEnd(w, a);
    await settle();
    expect(second.decision).toMatchObject({ outcome: 'approve', decidedBy: 'policy' });
    expect(locksOf(w)).toEqual([expect.objectContaining({ holderSessionId: b })]);
  });

  it('refuses a Claude write to a locked file before the policy is asked', async () => {
    const w = await world({ locks: true });
    w.files.set(KEY, hash('1'));
    const { sessionId: a } = await created(w, 'codex', 'session-a');
    const { sessionId: c } = await created(w, 'claude', 'session-c');
    codexWrite(w, a);
    await settle();
    const asked = w.contexts.length;
    const refused = claudeWrite(w, c);
    await settle();
    expect(w.contexts).toHaveLength(asked);
    expect(refused.decision).toMatchObject({ outcome: 'decline', decidedBy: 'policy', reason: expect.stringContaining('mcp__gui__wait_for_file') as unknown });
  });

  it('takes no lock while the user decides, and locks only on the user’s approval (no bypass of R-05 / R-08)', async () => {
    const { w, a, b } = await two();
    w.decide = () => ({ action: 'escalate', rule: 'write-outside-scope', reason: 'fixed' });
    const escalated = codexWrite(w, b);
    await settle();
    expect(escalated.holdState).toMatchObject({ reason: 'awaiting-user' });
    expect(locksOf(w)).toEqual([]);
    // Meanwhile another session takes the file.
    w.decide = () => ({ action: 'approve' });
    codexWrite(w, a);
    await settle();
    const escalation = [...w.repositories.escalationRecords.values()].find((e) => e.kind === 'permission')!;
    expect((await w.run({ type: 'escalation.respond', requestId: rid(), escalationId: escalation.id, decision: 'approve' })).ok).toBe(true);
    await settle();
    // Approved by the user, held for the lock: answered with the user's decision once it frees.
    expect(escalated.decision).toBeUndefined();
    expect(escalated.holdState).toMatchObject({ reason: 'file-lock' });
    turnEnd(w, a);
    await settle();
    expect(escalated.decision).toMatchObject({ outcome: 'approve', decidedBy: 'user', escalationId: escalation.id });
  });

  it('a user decline takes no lock', async () => {
    const { w, b } = await two();
    w.decide = () => ({ action: 'escalate', rule: 'write-outside-scope', reason: 'fixed' });
    const escalated = codexWrite(w, b);
    await settle();
    const escalation = [...w.repositories.escalationRecords.values()][0]!;
    await w.run({ type: 'escalation.respond', requestId: rid(), escalationId: escalation.id, decision: 'decline' });
    expect(escalated.decision).toMatchObject({ outcome: 'decline', decidedBy: 'user' });
    expect(locksOf(w)).toEqual([]);
  });

  it('escalates a hold past its limit to root, and the user closes that escalation', async () => {
    const { w, a, b } = await two();
    codexWrite(w, a);
    await settle();
    const held = codexWrite(w, b);
    await settle();
    w.clock.advance(5 * 60_000);
    await settle();
    expect(held.decision).toMatchObject({ outcome: 'decline' });
    const escalation = [...w.repositories.escalationRecords.values()].find((e) => e.kind === 'lock-timeout')!;
    expect(escalation).toMatchObject({ rootSessionId: b, fromSessionId: b, state: 'open', ref: { kind: 'lock', path: KEY, sessionId: b, holderSessionId: a } });
    expect((await w.run({ type: 'escalation.respond', requestId: rid(), escalationId: escalation.id, decision: 'approve' })).ok).toBe(true);
    expect(w.repositories.escalationRecords.get(escalation.id)).toMatchObject({ state: 'resolved', resolvedBy: 'user' });
  });

  it('flags a shell write to a locked file and escalates it once', async () => {
    const { w, a, b } = await two();
    const first = codexWrite(w, a);
    await settle();
    // A's patch is applied: the file is what A left.
    w.files.set(KEY, hash('2'));
    w.codex.get(a)!.emit({
      type: 'item.updated',
      item: { id: first.request.itemId!, sessionId: a, turnId: first.request.turnId!, kind: 'fileChange', changes: [{ path: FILE, change: 'update' }], state: 'applied', startedAt: AT, endedAt: AT } as SessionItem,
    } as never);
    w.files.set(KEY, hash('3'));
    w.service.workspaceChanged(b, 'E:\\real\\project', 'E:\\real\\project\\shared.txt');
    w.service.workspaceChanged(a, 'E:\\real\\project', 'E:\\real\\project\\shared.txt');
    await settle();
    const flagged = [...w.repositories.escalationRecords.values()].filter((e) => e.kind === 'unlocked-write');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ ref: { kind: 'lock', path: KEY, holderSessionId: a } });
  });

  it('releases on interrupt, and a restart starts with no locks', async () => {
    const { w, a } = await two();
    codexWrite(w, a);
    await settle();
    expect(locksOf(w)).toHaveLength(1);
    const again = w.restart();
    expect(again.service.locks!.list()).toEqual([]);
    expect((await w.run({ type: 'session.interrupt', requestId: rid(), sessionId: a })).ok).toBe(true);
    expect(locksOf(w)).toEqual([]);
  });

  it('wait_for_file of an ordinary session returns free once the holder is done', async () => {
    const { w, a, b } = await two();
    codexWrite(w, a);
    await settle();
    const waiting = w.service.waitForFile({ path: 'shared.txt' }, { caller: b });
    await settle();
    expect(locksOf(w)[0]!.waiters).toEqual([expect.objectContaining({ sessionId: b, via: 'wait_for_file' })]);
    turnEnd(w, a);
    expect(await waiting).toEqual({ status: 'free' });
  });
});

describe('review r1 (session service)', () => {
  it('P1-3 two concurrent approvals of one escalation: one answers, the other is refused, and the lock is released after the write', async () => {
    const { w, b } = await two();
    w.decide = () => ({ action: 'escalate', rule: 'write-outside-scope', reason: 'fixed' });
    const held = codexWrite(w, b);
    await settle();
    const escalation = [...w.repositories.escalationRecords.values()].find((e) => e.kind === 'permission')!;
    const [one, other] = await Promise.all([
      w.run({ type: 'escalation.respond', requestId: rid(), escalationId: escalation.id, decision: 'approve' }),
      w.run({ type: 'escalation.respond', requestId: rid(), escalationId: escalation.id, decision: 'approve' }),
    ]);
    expect([one.ok, other.ok].sort()).toEqual([false, true]);
    expect(held.decision).toMatchObject({ outcome: 'approve', decidedBy: 'user' });
    expect(locksOf(w)).toEqual([expect.objectContaining({ holderSessionId: b, writing: 1 })]);
    w.codex.get(b)!.emit({
      type: 'item.updated',
      item: { id: held.request.itemId!, sessionId: b, turnId: held.request.turnId!, kind: 'fileChange', changes: [{ path: FILE, change: 'update' }], state: 'applied', startedAt: AT, endedAt: AT } as SessionItem,
    } as never);
    turnEnd(w, b);
    await settle();
    expect(locksOf(w)).toEqual([]);
  });

  it('P1-2 a write held while its link changed is decided by the policy again, for the file it now names', async () => {
    const { w, a, b } = await two();
    // E:\work\project\link points at E:\real\project\old, later at E:\real\project\new.
    let target = 'old';
    w.realPath = (p) => {
      const linked = p.replace(/^E:\\work\\project\\link/i, `E:\\real\\project\\${target}`);
      return linked.startsWith('E:\\work') ? linked.replace('E:\\work', 'E:\\real') : linked.startsWith('E:\\real') ? linked : null;
    };
    codexWrite(w, a, 'E:\\work\\project\\old\\a.txt');
    await settle();
    const asked = w.contexts.length;
    const held = codexWrite(w, b, 'E:\\work\\project\\link\\a.txt');
    await settle();
    expect(held.holdState).toMatchObject({ reason: 'file-lock', lockPath: 'e:\\real\\project\\old\\a.txt' });
    target = 'new';
    turnEnd(w, a);
    await settle();
    // Decided again: the policy was asked a second time, and the lock is on the file the link names now.
    expect(w.contexts.length).toBe(asked + 2);
    expect(held.decision).toMatchObject({ outcome: 'approve', decidedBy: 'policy' });
    expect(locksOf(w)).toEqual([expect.objectContaining({ path: 'e:\\real\\project\\new\\a.txt', holderSessionId: b })]);
  });
});
