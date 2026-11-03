// @vitest-environment jsdom
import { useSyncExternalStore } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command, CONTRACTS_VERSION, RequestId, Snapshot } from '../../../contracts';
import type { CommandResult } from '../../../contracts';
import { fixtureSnapshot } from '../../../contracts/fixtures/snapshot';
import { WorkflowStart } from './WorkflowStart';
import { createRendererStore } from './renderer-store';
import type { RendererStore } from './renderer-store';
import { deferred, fakeBridge } from './ipc-test-helpers';

const stores: RendererStore[] = [];
afterEach(() => { cleanup(); stores.forEach(store => store.dispose()); stores.length = 0; });
function Harness({ store }: { store: RendererStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return <WorkflowStart snapshot={state.snapshot!} store={store} ipcState={state} onOpen={vi.fn()} />;
}
async function setup(snapshot: Snapshot = fixtureSnapshot, timeoutMs = 15000) {
  const fake = fakeBridge(snapshot);
  const store = createRendererStore(fake.bridge, timeoutMs);
  stores.push(store);
  await store.start();
  const mounted = render(<Harness store={store} />);
  return { fake, store, ...mounted };
}
function fill() {
  fireEvent.change(screen.getByLabelText('標題'), { target: { value: '新的工作' } });
  fireEvent.change(screen.getByLabelText('工作資料夾'), { target: { value: 'E:\\work' } });
  fireEvent.change(screen.getByLabelText('第一則訊息'), { target: { value: '請完成實作' } });
}
const start = () => screen.getByRole<HTMLButtonElement>('button', { name: '啟動 Workflow' });

describe('T025 workflow start', () => {
  it.each(['unknown_outcome', 'storage_failed'] as const)('reconciles %s with the generated instance ID using the start-screen reload action', async code => {
    const { fake, store, unmount } = await setup();
    fake.bridge.send.mockImplementation(command => Promise.resolve({ ok: false, requestId: RequestId.parse(command.requestId), code, message: 'unknown', retryable: false, mayHaveSideEffects: true }));
    fill(); fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(start());
    await screen.findByText(new RegExp(code));
    const command = Command.parse(fake.bridge.send.mock.calls[0]![0]);
    if (command.type !== 'workflow.start') throw new Error('wrong command');
    // Existing unrelated instances do not establish success. The receipt also
    // remains available from the store if the start screen is mounted again.
    unmount(); render(<Harness store={store} />);
    expect(screen.getByText(/最新資料尚未出現本次執行群組/)).toBeTruthy();
    expect(screen.getByText(`待核對的執行群組：${command.instanceId}`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重新讀取資料並核對' }));
    await waitFor(() => expect(fake.bridge.snapshot).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(store.getSnapshot().connection).toBe('ready'));
    expect(screen.queryByText(/已核對：執行群組已啟動/)).toBeNull();
    fake.data.snapshot.instances.push({ ...fixtureSnapshot.instances[0]!, id: command.instanceId, rootSessionId: command.rootSessionId,
      tasks: fixtureSnapshot.instances[0]!.tasks.map(task => ({ ...task, instanceId: command.instanceId })),
    });
    fake.data.snapshot.sessions.push({ ...fixtureSnapshot.sessions[0]!, id: command.rootSessionId });
    // A reload must pass the same contract validation as a real bridge snapshot.
    Snapshot.parse(fake.data.snapshot);
    fireEvent.click(screen.getByRole('button', { name: '重新讀取資料並核對' }));
    await screen.findByText(`已核對：執行群組已啟動。執行群組：${command.instanceId}`);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '開啟 root session' }).disabled).toBe(false);
    expect(screen.queryByText(/最新資料尚未出現本次執行群組/)).toBeNull();
    expect(screen.queryByText(new RegExp(code))).toBeNull();
    expect(start().matches(':disabled')).toBe(true);
    expect(fake.bridge.send).toHaveBeenCalledTimes(1);
  });

  it('requires cross-tool consent, lists every node, and submits pinned revision and renderer IDs', async () => {
    const { fake } = await setup();
    fill();
    expect(screen.getByRole('region', { name: '各 node 使用的工具' }).textContent).toContain('claude');
    expect(screen.getByRole('region', { name: '各 node 使用的工具' }).textContent).toContain('codex');
    expect(screen.getAllByRole('row')).toHaveLength(fixtureSnapshot.workflows[0]!.nodes.length + 1);
    expect(start().disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(start());
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(1));
    const command = Command.parse(fake.bridge.send.mock.calls[0]![0]);
    expect(command).toMatchObject({ type: 'workflow.start', workflowId: fixtureSnapshot.workflows[0]!.id,
      workflowRevision: fixtureSnapshot.workflows[0]!.revision, title: '新的工作', workFolder: 'E:\\work', projectFolder: 'E:\\work', firstMessage: '請完成實作', crossToolConsent: true });
    if (command.type !== 'workflow.start') throw new Error('wrong command');
    expect(new Set([command.requestId, command.instanceId, command.rootSessionId]).size).toBe(3);
    await screen.findByText(/unsupported/);
    expect(screen.queryByText(/misleading/)).toBeNull();
    fireEvent.click(start());
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(2));
    expect(fake.bridge.send.mock.calls[1]![0].requestId).not.toBe(command.requestId);
  });

  it('resets consent on template changes and explicitly reloads changed revisions', async () => {
    const { fake } = await setup();
    fill();
    fireEvent.click(screen.getByRole('checkbox'));
    const updated = { ...fixtureSnapshot.workflows[0]!, revision: 99 };
    act(() => fake.emit({ schemaVersion: CONTRACTS_VERSION, seq: fixtureSnapshot.seq + 1, event: { type: 'workflow.updated', workflow: updated } }));
    expect(start().disabled).toBe(true);
    expect(screen.getByText(/已審閱版本/).textContent).not.toContain('99');
    fireEvent.click(screen.getByRole('button', { name: '載入目前範本' }));
    expect(screen.getByRole<HTMLInputElement>('checkbox').checked).toBe(false);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(start());
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(1));
    expect(fake.bridge.send.mock.calls[0]![0]).toMatchObject({ workflowRevision: 99 });
  });

  it('starts a single-runtime template without inventing cross-tool consent', async () => {
    const snapshot = structuredClone(fixtureSnapshot);
    snapshot.workflows[0]!.nodes = snapshot.workflows[0]!.nodes.map(node => node.kind === 'agent' ? { ...node, model: { ...node.model, runtime: 'claude' } } : node);
    const { fake } = await setup(snapshot);
    fill();
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(start());
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(1));
    expect(fake.bridge.send.mock.calls[0]![0]).toMatchObject({ crossToolConsent: false });
  });

  it('blocks double submits and unknown outcomes even after remounting with fresh create IDs', async () => {
    const { fake, store, unmount } = await setup();
    const response = deferred<CommandResult>();
    fake.bridge.send.mockReturnValueOnce(response.promise);
    fill(); fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(start()); fireEvent.click(start());
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(1));
    await act(async () => { response.resolve({ ok: false, requestId: RequestId.parse(fake.bridge.send.mock.calls[0]![0].requestId), code: 'storage_failed', message: 'retry now', retryable: true, mayHaveSideEffects: true }); await Promise.resolve(); });
    expect(start().matches(':disabled')).toBe(true);
    expect(screen.getByText(/不可直接重試/)).toBeTruthy();
    unmount();
    render(<Harness store={store} />);
    expect(start().matches(':disabled')).toBe(true);
    expect(fake.bridge.send).toHaveBeenCalledTimes(1);
  });

  it('accepts a late success receipt after timeout without reopening the start action', async () => {
    const { fake } = await setup(fixtureSnapshot, 50);
    const response = deferred<CommandResult>();
    fake.bridge.send.mockReturnValueOnce(response.promise);
    fill(); fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(start());
    await screen.findByText(/unknown_outcome/);
    await act(async () => {
      response.resolve({ ok: true, requestId: RequestId.parse(fake.bridge.send.mock.calls[0]![0].requestId), created: [] });
      await Promise.resolve();
    });
    await screen.findByText(/啟動指令已接受/);
    expect(start().matches(':disabled')).toBe(true);
    expect(fake.bridge.send).toHaveBeenCalledTimes(1);
  });

  it('shows an empty state without creating a workflow', async () => {
    const { fake } = await setup({ ...fixtureSnapshot, workflows: [] });
    expect(screen.getByText(/尚無 Workflow 範本/)).toBeTruthy();
    expect(start().matches(':disabled')).toBe(true);
    expect(fake.bridge.send).not.toHaveBeenCalled();
  });
});
