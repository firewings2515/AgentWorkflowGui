// T053: the last-message time (shared with T054) and where an ordinary session can be moved (WB-04, U3 Q-18).
import { describe, expect, it } from 'vitest';
import type { LogicalSession, Message, Snapshot } from '../../../../contracts';
import { fixtureSnapshot } from '../../../../contracts/fixtures/snapshot';
import { byLastMessage, lastMessageAt, lastMessageTimes } from './last-message';
import { canMove, moveTargets } from './move-targets';

const base = fixtureSnapshot.sessions.find(session => session.id === 's-plan-notes')!;
const workflow = fixtureSnapshot.sessions.find(session => session.kind === 'workflow')!;
const ordinary = (id: string, title: string, parentId?: string, createdAt = '2026-11-04T01:00:00.000Z'): LogicalSession => {
  const session = { ...base, id, title, createdAt, updatedAt: createdAt } as LogicalSession;
  if (parentId) session.parentId = parentId as LogicalSession['id']; else delete session.parentId;
  return session;
};
const message = (id: string, sessionId: string, createdAt: string) =>
  ({ ...fixtureSnapshot.messages[0]!, id, sessionId, createdAt }) as Message;
const data = (sessions: LogicalSession[], messages: Message[] = []): Pick<Snapshot, 'sessions' | 'messages'> => ({ sessions, messages });
const ids = (sessions: LogicalSession[]) => sessions.map(session => session.id);
const plain = (session: LogicalSession) => session.title;

describe('last message time (U3 Q-17)', () => {
  it('takes the newest message, falls back to createdAt, and compares instants across offsets', () => {
    const a = ordinary('a', 'A'); const b = ordinary('b', 'B', undefined, '2026-11-04T03:00:00.000Z');
    // 10:30+08:00 is 02:30Z: later than 02:00Z although the string sorts lower.
    const times = lastMessageTimes(data([a, b], [message('m1', 'a', '2026-11-04T02:00:00.000Z'), message('m2', 'a', '2026-11-04T10:30:00+08:00'), message('m3', 'a', '2026-11-04T01:30:00.000Z')]));
    expect(lastMessageAt(times, a)).toBe(Date.parse('2026-11-04T02:30:00.000Z'));
    expect(lastMessageAt(times, b)).toBe(Date.parse('2026-11-04T03:00:00.000Z'));
    expect([a, b].sort(byLastMessage(times)).map(session => session.id)).toEqual(['b', 'a']);
  });
});

describe('moveTargets (WB-04)', () => {
  const tree = [
    ordinary('root', '根'), ordinary('child', '子', 'root'), ordinary('grandchild', '孫', 'child'),
    ordinary('other', '其他'), ordinary('third', '第三'),
    { ...workflow, id: 'wf' } as LogicalSession,
  ];

  it('excludes the session, everything below it, its current parent and workflow sessions', () => {
    expect(ids(moveTargets(data(tree), 'root', plain)).sort()).toEqual(['other', 'third']);
    expect(ids(moveTargets(data(tree), 'child', plain)).sort()).toEqual(['other', 'third']);
    expect(ids(moveTargets(data(tree), 'grandchild', plain)).sort()).toEqual(['other', 'root', 'third']);
    expect(moveTargets(data(tree), 'wf', plain)).toEqual([]);
    expect(moveTargets(data(tree), 'missing', plain)).toEqual([]);
  });

  it('sorts by the last message, so a rename (a newer updatedAt) does not move a session up', () => {
    const renamed = { ...ordinary('other', '其他'), updatedAt: '2026-11-04T09:00:00.000Z' };
    const sessions = [tree[0]!, renamed, tree[4]!];
    expect(ids(moveTargets(data(sessions, [message('m1', 'third', '2026-11-04T02:00:00.000Z')]), 'root', plain))).toEqual(['third', 'other']);
  });

  it('filters by title: trimmed, case-insensitive, and taken literally', () => {
    const sessions = [ordinary('me', '我'), ordinary('x', 'Review Notes'), ordinary('y', 'a.*b (draft'), ordinary('z', 'abc')];
    expect(ids(moveTargets(data(sessions), 'me', plain, '  review '))).toEqual(['x']);
    expect(ids(moveTargets(data(sessions), 'me', plain, '.*'))).toEqual(['y']);
    expect(ids(moveTargets(data(sessions), 'me', plain, '(draft'))).toEqual(['y']);
    expect(moveTargets(data(sessions), 'me', plain, 'nothing')).toEqual([]);
    // The shown title (a demo rename) is what is searched.
    expect(ids(moveTargets(data(sessions), 'me', session => session.id === 'z' ? '改名後' : session.title, '改名'))).toEqual(['z']);
  });

  it('stops on a parent cycle in bad data', () => {
    const loop = [ordinary('me', '我'), ordinary('p', 'P', 'q'), ordinary('q', 'Q', 'p')];
    expect(ids(moveTargets(data(loop), 'me', plain)).sort()).toEqual(['p', 'q']);
  });

  it('canMove checks a choice again: below a valid target, or to the top only with a parent', () => {
    const snapshot = data(tree);
    expect(canMove(snapshot, 'root' as LogicalSession['id'], 'other' as LogicalSession['id'])).toBe(true);
    expect(canMove(snapshot, 'root' as LogicalSession['id'], 'grandchild' as LogicalSession['id'])).toBe(false);
    expect(canMove(snapshot, 'root' as LogicalSession['id'], 'wf' as LogicalSession['id'])).toBe(false);
    expect(canMove(snapshot, 'root' as LogicalSession['id'], null)).toBe(false);
    expect(canMove(snapshot, 'child' as LogicalSession['id'], null)).toBe(true);
  });
});
