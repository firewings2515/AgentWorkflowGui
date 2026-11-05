// @vitest-environment jsdom
// T060 r1 P2-1: the 「已封存」 section costs nothing while it is closed (or the sidebar is), and an open one builds each
// row once, without rescanning the archived sessions for children. Archived sessions are wrapped in proxies that count
// reads of the fields a row is built from; a render with the same data (a theme change) must read none of them.
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LogicalSession, Snapshot } from '../../../../contracts';
import { fixtureSnapshot } from '../../../../contracts/fixtures/snapshot';
import { archivedIndex } from './archive';
import type { ArchivedOpen } from './archive';
import { lastMessageTimes } from './last-message';
import { Sidebar } from './Sidebar';
import type { SidebarProps } from './Sidebar';

const ROOTS = 2000;
const counted = new Set(['parentId', 'title', 'activity']);
let reads = 0;
const watch = (session: LogicalSession) => new Proxy(session, {
  get(target, key, receiver) { if (typeof key === 'string' && counted.has(key)) reads++; return Reflect.get(target, key, receiver) as unknown; },
});

const at = '2026-11-05T10:00:00.000Z';
const handoff = fixtureSnapshot.sessions.find(session => session.id === 's-handoff-codex')!;
const archivedSessions: LogicalSession[] = [];
for (let n = 0; n < ROOTS; n++) {
  const createdAt = new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString();
  const root = { ...handoff, id: `a-${n}`, title: `封存 ${n}`, createdAt, updatedAt: createdAt, activity: 'idle', archivedAt: at } as LogicalSession;
  delete (root as { parentId?: string }).parentId;
  const child = { ...handoff, id: `a-${n}-c`, title: `封存 ${n} 子`, createdAt, updatedAt: createdAt, activity: 'idle', parentId: `a-${n}` } as LogicalSession;
  archivedSessions.push(watch(root), watch(child));
}
const snapshot: Snapshot = { ...fixtureSnapshot, sessions: [...fixtureSnapshot.sessions, ...archivedSessions] };
const archived = archivedIndex(snapshot);
const times = lastMessageTimes(snapshot);

function props(archivedOpen: ArchivedOpen, patch: Partial<SidebarProps> = {}): SidebarProps {
  const noop = vi.fn();
  return {
    snapshot, titles: {}, pinned: { chat: new Set(), workflow: new Set() }, mode: 'chat', selectedId: undefined, page: 'chat', collapsed: false, overlay: false,
    theme: 'dark', onMode: noop, onCollapse: noop, onNewChat: noop, onStartWorkflow: noop, onOpen: noop, onSplit: noop, onPin: noop, onRename: noop,
    onRenameRun: noop, onPage: noop, onTheme: noop, onMove: noop, moveReason: () => undefined, readOnly: false, pinBlocked: false, times, unread: new Set(),
    connection: null, archived, archivedOpen, onArchivedOpen: noop, onArchive: noop, archiveReason: () => undefined, ...patch,
  };
}
/** Reads of the counted fields of archived sessions during one more render with the same data. */
function readsOnRerender(open: ArchivedOpen, patch: Partial<SidebarProps> = {}) {
  const view = render(<Sidebar {...props(open, patch)} />);
  reads = 0;
  view.rerender(<Sidebar {...props(open, { ...patch, theme: 'light' })} />);
  return reads;
}

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('closed: a render reads no archived session; the count still shows', () => {
  expect(readsOnRerender({ chat: false, workflow: false })).toBe(0);
  expect(document.querySelector('.v4-archived .v4-count')?.textContent).toBe(String(ROOTS));
  expect(document.querySelectorAll('.v4-archived [data-session-id]')).toHaveLength(0);
});

it('the sidebar collapsed to its rail: none either, also with the section open', () => {
  expect(readsOnRerender({ chat: true, workflow: false }, { collapsed: true })).toBe(0);
});

it('open: one row per tree, built from an index (no rescan per row: well under one read per pair of sessions per row)', () => {
  const total = readsOnRerender({ chat: true, workflow: false });
  expect(document.querySelectorAll('.v4-archived [data-session-id]')).toHaveLength(ROOTS);
  expect(total).toBeGreaterThan(0);
  // A row reads a few fields of its own session; a scan per row would read about ROOTS * 2 * ROOTS (8 million) fields.
  expect(total).toBeLessThan(ROOTS * 10);
});
