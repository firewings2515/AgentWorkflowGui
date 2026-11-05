// T060 (U4): the archive's pure parts — what is archived, what archiving would be refused for, the words for each reason.
import { describe, expect, it } from 'vitest';
import { CommandRefusal } from '../../../../contracts';
import type { LogicalSession, Snapshot } from '../../../../contracts';
import { fixtureSnapshot } from '../../../../contracts/fixtures/snapshot';
import { commandFeedback, REFUSAL_TEXT, refusalText } from '../command-feedback';
import { ARCHIVED_CLOSED, archiveBlock, archivedIndex, archivedTargetIn, archiveTargetOf, readArchivedOpen, targetArchived, targetRevision, topsOf } from './archive';
import { canMove, moveTargets } from './move-targets';

const at = '2026-11-05T10:00:00.000Z';
const byId = (id: string) => fixtureSnapshot.sessions.find(session => session.id === id)!;
const handoff = byId('s-handoff-codex');
/** A quiet top-level ordinary session (idle, no turn, no escalation, no transfer). */
const quiet = (id: string, patch: Partial<LogicalSession> = {}) => {
  const session = { ...handoff, id, title: id, activity: 'idle', ...patch } as LogicalSession;
  if (!('parentId' in patch)) delete (session as { parentId?: string }).parentId;
  return session;
};
const ended = { ...fixtureSnapshot.instances.find(item => item.id === 'inst-docs')!, state: 'completed' as const, endedAt: at };
const quietNodes = fixtureSnapshot.sessions.filter(session => session.kind === 'workflow' && session.workflow.instanceId === 'inst-docs').map(session => ({ ...session, activity: 'idle' as const }));
/** The fixture with two quiet trees (a top, a child, a grandchild; another top), the docs run ended and quiet. */
function data(patch: (snapshot: Snapshot) => Partial<Snapshot> = () => ({})): Snapshot {
  const base: Snapshot = {
    ...fixtureSnapshot,
    sessions: [...fixtureSnapshot.sessions.filter(session => !quietNodes.some(node => node.id === session.id)), ...quietNodes,
      quiet('s-a'), quiet('s-a1', { parentId: 's-a' as never }), quiet('s-a11', { parentId: 's-a1' as never }), quiet('s-b')],
    instances: fixtureSnapshot.instances.map(item => item.id === 'inst-docs' ? ended : item),
    turns: fixtureSnapshot.turns.filter(turn => !quietNodes.some(node => node.id === turn.sessionId)),
  };
  return { ...base, ...patch(base) };
}
const archive = (snapshot: Snapshot, id: string): Snapshot => ({ ...snapshot, sessions: snapshot.sessions.map(session => session.id === id ? { ...session, archivedAt: at } as LogicalSession : session) });
const archiveRun = (snapshot: Snapshot, id: string): Snapshot => ({ ...snapshot, instances: snapshot.instances.map(item => item.id === id ? { ...item, archivedAt: at } : item) });

describe('topsOf / archivedIndex', () => {
  it('walks up ordinary parents once; a missing or workflow parent ends the chain; a cycle stops', () => {
    const cycle = [quiet('c1', { parentId: 'c2' as never }), quiet('c2', { parentId: 'c1' as never })];
    const tops = topsOf([...data().sessions, quiet('orphan', { parentId: 'gone' as never }), ...cycle]);
    expect(tops.get('s-a11')?.id).toBe('s-a');
    expect(tops.get('s-research')?.id).toBe('s-plan-notes');
    expect(tops.get('orphan')?.id).toBe('orphan');
    expect(['c1', 'c2']).toContain(tops.get('c1')?.id);
    expect(tops.has('s-wf-root')).toBe(false);
  });

  it('nothing archived: empty sets, no parent chain walked', () => {
    const index = archivedIndex(data());
    expect([index.roots.size, index.sessions.size, index.runs.size, index.runSessions.size, index.tops.size]).toEqual([0, 0, 0, 0, 0]);
  });

  it('a top with archivedAt archives its whole tree; a child never counts by its own field; a run archives its nodes', () => {
    let snapshot = archiveRun(archive(data(), 's-a'), 'inst-docs');
    snapshot = archive(snapshot, 's-research'); // a stray mark on a child: only the top's counts (T059 §4)
    const index = archivedIndex(snapshot);
    expect([...index.roots]).toEqual(['s-a']);
    expect([...index.sessions].sort()).toEqual(['s-a', 's-a1', 's-a11']);
    expect([...index.runs]).toEqual(['inst-docs']);
    expect([...index.runSessions].sort()).toEqual(['s-docs-lead', 's-docs-rev-claude', 's-docs-rev-codex']);
    expect(archivedTargetIn(index, byId('s-docs-lead'))).toEqual({ kind: 'run', id: 'inst-docs' });
    expect(archivedTargetIn(index, snapshot.sessions.find(session => session.id === 's-a11')!)).toEqual({ kind: 'session', id: 's-a' });
    expect(archivedTargetIn(index, handoff)).toBeUndefined();
  });

  it('archiveTargetOf: the top of a conversation (from a grandchild too), the run of a node session', () => {
    const snapshot = data();
    expect(archiveTargetOf(snapshot, 's-a11')).toEqual({ kind: 'session', id: 's-a' });
    expect(archiveTargetOf(snapshot, 's-wf-build-a')).toEqual({ kind: 'run', id: 'inst-login' });
    expect(archiveTargetOf(snapshot, 'missing')).toBeUndefined();
    expect(targetArchived(archive(snapshot, 's-a'), { kind: 'session', id: 's-a' as never })).toBe(true);
    expect(targetArchived(snapshot, { kind: 'run', id: 'inst-docs' as never })).toBe(false);
    expect(targetArchived(snapshot, { kind: 'run', id: 'gone' as never })).toBeUndefined();
    expect(targetRevision(snapshot, { kind: 'run', id: 'inst-docs' as never })).toBe(ended.revision);
  });
});

