// T054 (U3 Q-16): what of the split layout is kept, and how it is restored against the first Snapshot.
import { describe, expect, it } from 'vitest';
import type { SessionId } from '../../../../contracts';
import { restoreLayout, serializeLayout, startPanes } from './pane-memory';
import { initialPanes, paneReducer } from './pane-state';
import type { PaneState } from './pane-state';

const id = (value: string) => value as SessionId;
const all = () => true;
const stored = (value: unknown) => ({ ok: true as const, value: JSON.parse(JSON.stringify(value)) as unknown });

function twoPanes(): PaneState {
  let state = initialPanes(id('a'));
  state = paneReducer(state, { type: 'context', paneId: 'pane-1', sessionId: id('a'), patch: { draft: '草稿 A', details: true, tab: 'tasks', reading: { anchor: { id: 'm1', offset: 3 }, following: false } } });
  state = paneReducer(state, { type: 'split', sessionId: id('b') });
  state = paneReducer(state, { type: 'context', paneId: 'pane-2', sessionId: id('b'), patch: { draft: '草稿 B' } });
  return paneReducer(state, { type: 'focus', paneId: 'pane-1' });
}

describe('T054 split layout memory', () => {
  it('keeps the panes, their sessions, the active pane and each detail pane, but no draft or reading position', () => {
    const layout = serializeLayout(twoPanes());
    expect(layout).toEqual({ version: 1, active: 0, panes: [{ sessionId: 'a', details: true, tab: 'tasks' }, { sessionId: 'b', details: false, tab: 'files' }] });
    expect(JSON.stringify(layout)).not.toMatch(/草稿|m1|reading/);
    const restored = restoreLayout(stored(layout), all)!;
    expect(restored.panes.map(pane => pane.sessionId)).toEqual(['a', 'b']);
    expect(restored.active).toBe('pane-1');
    expect(restored.panes[0]!.contexts.a).toEqual({ draft: '', details: true, tab: 'tasks' });
    expect(restored.panes[1]!.contexts.b).toEqual({ draft: '', details: false, tab: 'files' });
    expect(restored.nextId).toBe(3);
  });

  it('skips panes whose session is gone; the first remaining pane becomes active when the active one went', () => {
    const layout = { ...serializeLayout(twoPanes()), active: 0 };
    const restored = restoreLayout(stored(layout), value => value === 'b')!;
    expect(restored.panes.map(pane => [pane.id, pane.sessionId])).toEqual([['pane-1', 'b']]);
    expect(restored.active).toBe('pane-1');
    expect(restoreLayout(stored({ ...layout, active: 1 }), value => value === 'a')!.active).toBe('pane-1');
  });

  it.each([
    ['nothing stored', { ok: false } as const],
    ['every session gone', stored(serializeLayout(twoPanes()))],
    ['no panes', stored({ version: 1, panes: [], active: 0 })],
    ['another version', stored({ ...serializeLayout(twoPanes()), version: 2 })],
    ['an unknown tab', stored({ version: 1, active: 0, panes: [{ sessionId: 'a', details: true, tab: 'secret' }] })],
    ['more panes than allowed', stored({ version: 1, active: 0, panes: ['a', 'b', 'c'].map(sessionId => ({ sessionId, details: false, tab: 'files' })) })],
    ['extra fields', stored({ ...serializeLayout(twoPanes()), draft: 'x' })],
    ['not an object', stored('pane-1')],
  ])('%s: the default screen', (name, value) => {
    expect(restoreLayout(value, name === 'every session gone' ? () => false : all)).toBeUndefined();
  });

  it('start-up: the address names a shown session (made active) or another one (shown in the active pane)', () => {
    const restored = restoreLayout(stored(serializeLayout(twoPanes())), all)!;
    expect(startPanes(restored, id('b')).active).toBe('pane-2');
    const other = startPanes(restored, id('c'));
    expect(other.panes.map(pane => pane.sessionId)).toEqual(['c', 'b']);
    expect(other.active).toBe('pane-1');
    expect(startPanes(restored, undefined)).toBe(restored);
    expect(startPanes(undefined, id('a'))).toEqual(initialPanes(id('a')));
  });
});
