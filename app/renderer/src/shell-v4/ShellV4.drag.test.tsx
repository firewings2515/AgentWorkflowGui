// @vitest-environment jsdom
// T056 (WB-04): dragging a chat row onto another row (「移到…底下」) or onto the top zone (「移到最上層」) in the connected
// v0.4 shell. Fixture tree: 規劃想法 (s-plan-notes) → 參考資料整理 (s-research); 規劃想法（轉交 Codex） (s-handoff-codex) on top.
// jsdom has no DataTransfer: Testing Library puts the plain object given as `dataTransfer` on the event as it is.
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command, CONTRACTS_VERSION, RequestId } from '../../../../contracts';
import type { AppEvent, CommandResult, ErrorCode, LogicalSession, Snapshot } from '../../../../contracts';
import { fixtureSnapshot } from '../../../../contracts/fixtures/snapshot';
import { App } from '../App';
import { rendererStore } from '../renderer-store';
import { deferred, fakeBridge } from '../ipc-test-helpers';
import { moveTargets } from './move-targets';
import { SESSION_DRAG_TYPE } from './session-drag';
import { STALE_MOVE } from './ShellV4';

// The sidebar works out the drop targets with moveTargets; a spy counts how often (T040: not on every dragover).
vi.mock('./move-targets', async original => {
  const actual = await original<typeof import('./move-targets')>();
  return { ...actual, moveTargets: vi.fn(actual.moveTargets) };
});