describe('archiveBlock (the menu forecast)', () => {
  const session = (id: string) => ({ kind: 'session' as const, id: id as never });
  const run = (id: string) => ({ kind: 'run' as const, id: id as never });

  it('nothing in the way: undefined (a quiet tree, an ended quiet run)', () => {
    expect(archiveBlock(data(), session('s-a'))).toBeUndefined();
    expect(archiveBlock(data(), run('inst-docs'))).toBeUndefined();
  });

  it('not-top-level, workflow-session, run-not-ended', () => {
    expect(archiveBlock(data(), session('s-a1'))).toBe('not-top-level');
    expect(archiveBlock(data(), session('s-wf-root'))).toBe('workflow-session');
    expect(archiveBlock(data(), run('inst-login'))).toBe('run-not-ended');
    expect(archiveBlock(data(s => ({ instances: s.instances.map(item => item.id === 'inst-docs' ? { ...item, state: 'blocked' as const } : item) })), run('inst-docs'))).toBe('run-not-ended');
  });

  it.each(['running', 'waiting-user', 'waiting-lock', 'reconciling'] as const)('turn-running: a session of the tree (a grandchild) is %s', activity => {
    expect(archiveBlock(data(s => ({ sessions: s.sessions.map(item => item.id === 's-a11' ? { ...item, activity } : item) })), session('s-a'))).toBe('turn-running');
    expect(archiveBlock(data(s => ({ sessions: s.sessions.map(item => item.id === 's-docs-rev-codex' ? { ...item, activity } : item) })), run('inst-docs'))).toBe('turn-running');
  });

  it('turn-running: a running main turn; not a sub-agent turn alone', () => {
    const turn = { ...fixtureSnapshot.turns.find(item => item.state === 'running')!, sessionId: 's-a1' as never };
    expect(archiveBlock(data(s => ({ turns: [...s.turns, turn] })), session('s-a'))).toBe('turn-running');
    expect(archiveBlock(data(s => ({ turns: [...s.turns, { ...turn, nativeTaskId: 'task-1' as never }] })), session('s-a'))).toBeUndefined();
  });

  it('turn-running: a transfer draft, or approved and not sent (T059 r1); escalation-open: awaiting confirmation', () => {
    const base = fixtureSnapshot.transfers.find(item => item.state === 'awaiting-confirmation')!;
    const draft = { ...base, id: 'tr-x' as never, sourceSessionId: 's-a1' as never, state: 'draft' as const };
    expect(archiveBlock(data(s => ({ transfers: [...s.transfers, draft] })), session('s-a'))).toBe('turn-running');
    const approved = fixtureSnapshot.transfers.find(item => item.state === 'approved')!;
    const unsent = { ...approved, sourceSessionId: 's-a11' as never, delivery: approved.delivery && { ...approved.delivery, state: 'pending' as const } };
    expect(archiveBlock(data(s => ({ transfers: [...s.transfers.filter(item => item.id !== approved.id), unsent] })), session('s-a'))).toBe('turn-running');
    const sent = { ...approved, sourceSessionId: 's-a11' as never, delivery: approved.delivery && { ...approved.delivery, state: 'sent' as const } };
    expect(archiveBlock(data(s => ({ transfers: [...s.transfers.filter(item => item.id !== approved.id), sent] })), session('s-a'))).toBeUndefined();
    expect(archiveBlock(data(s => ({ transfers: [...s.transfers, { ...base, id: 'tr-y' as never, sourceSessionId: 's-a' as never }] })), session('s-a'))).toBe('escalation-open');
  });

  it('escalation-open: open from a session of the tree, or for the run; an answered one does not count', () => {
    const open = { ...fixtureSnapshot.escalations.find(item => item.state === 'open')!, id: 'esc-x' as never, fromSessionId: 's-a11' as never, rootSessionId: 's-a11' as never };
    delete (open as { instanceId?: string }).instanceId;
    expect(archiveBlock(data(s => ({ escalations: [...s.escalations, open] })), session('s-a'))).toBe('escalation-open');
    expect(archiveBlock(data(s => ({ escalations: [...s.escalations, { ...open, state: 'approved' as const }] })), session('s-a'))).toBeUndefined();
    expect(archiveBlock(data(s => ({ escalations: [...s.escalations, { ...open, fromSessionId: 's-docs-lead' as never, rootSessionId: 's-docs-lead' as never, instanceId: 'inst-docs' as never }] })), run('inst-docs'))).toBe('escalation-open');
  });
});

