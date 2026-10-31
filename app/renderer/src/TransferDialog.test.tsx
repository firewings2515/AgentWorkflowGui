// @vitest-environment jsdom
import { useSyncExternalStore } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command, CONTRACTS_VERSION, RequestId, TransferProposal } from '../../../contracts';
import type { CommandResult } from '../../../contracts';
import { fixtureSnapshot } from '../../../contracts/fixtures/snapshot';
import { createRendererStore } from './renderer-store';
import { deferred, fakeBridge } from './ipc-test-helpers';
import { TransferDialog } from './TransferDialog';

const source = fixtureSnapshot.sessions[0]!;
const target = fixtureSnapshot.modelOptions.find(m => m.runtime !== source.requestedModel.runtime && !m.hidden)!;
async function flush(action: () => void) { await act(async () => { action(); await Promise.resolve(); }); }
const proposal = () => TransferProposal.parse({ ...fixtureSnapshot.transfers[1]!, sourceSessionId: source.id });
let fake: ReturnType<typeof fakeBridge>;
let store: ReturnType<typeof createRendererStore>;
let seq: number;
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const confirm = () => { fireEvent.click(screen.getByRole('checkbox')); click('確認轉交'); };
function Harness() {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return <TransferDialog snapshot={state.snapshot!} store={store} ipcState={state} preview={{ sessionId: source.id, model: target, viewId: 'view-1' }} onClose={vi.fn()} onOpen={vi.fn()} />;
}
async function setup(p?: TransferProposal) {
  fake = fakeBridge({ ...structuredClone(fixtureSnapshot), transfers: p ? [p] : [] });
  seq = fake.data.snapshot.seq;
  store = createRendererStore(fake.bridge);
  await store.start();
  return render(<Harness />);
}
async function update(p: TransferProposal) {
  await flush(() => emit(p));
}
function emit(p: TransferProposal) { fake.emit({ schemaVersion: CONTRACTS_VERSION, seq: ++seq, event: { type: 'transfer.updated', proposal: p } }); }
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
it.each([
  ['source-changed', '來源已變更，請重新產生'], ['user', '使用者已取消此提案'], ['failed', '轉交失敗，提案已取消'],
] as const)('explains cancelled transfer reason %s without confirming or resending', async (cancelReason, text) => {
  await setup(TransferProposal.parse({ ...proposal(), state: 'cancelled', cancelReason, cancelledAt: proposal().createdAt }));
  expect(screen.getByText(new RegExp(text))).toBeTruthy();
  expect(screen.queryByRole('button', { name: '確認轉交' })).toBeNull();
  expect(fake.bridge.send).not.toHaveBeenCalled();
});
afterEach(() => { cleanup(); store?.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('T026 轉交確認', () => {
  it('prepares with new IDs and the captured source, and confirms only the reviewed proposal revision', async () => {
    await setup();
    fake.bridge.send.mockImplementation(input => {
      const c = Command.parse(input);
      if (c.type === 'transfer.prepare') emit({ ...proposal(), id: c.transferId });
      return Promise.resolve({ ok: true, requestId: c.requestId, created: [] });
    });
    expect(fake.bridge.send).not.toHaveBeenCalled();
    await flush(() => click('產生轉交預覽'));
    const prepare = Command.parse(fake.bridge.send.mock.calls[0]![0]);
    expect(prepare).toMatchObject({ type: 'transfer.prepare', sourceSessionId: source.id, target: { runtime: target.runtime, model: target.model }, noteSource: 'gui-digest' });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '確認轉交' }).disabled).toBe(true);
    const frame = within(screen.getByRole('region', { name: '轉交內容預覽' }));
    for (const name of ['目標', '交接說明', '相關 commit 的 diff', '目前測試輸出']) expect(frame.getByRole('heading', { name })).toBeTruthy();
    await flush(() => confirm());
    const command = Command.parse(fake.bridge.send.mock.calls[1]![0]);
    expect(command).toMatchObject({ type: 'transfer.confirm', transferId: 'transferId' in prepare ? prepare.transferId : '', expectedRevision: 0 });
    expect(command.requestId).not.toBe(prepare.requestId);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '確認轉交' }).disabled).toBe(true);
  });

  it('resets review on a new revision and never confirms a stale proposal; cancel then prepare gets a new ID', async () => {
    const p = proposal(); await setup(p);
    fireEvent.click(screen.getByRole('checkbox'));
    await update({ ...p, revision: 1, content: { ...p.content, note: '新版說明' } });
    expect(screen.getByRole<HTMLInputElement>('checkbox').checked).toBe(false);
    await update({ ...p, revision: 2, state: 'stale' });
    expect(screen.queryByRole('button', { name: '確認轉交' })).toBeNull();
    expect(screen.getByText(/此提案已過期/)).toBeTruthy();
    fake.bridge.send.mockImplementation(input => {
      const c = Command.parse(input);
      if (c.type === 'transfer.cancel') emit({ ...p, revision: 3, state: 'cancelled', cancelledAt: p.createdAt });
      return Promise.resolve({ ok: true, requestId: c.requestId, created: [] });
    });
    await flush(() => click('取消提案'));
    expect(fake.bridge.send.mock.calls[0]![0]).toMatchObject({ type: 'transfer.cancel', transferId: p.id });
    await flush(() => click('產生轉交預覽'));
    const next = fake.bridge.send.mock.calls[1]![0];
    expect(next.type).toBe('transfer.prepare');
    expect(next.type === 'transfer.prepare' && next.transferId).not.toBe(p.id);
  });

  it('does not infer stale from source revision, and preserves cancelled + sent facts', async () => {
    const p = proposal(); await setup(p);
    await flush(() => fake.emit({ schemaVersion: CONTRACTS_VERSION, seq: ++seq, event: { type: 'session.updated', session: { ...source, revision: 99 } } }));
    expect(screen.getByText(/等待確認/, { selector: '.status' })).toBeTruthy();
    expect(screen.queryByText(/此提案已過期/)).toBeNull();
    const sent = TransferProposal.parse({ ...fixtureSnapshot.transfers[0]!, id: p.id, sourceSessionId: source.id, revision: 2, state: 'cancelled', cancelledAt: p.createdAt });
    await update(sent);
    expect(screen.getByText(/此提案已取消/)).toBeTruthy();
    expect(screen.getByText(/已送達（不代表已讀）/)).toBeTruthy();
    expect(screen.getByText('已確認建立')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '確認轉交' })).toBeNull();
  });

  it.each(['unknown_outcome', 'storage_failed'] as const)('blocks blind retries after %s with possible effects, including reopen', async code => {
    const p = proposal(); const view = await setup(p);
    fake.bridge.send.mockImplementation(c => Promise.resolve({ ok: false, requestId: RequestId.parse(c.requestId), code, message: 'please retry successfully', retryable: true, mayHaveSideEffects: true }));
    await flush(() => confirm());
    expect(screen.getByText(/轉交結果待核對/)).toBeTruthy();
    expect(screen.queryByText('please retry successfully')).toBeNull();
    view.unmount(); render(<Harness />);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '確認轉交' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '取消提案' }).disabled).toBe(true);
    expect(screen.getByText(/取消不會收回已建立的 session 或已送出的內容/)).toBeTruthy();
    await flush(() => click('取消提案'));
    expect(fake.bridge.send).toHaveBeenCalledTimes(1);
  });

  it('hides cancellation when the payload is accepted, including after reconciliation', async () => {
    const sent = TransferProposal.parse({ ...fixtureSnapshot.transfers[0]!, sourceSessionId: source.id });
    const unknown = TransferProposal.parse({ ...sent, delivery: {
      state: 'unknown', attempts: sent.delivery!.attempts.map(a => ({ attemptId: a.attemptId, clientMessageId: a.clientMessageId, dispatchStartedAt: a.dispatchStartedAt, state: 'unknown' })),
    } });
    await setup(unknown);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '取消提案' }).disabled).toBe(true);
    await flush(() => click('取消提案'));
    expect(fake.bridge.send).not.toHaveBeenCalled();
    await update({ ...sent, revision: sent.revision + 1, approvedRevision: sent.revision + 1 });
    expect(screen.queryByRole('button', { name: '取消提案' })).toBeNull();
    expect(screen.getByText(/已送達，無法取消/)).toBeTruthy();
    expect(fake.bridge.send).not.toHaveBeenCalled();
  });

  it('restores the selected proposal after a prepare rejection without side effects', async () => {
    const p = TransferProposal.parse({ ...proposal(), state: 'cancelled', cancelledAt: proposal().createdAt });
    await setup(p);
    const other = TransferProposal.parse({ ...p, id: 'other-cancelled' });
    await update(other);
    const select = screen.getByRole<HTMLSelectElement>('combobox', { name: '轉交提案' });
    fireEvent.change(select, { target: { value: other.id } });
    expect(select.selectedOptions[0]!.textContent).toContain('已取消');
    await flush(() => click('產生轉交預覽'));
    expect(fake.bridge.send).toHaveBeenCalledTimes(1);
    expect(select.value).toBe(other.id);
    expect(screen.queryByRole('option', { name: '等待提案資料' })).toBeNull();
    expect(screen.getByText(/此提案已取消/)).toBeTruthy();
  });

  it('blocks a second prepare after an unknown response without a proposal, even after reopening', async () => {
    const view = await setup();
    fake.bridge.send.mockRejectedValue(new Error('offline'));
    await flush(() => click('產生轉交預覽'));
    view.unmount(); render(<Harness />);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '產生轉交預覽' }).disabled).toBe(true);
    expect(fake.bridge.send).toHaveBeenCalledTimes(1);
  });

  it('blocks stale_revision receipts until a new authoritative version is reviewed, including reopen', async () => {
    const p = proposal(); const view = await setup(p);
    fake.bridge.send.mockImplementation(c => Promise.resolve({ ok: false, requestId: RequestId.parse(c.requestId), code: 'stale_revision', message: 'wrong text', retryable: true, mayHaveSideEffects: false }));
    await flush(() => confirm());
    view.unmount(); render(<Harness />);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '確認轉交' }).disabled).toBe(true);
    await update({ ...p, revision: 2 });
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '確認轉交' }).disabled).toBe(false);
  });

  it('prevents duplicate prepare while pending and waits for snapshot after success', async () => {
    const view = await setup();
    const response = deferred<CommandResult>(); fake.bridge.send.mockReturnValue(response.promise);
    await flush(() => click('產生轉交預覽'));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '產生轉交預覽' }).disabled).toBe(true);
    const input = fake.bridge.send.mock.calls[0]![0];
    await flush(() => response.resolve({ ok: true, requestId: RequestId.parse(input.requestId), created: [] }));
    view.unmount(); render(<Harness />);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '產生轉交預覽' }).disabled).toBe(true);
    expect(fake.bridge.send).toHaveBeenCalledTimes(1);
  });

  it('uses ErrorCode for a rejected prepare and generates fresh request and proposal IDs for an explicit retry', async () => {
    await setup();
    await flush(() => click('產生轉交預覽'));
    expect(screen.getByText(/目前尚未支援此操作/)).toBeTruthy();
    expect(screen.queryByText(/misleading/)).toBeNull();
    await flush(() => click('產生轉交預覽'));
    const [first, second] = fake.bridge.send.mock.calls.map(call => Command.parse(call[0]));
    expect(first?.type).toBe('transfer.prepare');
    expect(second?.type).toBe('transfer.prepare');
    expect(second?.requestId).not.toBe(first?.requestId);
    expect(second?.type === 'transfer.prepare' && second.transferId).not.toBe(first?.type === 'transfer.prepare' && first.transferId);
  });
});
