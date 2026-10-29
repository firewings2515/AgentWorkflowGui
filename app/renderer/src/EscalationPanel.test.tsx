// @vitest-environment jsdom
import { useSyncExternalStore } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Command, CONTRACTS_VERSION, Escalation, PermissionRequest, RequestId, SessionId } from '../../../contracts';
import type { EscalationKind, Snapshot } from '../../../contracts';
import { fixtureSnapshot } from '../../../contracts/fixtures/snapshot';
import { EscalationPanel } from './EscalationPanel';
import { createRendererStore } from './renderer-store';
import type { RendererStore } from './renderer-store';
import { fakeBridge } from './ipc-test-helpers';

const root = SessionId.parse('s-wf-root');
const ordinary = fixtureSnapshot.sessions[0]!.id;
const stores: RendererStore[] = [];
afterEach(() => { cleanup(); stores.forEach(store => store.dispose()); stores.length = 0; });
function Harness({ store, sessionId = root }: { store: RendererStore; sessionId?: SessionId }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return <EscalationPanel snapshot={state.snapshot!} store={store} ipcState={state} sessionId={sessionId} />;
}
async function setup(snapshot: Snapshot = fixtureSnapshot, sessionId = root) {
  const fake = fakeBridge(snapshot);
  const store = createRendererStore(fake.bridge);
  stores.push(store);
  await store.start();
  const mounted = render(<Harness store={store} sessionId={sessionId} />);
  return { fake, store, ...mounted };
}
const card = (name: string) => within(screen.getByRole('article', { name }));
const pushCard = () => card('要求執行 git push');
const deliveryCard = () => card('訊息送達結果未知');