describe('reason words (command-feedback)', () => {
  it('every CommandRefusal has words; commandFeedback uses them over the code', () => {
    for (const reason of CommandRefusal.options) expect(REFUSAL_TEXT[reason]).toMatch(/。$/);
    expect(commandFeedback({ ok: false, requestId: null, code: 'invalid_transition', message: '', retryable: true, mayHaveSideEffects: false, reason: 'turn-running' }, 'session.archive'))
      .toBe('有工作正在進行，結束後才能封存。');
    expect(commandFeedback({ ok: false, requestId: null, code: 'invalid_transition', message: '', retryable: false, mayHaveSideEffects: false, reason: 'archived' }, 'transfer.prepare'))
      .toBe('這個對話已封存，請先取消封存。');
  });

  it('an unknown or missing reason: undefined, and the general words stay (no throw)', () => {
    expect(refusalText('something-new')).toBeUndefined();
    expect(refusalText(undefined)).toBeUndefined();
    expect(refusalText('toString')).toBeUndefined();
    const result = { ok: false as const, requestId: null, code: 'invalid_transition' as const, message: '', retryable: false, mayHaveSideEffects: false, reason: 'something-new' as never };
    expect(commandFeedback(result)).toBe('目前狀態不允許此操作。');
  });
});

describe('the 已封存 open state (localStorage)', () => {
  it('reads both modes; anything else is closed', () => {
    expect(readArchivedOpen({ ok: true, value: { chat: true, workflow: false } })).toEqual({ chat: true, workflow: false });
    expect(readArchivedOpen({ ok: true, value: { chat: 'yes', workflow: 1 } })).toEqual(ARCHIVED_CLOSED);
    expect(readArchivedOpen({ ok: true, value: null })).toEqual(ARCHIVED_CLOSED);
    expect(readArchivedOpen({ ok: true, value: [true] })).toEqual(ARCHIVED_CLOSED);
    expect(readArchivedOpen({ ok: false })).toEqual(ARCHIVED_CLOSED);
  });
});

describe('move targets leave archived trees out (U4)', () => {
  it('no target in an archived tree; a session of one has none and cannot move, also not to the top', () => {
    const snapshot = archive(data(), 's-a');
    const ids = moveTargets(snapshot, 's-b', session => session.title).map(session => session.id);
    expect(ids).not.toContain('s-a');
    expect(ids).not.toContain('s-a1');
    expect(ids).toContain('s-handoff-codex');
    expect(moveTargets(snapshot, 's-a1', session => session.title)).toEqual([]);
    expect(canMove(snapshot, 's-b' as never, 's-a1' as never)).toBe(false);
    expect(canMove(snapshot, 's-a1' as never, null)).toBe(false);
    expect(canMove(snapshot, 's-a11' as never, 's-b' as never)).toBe(false);
    expect(canMove(data(), 's-a1' as never, null)).toBe(true);
    expect(canMove(data(), 's-b' as never, 's-a1' as never)).toBe(true);
  });
});