let fake: ReturnType<typeof fakeBridge>;
let seq: number;
const byId = (id: string) => fixtureSnapshot.sessions.find(session => session.id === id)!;
const plan = byId('s-plan-notes'); const research = byId('s-research'); const handoff = byId('s-handoff-codex');
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); });
  fake = fakeBridge(); window.awg = fake.bridge; seq = fixtureSnapshot.seq;
  window.history.replaceState(null, '', `/#/sessions/${plan.id}`); localStorage.clear();
  vi.mocked(moveTargets).mockClear();
});
afterEach(() => { cleanup(); rendererStore(fake.bridge).dispose(); delete window.awg; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

async function setup() { render(<App />); await screen.findByText('IPC 已連線'); }
const emit = (event: AppEvent) => act(() => fake.emit({ schemaVersion: CONTRACTS_VERSION, seq: ++seq, event }));
const sidebar = () => within(screen.getByRole('complementary', { name: '側欄' }));
// Rows are found by data-session-id: the unread and pending dots change the button's accessible name.
const rowButton = (id: string) => document.querySelector<HTMLButtonElement>(`.v4-sidebar [data-session-id="${id}"] > .v4-row > .v4-session`)!;
const row = (id: string) => document.querySelector<HTMLElement>(`.v4-sidebar [data-session-id="${id}"] > .v4-row`)!;
const topZone = () => document.querySelector<HTMLElement>('.v4-sidebar .v4-drop-top');
const reparents = () => fake.bridge.send.mock.calls.map(([input]) => Command.parse(input)).filter(command => command.type === 'session.reparent');
const accepted = (input: { requestId: string }): CommandResult => ({ ok: true, requestId: RequestId.parse(input.requestId), created: [] });
const answer = (code: ErrorCode) => fake.bridge.send.mockImplementation(input =>
  Promise.resolve({ ok: false, requestId: RequestId.parse(input.requestId), code, message: '', retryable: false, mayHaveSideEffects: false }));
const LONG_WAIT = 20_000;
/** Nothing of a drag is left on screen. */
const nothingLit = () => document.querySelectorAll('.v4-sidebar [data-drop], .v4-sidebar [data-dragging]').length === 0 && topZone() === null;

/** A stand-in for the browser's DataTransfer: what is set on it can be read back, like within one drag. */
function transfer(data: Record<string, string> = {}) {
  const items = new Map(Object.entries(data));
  return {
    get types() { return [...items.keys()]; },
    getData: (type: string) => items.get(type) ?? '',
    setData: vi.fn((type: string, value: string) => { items.set(type, value); }),
    dropEffect: 'none', effectAllowed: 'uninitialized', files: [] as File[], items: [] as unknown[],
  };
}
type Transfer = ReturnType<typeof transfer>;
/** Fires a drag event and says whether the page took it (preventDefault) and the dropEffect it chose. */
function drag(kind: 'dragEnter' | 'dragOver' | 'drop', element: Element, dataTransfer: Transfer) {
  const event = createEvent[kind](element, { dataTransfer });
  fireEvent(element, event);
  return { taken: event.defaultPrevented, effect: dataTransfer.dropEffect };
}
const nextTask = () => act(() => new Promise<void>(resolve => { setTimeout(resolve, 0); }));
/** Starts dragging a row, then lets the list show the drag (one task later). */
async function start(id: string, dataTransfer = transfer()) {
  fireEvent.dragStart(rowButton(id), { dataTransfer });
  await nextTask();
  return dataTransfer;
}
/** Drops on a row (or the top zone): over it first, as the browser does. */
function dropOn(element: Element, dataTransfer: Transfer, from = research.id) {
  drag('dragOver', element, dataTransfer);
  const result = drag('drop', element, dataTransfer);
  fireEvent.dragEnd(rowButton(from), { dataTransfer });
  return result;
}
/** Replaces the Snapshot through the 重新讀取資料 button, as a reload does. */
async function reload(change: (snapshot: Snapshot) => Snapshot) {
  fake.data.snapshot = { ...change(fake.data.snapshot), seq: ++seq };
  fireEvent.click(sidebar().getByRole('button', { name: '重新讀取資料' }));
  await screen.findByText('IPC 已連線');
  await act(async () => { await Promise.resolve(); });
}

describe('T056 what can be dragged', () => {
  it('rows of the chat tree drag, children too; dragStart puts only the session id, as a move', async () => {
    await setup();
    expect(rowButton(plan.id).getAttribute('draggable')).toBe('true');
    expect(rowButton(research.id).getAttribute('draggable')).toBe('true');
    expect(rowButton(handoff.id).getAttribute('draggable')).toBe('true');
    const data = await start(research.id);
    expect(data.setData).toHaveBeenCalledTimes(1);
    expect(data.setData).toHaveBeenCalledWith(SESSION_DRAG_TYPE, research.id);
    expect(data.effectAllowed).toBe('move');
    expect(rowButton(research.id).dataset['dragging']).toBe('true');
    expect(topZone()?.textContent).toBe('移到最上層');
  });

  it('nothing drags in Workflow mode, in the pinned list or in search results', async () => {
    fake.data.snapshot = { ...fake.data.snapshot, preferences: { ...fake.data.snapshot.preferences, pinned: { chat: [handoff.id], workflow: [] } } };
    await setup();
    const refused = (button: HTMLElement) => {
      expect(button.getAttribute('draggable')).not.toBe('true');
      const data = transfer();
      fireEvent.dragStart(button, { dataTransfer: data });
      expect(data.setData).not.toHaveBeenCalled();
    };
    // Pinned: only in the pinned list, not in the tree.
    const pinnedRow = document.querySelector<HTMLElement>(`.v4-sidebar section[aria-label="釘選"] [data-session-id="${handoff.id}"] .v4-session`)!;
    refused(pinnedRow);
    fireEvent.change(sidebar().getByRole('searchbox'), { target: { value: '參考資料' } });
    refused(rowButton(research.id));
    fireEvent.change(sidebar().getByRole('searchbox'), { target: { value: '' } });
    fireEvent.click(sidebar().getByRole('button', { name: /^Workflow/ }));
    refused(document.querySelector<HTMLElement>('.v4-sidebar [data-run-id] .v4-session')!);
    fireEvent.click(document.querySelector<HTMLElement>('.v4-sidebar [data-run-id] .v4-row-toggle')!);
    refused(document.querySelector<HTMLElement>('.v4-sidebar [data-run-id] ul [data-session-id] .v4-session')!);
    await nextTask();
    expect(nothingLit()).toBe(true);
  });

  it('read-only: rows do not drag, and a drop sends nothing', async () => {
    fake = fakeBridge({ ...fixtureSnapshot, app: { status: 'read-only', reason: 'disk-full', location: 'E:\\db' } }); window.awg = fake.bridge;
    await setup();
    expect(rowButton(research.id).getAttribute('draggable')).not.toBe('true');
    const data = await start(research.id);
    expect(data.setData).not.toHaveBeenCalled();
    expect(nothingLit()).toBe(true);
    expect(drag('drop', row(handoff.id), transfer({ [SESSION_DRAG_TYPE]: research.id })).taken).toBe(true);
    expect(fake.bridge.send).not.toHaveBeenCalled();
  });

  it('a row being moved does not drag; another row still does', async () => {
    const pending = deferred<CommandResult>();
    let requestId = '';
    fake.bridge.send.mockImplementation(input => { if (input.type === 'session.reparent' && input.sessionId === research.id) { requestId = input.requestId; return pending.promise; } return Promise.resolve(accepted(input)); });
    await setup();
    const data = await start(research.id);
    dropOn(topZone()!, data);
    await waitFor(() => expect(reparents()).toHaveLength(1));
    expect(rowButton(research.id).getAttribute('draggable')).not.toBe('true');
    const again = await start(research.id);
    expect(again.setData).not.toHaveBeenCalled();
    expect(nothingLit()).toBe(true);
    expect(rowButton(plan.id).getAttribute('draggable')).toBe('true');
    await act(async () => { pending.resolve({ ok: true, requestId: RequestId.parse(requestId), created: [] }); await pending.promise; });
    await waitFor(() => expect(rowButton(research.id).getAttribute('draggable')).toBe('true'));
  });
});

describe('T056 where it can be dropped', () => {
  it('not on itself or below it; another ordinary session takes it and lights up under the cursor only', async () => {
    await setup();
    const data = await start(plan.id);
    expect(drag('dragOver', row(plan.id), data)).toEqual({ taken: false, effect: 'none' });
    expect(drag('dragOver', row(research.id), data)).toEqual({ taken: false, effect: 'none' });
    expect(document.querySelectorAll('.v4-sidebar [data-drop]')).toHaveLength(0);
    expect(drag('dragOver', row(handoff.id), data)).toEqual({ taken: true, effect: 'move' });
    expect(row(handoff.id).dataset['drop']).toBe('over');
    expect(document.querySelectorAll('.v4-sidebar [data-drop]')).toHaveLength(1);
    // Moving on to a row it cannot go to puts the light out.
    drag('dragOver', row(research.id), data);
    expect(document.querySelectorAll('.v4-sidebar [data-drop]')).toHaveLength(0);
    // A top-level session has no top zone.
    expect(topZone()).toBeNull();
  });

  it('dragenter moves the light at once, as Chromium fires it first on a new row (T056-shots)', async () => {
    await setup();
    const data = await start(research.id);
    expect(drag('dragEnter', row(handoff.id), data)).toEqual({ taken: true, effect: 'move' });
    expect(row(handoff.id).dataset['drop']).toBe('over');
    expect(drag('dragEnter', row(plan.id), data)).toEqual({ taken: false, effect: 'none' });
    expect(document.querySelectorAll('.v4-sidebar [data-drop]')).toHaveLength(0);
    expect(drag('dragEnter', topZone()!, data)).toEqual({ taken: true, effect: 'move' });
    expect(topZone()!.dataset['drop']).toBe('over');
    expect(drag('dragEnter', row(handoff.id), transfer({ Files: '' })).taken).toBe(false);
  });

  it('not on its current parent', async () => {
    await setup();
    const data = await start(research.id);
    expect(drag('dragOver', row(plan.id), data)).toEqual({ taken: false, effect: 'none' });
    expect(drag('dragOver', row(handoff.id), data)).toEqual({ taken: true, effect: 'move' });
  });

  it('a drop on a row sends session.reparent once, with that parent and the latest revision', async () => {
    fake.bridge.send.mockImplementation(input => Promise.resolve(accepted(input)));
    await setup();
    emit({ type: 'session.updated', session: { ...research, revision: research.revision + 3 } });
    const data = await start(research.id);
    expect(dropOn(row(handoff.id), data).taken).toBe(true);
    await waitFor(() => expect(reparents()).toHaveLength(1));
    expect(reparents()[0]).toMatchObject({ sessionId: research.id, parentId: handoff.id, expectedRevision: research.revision + 3 });
    expect(nothingLit()).toBe(true);
  });

  it('the top zone shows for a session with a parent and sends parentId null', async () => {
    fake.bridge.send.mockImplementation(input => Promise.resolve(accepted(input)));
    await setup();
    const data = await start(research.id);
    expect(drag('dragOver', topZone()!, data)).toEqual({ taken: true, effect: 'move' });
    expect(topZone()!.dataset['drop']).toBe('over');
    dropOn(topZone()!, data);
    await waitFor(() => expect(reparents()).toHaveLength(1));
    expect(reparents()[0]).toMatchObject({ sessionId: research.id, parentId: null, expectedRevision: research.revision });
  });

  it('the remembered id is sent, not the string on the drag', async () => {
    fake.bridge.send.mockImplementation(input => Promise.resolve(accepted(input)));
    await setup();
    const data = await start(research.id);
    data.setData(SESSION_DRAG_TYPE, plan.id);
    dropOn(row(handoff.id), data);
    await waitFor(() => expect(reparents()).toHaveLength(1));
    expect(reparents()[0]).toMatchObject({ sessionId: research.id, parentId: handoff.id });
  });

  it('works out the targets once at the start, not on every dragover (T040)', async () => {
    await setup();
    vi.mocked(moveTargets).mockClear();
    const data = await start(research.id);
    for (let n = 0; n < 20; n++) drag('dragOver', row(n % 2 ? handoff.id : plan.id), data);
    expect(moveTargets).toHaveBeenCalledTimes(1);
  });
});

describe('T056 data from outside', () => {
  it.each([
    ['files', { Files: '' }],
    ['plain text', { 'text/plain': research.id }],
    ['another type', { 'application/x-other': research.id }],
    ['our type, but no drag started here (another window)', { [SESSION_DRAG_TYPE]: research.id }],
  ])('%s: not taken, nothing sent', async (_name, data) => {
    fake.bridge.send.mockImplementation(input => Promise.resolve(accepted(input)));
    await setup();
    for (const element of [row(handoff.id), row(plan.id)]) {
      expect(drag('dragOver', element, transfer(data)).taken).toBe(false);
      drag('drop', element, transfer(data));
    }
    await act(async () => { await Promise.resolve(); });
    expect(reparents()).toHaveLength(0);
    expect(nothingLit()).toBe(true);
  });

  it('during a drag of ours, a drop of something else sends nothing', async () => {
    fake.bridge.send.mockImplementation(input => Promise.resolve(accepted(input)));
    await setup();
    await start(research.id);
    const other = transfer({ Files: '', 'text/plain': 'x' });
    expect(drag('dragOver', row(handoff.id), other).taken).toBe(false);
    expect(drag('drop', row(handoff.id), other).taken).toBe(false);
    await act(async () => { await Promise.resolve(); });
    expect(reparents()).toHaveLength(0);
  });
});

describe('T056 the Snapshot changed during the drag', () => {
  it('the target moved below the dragged session: the drop is not sent and says the conversation just changed', async () => {
    fake.bridge.send.mockImplementation(input => Promise.resolve(accepted(input)));
    await setup();
    const data = await start(plan.id);
    emit({ type: 'session.updated', session: { ...handoff, revision: handoff.revision + 1, parentId: plan.id } });
    dropOn(row(handoff.id), data, plan.id);
    expect(await screen.findByText(STALE_MOVE)).toBeTruthy();
    expect(reparents()).toHaveLength(0);
    expect(nothingLit()).toBe(true);
  });

  it('the dragged session is gone: nothing stays lit, nothing is taken, no message (on purpose)', async () => {
    fake.bridge.send.mockImplementation(input => Promise.resolve(accepted(input)));
    await setup();
    const data = await start(research.id);
    expect(topZone()).not.toBeNull();
    await reload(snapshot => ({ ...snapshot, sessions: snapshot.sessions.filter(session => session.id !== research.id) }));
    expect(nothingLit()).toBe(true);
    expect(drag('dragOver', row(handoff.id), data).taken).toBe(false);
    drag('drop', row(handoff.id), data);
    await act(async () => { await Promise.resolve(); });
    expect(reparents()).toHaveLength(0);
    expect(screen.queryByText(STALE_MOVE)).toBeNull();
  });

  it('gone from the store but not yet from the screen (same moment): moveSession refuses with the stale message', async () => {
    fake.bridge.send.mockImplementation(input => Promise.resolve(accepted(input)));
    await setup();
    const data = await start(research.id);
    drag('dragOver', row(handoff.id), data);
    const store = rendererStore(fake.bridge);
    const real = store.getSnapshot();
    vi.spyOn(store, 'getSnapshot').mockReturnValue({ ...real, snapshot: { ...real.snapshot!, sessions: real.snapshot!.sessions.filter(session => session.id !== research.id) } });
    drag('drop', row(handoff.id), data);
    vi.mocked(store.getSnapshot).mockRestore();
    expect(await screen.findByText(STALE_MOVE)).toBeTruthy();
    expect(reparents()).toHaveLength(0);
  });

  it('read-only during the drag: nothing stays lit and the drop is not taken', async () => {
    fake.bridge.send.mockImplementation(input => Promise.resolve(accepted(input)));
    await setup();
    const data = await start(research.id);
    await reload(snapshot => ({ ...snapshot, app: { status: 'read-only', reason: 'disk-full', location: 'E:\\db' } }));
    expect(nothingLit()).toBe(true);
    expect(drag('dragOver', row(handoff.id), data).taken).toBe(false);
    drag('drop', row(handoff.id), data);
    await act(async () => { await Promise.resolve(); });
    expect(reparents()).toHaveLength(0);
  });

  it.each(['stale_revision', 'not_found', 'invalid_request'] as const)('%s after the drop: the stale message, never sent again', async code => {
    answer(code);
    await setup();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const data = await start(research.id);
    dropOn(row(handoff.id), data);
    expect(await screen.findByText(STALE_MOVE)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(LONG_WAIT); });
    expect(fake.bridge.send).toHaveBeenCalledTimes(1);
  });
});

describe('T056 clearing', () => {
  it('dragend after a cancel (Esc, outside the list) leaves nothing lit', async () => {
    await setup();
    const data = await start(research.id);
    drag('dragOver', row(handoff.id), data);
    expect(row(handoff.id).dataset['drop']).toBe('over');
    data.dropEffect = 'none';
    fireEvent.dragEnd(rowButton(research.id), { dataTransfer: data });
    expect(nothingLit()).toBe(true);
    expect(drag('dragOver', row(handoff.id), data).taken).toBe(false);
  });

  it('a dragend before the list showed the drag: the late callback shows nothing (an old drag)', async () => {
    await setup();
    const data = transfer();
    fireEvent.dragStart(rowButton(research.id), { dataTransfer: data });
    fireEvent.dragEnd(rowButton(research.id), { dataTransfer: data });
    await nextTask();
    expect(nothingLit()).toBe(true);
  });

  it('a newer drag replaces an older one whose callback had not run', async () => {
    await setup();
    fireEvent.dragStart(rowButton(plan.id), { dataTransfer: transfer() });
    const data = await start(research.id);
    expect(rowButton(research.id).dataset['dragging']).toBe('true');
    expect(rowButton(plan.id).dataset['dragging']).toBeUndefined();
    expect(drag('dragOver', row(handoff.id), data).taken).toBe(true);
  });

  it('safety net: a mouse move with no button held ends a drag whose dragend never came; one with a button held does not', async () => {
    await setup();
    const data = await start(research.id);
    act(() => { window.dispatchEvent(new MouseEvent('pointermove', { buttons: 1 })); });
    expect(topZone()).not.toBeNull();
    act(() => { window.dispatchEvent(new MouseEvent('pointermove', { buttons: 0 })); });
    expect(nothingLit()).toBe(true);
    expect(drag('dragOver', row(handoff.id), data).taken).toBe(false);
  });

  it('a pointermove before the list showed the drag does not end it (the net is set only after)', async () => {
    await setup();
    const data = transfer();
    fireEvent.dragStart(rowButton(research.id), { dataTransfer: data });
    act(() => { window.dispatchEvent(new MouseEvent('pointermove', { buttons: 0 })); });
    await nextTask();
    expect(topZone()).not.toBeNull();
  });

  it('leaving the list puts the row light out', async () => {
    await setup();
    const data = await start(research.id);
    drag('dragOver', row(handoff.id), data);
    fireEvent.dragLeave(sidebar().getByRole('navigation'), { relatedTarget: document.body });
    expect(document.querySelectorAll('.v4-sidebar [data-drop]')).toHaveLength(0);
  });
});

describe('T056 the rows still work as before', () => {
  it('click opens, the context menu and Shift+F10 open, the toggle folds, arrows move focus', async () => {
    await setup();
    const data = await start(handoff.id);
    fireEvent.dragEnd(rowButton(handoff.id), { dataTransfer: data });
    fireEvent.click(rowButton(handoff.id));
    expect(window.location.hash).toBe(`#/sessions/${handoff.id}`);
    fireEvent.contextMenu(rowButton(research.id));
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    rowButton(plan.id).focus();
    fireEvent.keyDown(rowButton(plan.id), { key: 'F10', shiftKey: true });
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.click(sidebar().getByRole('button', { name: `收合 ${plan.title}` }));
    expect(rowButton(research.id)).toBeNull();
    rowButton(handoff.id).focus();
    fireEvent.keyDown(rowButton(handoff.id), { key: 'ArrowDown' });
    expect(document.activeElement).not.toBe(rowButton(handoff.id));
  });

  it('a title with markup drags as plain text (T042)', async () => {
    const evil = { ...handoff, id: 's-evil', title: '<img src=x onerror="alert(1)">\u0007<b>粗</b>', createdAt: '2026-11-04T01:00:00.000Z' } as LogicalSession;
    delete evil.parentId;
    fake.data.snapshot = { ...fake.data.snapshot, sessions: [...fake.data.snapshot.sessions, evil] };
    fake.bridge.send.mockImplementation(input => Promise.resolve(accepted(input)));
    await setup();
    const data = await start(research.id);
    dropOn(row('s-evil'), data);
    await waitFor(() => expect(reparents()).toHaveLength(1));
    expect(reparents()[0]).toMatchObject({ parentId: 's-evil' });
    expect(document.querySelector('.v4-sidebar img, .v4-sidebar b')).toBeNull();
  });
});