describe('T025 escalation decisions', () => {
  it('groups only open escalations belonging to this root, with explicit user authority', async () => {
    const { fake, store, rerender } = await setup();
    expect(screen.getByText('由你決定，不是 root 的 AI')).toBeTruthy();
    expect(screen.getByRole('region', { name: '權限' })).toBeTruthy();
    expect(screen.getByRole('region', { name: '結果未知' })).toBeTruthy();
    expect(screen.queryByRole('article', { name: '確認 task 清單' })).toBeNull();
    rerender(<Harness store={store} sessionId={ordinary} />);
    expect(screen.queryByRole('article')).toBeNull();
    expect(fake.bridge.send).not.toHaveBeenCalled();
  });

  it.each(['approve', 'decline'] as const)('sends an explicit %s for the ordinary-session permission', async decision => {
    const escalation = Escalation.parse({ ...fixtureSnapshot.escalations[0], rootSessionId: ordinary, fromSessionId: ordinary });
    const permission = PermissionRequest.parse({ ...fixtureSnapshot.permissionRequests[0], sessionId: ordinary });
    const { fake } = await setup({ ...fixtureSnapshot, escalations: [escalation], permissionRequests: [permission] }, ordinary);
    expect(screen.getByText('由你決定，不是 agent')).toBeTruthy();
    expect(screen.queryByText('由你決定，不是 root 的 AI')).toBeNull();
    fireEvent.change(pushCard().getByLabelText('回覆說明（選填）'), { target: { value: '僅這一次' } });
    fireEvent.click(pushCard().getByRole('button', { name: decision === 'approve' ? '核准' : '拒絕' }));
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(1));
    expect(Command.parse(fake.bridge.send.mock.calls[0]![0])).toMatchObject({ type: 'escalation.respond', escalationId: escalation.id, decision, note: '僅這一次' });
  });

  it('ignores Enter and form submission, preserves textarea newlines, and approves only by button activation', async () => {
    const permission = PermissionRequest.parse({ ...fixtureSnapshot.permissionRequests[0], kind: 'mcpElicitation', server: 'tracker',
      elicitation: { mode: 'form', serverName: 'tracker', message: '請填寫', requestedSchema: { type: 'object', properties: { title: { type: 'string', title: '標題' } } } } });
    const { fake } = await setup({ ...fixtureSnapshot, permissionRequests: [permission] });
    const input = pushCard().getByLabelText('標題');
    fireEvent.change(input, { target: { value: '草稿' } });
    expect(fireEvent.keyDown(input, { key: 'Enter', cancelable: true })).toBe(false);
    fireEvent.submit(input.closest('form')!);
    fireEvent.submit(deliveryCard().getByRole('checkbox').closest('form')!);
    const note = pushCard().getByLabelText('回覆說明（選填）');
    expect(fireEvent.keyDown(note, { key: 'Enter', cancelable: true })).toBe(true);
    fireEvent.change(note, { target: { value: '第一行\n第二行' } });
    await act(async () => { await Promise.resolve(); });
    expect(fake.bridge.send).not.toHaveBeenCalled();
    const approve = pushCard().getByRole<HTMLButtonElement>('button', { name: '核准' });
    expect(approve.type).toBe('button');
    fireEvent.click(approve);
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(1));
    expect(fake.bridge.send.mock.calls[0]![0]).toMatchObject({ decision: 'approve', content: { title: '草稿' }, note: '第一行\n第二行' });
  });

  it('preserves note, form answers and duplicate-risk consent across permission and escalation updates', async () => {
    const permission = PermissionRequest.parse({ ...fixtureSnapshot.permissionRequests[0], kind: 'mcpElicitation', server: 'tracker', state: 'pending', hold: undefined,
      elicitation: { mode: 'form', serverName: 'tracker', message: '請填寫', requestedSchema: { type: 'object', properties: { title: { type: 'string', title: '標題' } } } } });
    const { fake } = await setup({ ...fixtureSnapshot, permissionRequests: [permission] });
    fireEvent.change(pushCard().getByLabelText('標題'), { target: { value: '未送出的回答' } });
    fireEvent.change(pushCard().getByLabelText('回覆說明（選填）'), { target: { value: '未送出的說明' } });
    fireEvent.click(deliveryCard().getByRole('checkbox'));
    act(() => {
      fake.emit({ schemaVersion: CONTRACTS_VERSION, seq: fixtureSnapshot.seq + 1, event: { type: 'permission.updated', request: PermissionRequest.parse({ ...permission, state: 'held', hold: { reason: 'awaiting-user', escalationId: fixtureSnapshot.escalations[0]!.id } }) } });
      fake.emit({ schemaVersion: CONTRACTS_VERSION, seq: fixtureSnapshot.seq + 2, event: { type: 'escalation.updated', escalation: { ...fixtureSnapshot.escalations[2]!, detail: '已更新的送達資訊' } } });
    });
    expect(pushCard().getByLabelText<HTMLInputElement>('標題').value).toBe('未送出的回答');
    expect(pushCard().getByLabelText<HTMLTextAreaElement>('回覆說明（選填）').value).toBe('未送出的說明');
    expect(deliveryCard().getByRole<HTMLInputElement>('checkbox').checked).toBe(true);
    expect(deliveryCard().getByText('已更新的送達資訊')).toBeTruthy();
    expect(fake.bridge.send).not.toHaveBeenCalled();
  });

  it('disables an accepted approval even while the escalation remains open and no command is blocked', async () => {
    const { fake, store } = await setup();
    fake.bridge.send.mockImplementation(command => Promise.resolve({ ok: true, requestId: RequestId.parse(command.requestId), created: [] }));
    fireEvent.click(pushCard().getByRole('button', { name: '核准' }));
    await screen.findByText('決定已接受，等待最新狀態。');
    expect(store.isBlocked('escalation.respond', 'escalation:esc-1')).toBe(false);
    expect(store.getSnapshot().snapshot!.escalations[0]!.state).toBe('open');
    expect(pushCard().getByRole('button', { name: '核准' }).matches(':disabled')).toBe(true);
    expect(pushCard().getByRole('button', { name: '拒絕' }).matches(':disabled')).toBe(true);
    fireEvent.click(pushCard().getByRole('button', { name: '核准' }));
    await act(async () => { await Promise.resolve(); });
    expect(fake.bridge.send).toHaveBeenCalledTimes(1);
  });

  it('does not resend an open card decision when Snapshot reloads', async () => {
    const { fake, store } = await setup();
    fireEvent.click(pushCard().getByRole('button', { name: '拒絕' }));
    await screen.findByText(/unsupported/);
    fireEvent.change(pushCard().getByLabelText('回覆說明（選填）'), { target: { value: '重讀時保留' } });
    fake.data.snapshot.seq++;
    await act(async () => {
      fake.emit({ schemaVersion: CONTRACTS_VERSION, seq: fake.data.snapshot.seq, event: { type: 'snapshot.invalidated', reason: 'event-write-failed', at: '2026-10-29T12:00:00Z' } });
      await store.start();
    });
    expect(fake.bridge.snapshot).toHaveBeenCalledTimes(2);
    expect(pushCard().getByLabelText<HTMLTextAreaElement>('回覆說明（選填）').value).toBe('重讀時保留');
    expect(fake.bridge.send).toHaveBeenCalledTimes(1);
  });

  it.each<EscalationKind>(['confirmation', 'limit-exceeded', 'no-rule-matched', 'setup-failed', 'merge-failed'])('offers approve/decline with the correct target for %s', async kind => {
    const escalation = Escalation.parse({ id: `esc-${kind}`, rootSessionId: root, fromSessionId: root, kind, title: `待處理 ${kind}`, detail: '已停止，請決定。', state: 'open', createdAt: '2026-10-29T12:00:00Z', ref: { kind: 'report', operationId: 'report-op' } });
    const { fake } = await setup({ ...fixtureSnapshot, escalations: [escalation] });
    fireEvent.click(screen.getByRole('button', { name: '核准' }));
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(1));
    expect(Command.parse(fake.bridge.send.mock.calls[0]![0])).toMatchObject({ type: 'escalation.respond', escalationId: escalation.id, decision: 'approve' });
    await screen.findByText(/unsupported/);
    fireEvent.click(screen.getByRole('button', { name: '拒絕' }));
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(2));
    expect(fake.bridge.send.mock.calls[1]![0]).toMatchObject({ decision: 'decline', escalationId: escalation.id });
    expect(fake.bridge.send.mock.calls[1]![0].requestId).not.toBe(fake.bridge.send.mock.calls[0]![0].requestId);
  });

  it.each(['wait', 'cancel', 'retry'] as const)('resolves unknown delivery with %s and gates retry on duplicate-risk acknowledgement', async decision => {
    const { fake } = await setup();
    expect(deliveryCard().getByRole<HTMLButtonElement>('button', { name: '重試送達' }).disabled).toBe(true);
    fireEvent.click(deliveryCard().getByRole('button', { name: '重試送達' }));
    expect(fake.bridge.send).not.toHaveBeenCalled();
    if (decision === 'retry') fireEvent.click(deliveryCard().getByRole('checkbox', { name: /可能重複送達/ }));
    fireEvent.click(deliveryCard().getByRole('button', { name: { wait: '繼續等待', cancel: '取消送達', retry: '重試送達' }[decision] }));
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(1));
    expect(Command.parse(fake.bridge.send.mock.calls[0]![0])).toMatchObject({ type: 'delivery.resolve', escalationId: 'esc-3', decision, acceptDuplicateRisk: decision === 'retry' });
  });

  it('keeps wait actionable and supports message refs without treating a missing delivery record as unsent', async () => {
    const escalation = Escalation.parse({ ...fixtureSnapshot.escalations[2], rootSessionId: ordinary, fromSessionId: ordinary, ref: { kind: 'message', operationId: 'op-message', messageId: 'missing-message' } });
    const { fake } = await setup({ ...fixtureSnapshot, escalations: [escalation] }, ordinary);
    fake.bridge.send.mockImplementation(command => Promise.resolve({ ok: true, requestId: RequestId.parse(command.requestId), created: [] }));
    fireEvent.click(screen.getByRole('button', { name: '繼續等待' }));
    await screen.findByText(/已選擇繼續等待/);
    fireEvent.click(screen.getByRole('button', { name: '取消送達' }));
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(2));
    expect(fake.bridge.send.mock.calls[1]![0]).toMatchObject({ decision: 'cancel', escalationId: escalation.id });
  });

  it('renders typed elicitation fields and sends form content only on approval', async () => {
    const permission = PermissionRequest.parse({ id: 'form-request', sessionId: root, kind: 'mcpElicitation', summary: '請填寫', server: 'tracker', state: 'pending', paths: [], createdAt: '2026-10-29T12:00:00Z',
      elicitation: { mode: 'form', serverName: 'tracker', message: '建立 issue', requestedSchema: { type: 'object', required: ['title', 'count', 'confirm'], properties: {
        title: { type: 'string', title: '標題' }, count: { type: 'integer', title: '數量', minimum: 1 }, confirm: { type: 'boolean', title: '同意' }, priority: { type: 'string', enum: ['low', 'high'] },
      } } } });
    const escalation = Escalation.parse({ ...fixtureSnapshot.escalations[0], fromSessionId: root, title: '表單核准', ref: { kind: 'permission', permissionRequestId: permission.id } });
    const { fake } = await setup({ ...fixtureSnapshot, escalations: [escalation], permissionRequests: [permission] });
    fireEvent.change(screen.getByLabelText('標題（必填）'), { target: { value: '修正問題' } });
    fireEvent.change(screen.getByLabelText('數量（必填）'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('同意（必填）'), { target: { value: 'false' } });
    fireEvent.change(screen.getByLabelText('priority'), { target: { value: '"high"' } });
    fireEvent.click(screen.getByRole('button', { name: '核准' }));
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(1));
    expect(Command.parse(fake.bridge.send.mock.calls[0]![0])).toMatchObject({ decision: 'approve', content: { title: '修正問題', count: 2, confirm: false, priority: 'high' } });
    await screen.findByText(/unsupported/);
    fireEvent.click(screen.getByRole('button', { name: '拒絕' }));
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(2));
    expect(fake.bridge.send.mock.calls[1]![0]).not.toHaveProperty('content');
  });

  it('supports complex form JSON, rejects malformed JSON, and never executes supplied markup', async () => {
    const permission = PermissionRequest.parse({ id: 'json-request', sessionId: root, kind: 'mcpElicitation', summary: '<script>bad()</script>', server: 'tracker', state: 'pending', paths: [], createdAt: '2026-10-29T12:00:00Z',
      elicitation: { mode: 'form', serverName: 'tracker', message: '資料', requestedSchema: { type: 'object', properties: { nested: { type: 'object' } } } } });
    const escalation = Escalation.parse({ ...fixtureSnapshot.escalations[0], fromSessionId: root, ref: { kind: 'permission', permissionRequestId: permission.id } });
    const { fake } = await setup({ ...fixtureSnapshot, escalations: [escalation], permissionRequests: [permission] });
    fireEvent.change(screen.getByLabelText(/表單內容（JSON）/), { target: { value: '{bad' } });
    fireEvent.click(screen.getByRole('button', { name: '核准' }));
    expect(screen.getByText('表單內容必須是有效的 JSON。')).toBeTruthy();
    expect(fake.bridge.send).not.toHaveBeenCalled();
    expect(document.querySelector('script')).toBeNull();
    fireEvent.change(screen.getByLabelText(/表單內容（JSON）/), { target: { value: '{"nested":{"name":"answer"}}' } });
    fireEvent.click(screen.getByRole('button', { name: '核准' }));
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(1));
    expect(fake.bridge.send.mock.calls[0]![0]).toMatchObject({ content: { nested: { name: 'answer' } } });
  });

  it('disables withdrawn/missing permission requests and removes resolved escalations from the list', async () => {
    const { fake } = await setup();
    act(() => fake.emit({ schemaVersion: CONTRACTS_VERSION, seq: fixtureSnapshot.seq + 1, event: { type: 'permission.updated', request: PermissionRequest.parse({ ...fixtureSnapshot.permissionRequests[0], state: 'withdrawn', hold: undefined }) } }));
    expect(pushCard().getByRole('button', { name: '核准' }).matches(':disabled')).toBe(true);
    act(() => fake.emit({ schemaVersion: CONTRACTS_VERSION, seq: fixtureSnapshot.seq + 2, event: { type: 'escalation.updated', escalation: Escalation.parse({ ...fixtureSnapshot.escalations[0], state: 'resolved', resolvedBy: 'system', resolvedAt: '2026-10-29T13:00:00Z' }) } }));
    expect(screen.queryByRole('article', { name: '要求執行 git push' })).toBeNull();
    expect(fake.bridge.send).not.toHaveBeenCalled();
  });

  it('blocks another approval after mayHaveSideEffects, including a remount', async () => {
    const { fake, store, unmount } = await setup();
    fake.bridge.send.mockImplementation(command => Promise.resolve({ ok: false, requestId: RequestId.parse(command.requestId), code: 'storage_failed', message: 'retry', retryable: true, mayHaveSideEffects: true }));
    fireEvent.click(pushCard().getByRole('button', { name: '核准' }));
    await screen.findByText(/不可直接重試/);
    unmount(); render(<Harness store={store} />);
    expect(pushCard().getByRole('button', { name: '拒絕' }).matches(':disabled')).toBe(true);
    expect(fake.bridge.send).toHaveBeenCalledTimes(1);
  });
});
