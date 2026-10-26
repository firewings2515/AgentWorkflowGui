// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RequestId } from '../../../contracts';
import { fixtureSnapshot } from '../../../contracts/fixtures/snapshot';
import { ConnectionStatus } from './ConnectionStatus';
import { COMMAND_HISTORY_LIMIT, createRendererStore } from './renderer-store';
import { agentSaveCommand } from './agent-repository';
import { fakeBridge } from './ipc-test-helpers';

afterEach(cleanup);
describe('command activity presentation', () => {
  it('keeps only the latest history entry live and distinguishes unknown outcomes from errors', async () => {
    const fake = fakeBridge();
    const store = createRendererStore(fake.bridge);
    await store.start();
    const agent = fixtureSnapshot.agents[0]!;
    for (let i = 0; i < COMMAND_HISTORY_LIMIT + 2; i++) await store.send(agentSaveCommand(agent, 1));
    fake.bridge.send.mockResolvedValueOnce({ ok: false, requestId: null, code: 'unknown_outcome', message: '', retryable: false, mayHaveSideEffects: true });
    await store.send(agentSaveCommand(agent, 1));
    const view = render(<ConnectionStatus state={store.getSnapshot()} store={store} />);
    fireEvent.click(screen.getByText(`操作結果（${COMMAND_HISTORY_LIMIT}）`));
    const history = screen.getByRole('list', { name: '操作結果' });
    expect(within(history).getAllByRole('listitem')).toHaveLength(COMMAND_HISTORY_LIMIT);
    expect(within(history).getAllByRole('status')).toHaveLength(1);
    expect(within(history).queryByRole('alert')).toBeNull();
    expect(within(history).getByRole('status').closest('li')).toBe(history.lastElementChild);
    expect(within(history).getByRole('status').className).toBe('command-warning');
    expect(within(history).getByText(/結果狀態：unknown_outcome/)).toBeTruthy();
    expect(within(history).queryByText(/錯誤代碼：unknown_outcome/)).toBeNull();
    await store.send({ type: 'preferences.set', requestId: RequestId.parse('latest-error'), preferences: fixtureSnapshot.preferences });
    view.rerender(<ConnectionStatus state={store.getSnapshot()} store={store} />);
    expect(within(history).queryByRole('status')).toBeNull();
    expect(within(history).getAllByRole('alert')).toHaveLength(1);
    expect(within(history).getByRole('alert').className).toBe('field-error');
    expect(within(history).getByRole('alert').closest('li')).toBe(history.lastElementChild);
    store.dispose();
  });

  it('keeps an acknowledgement entry when unresolved history has been evicted', async () => {
    const fake = fakeBridge();
    const store = createRendererStore(fake.bridge);
    await store.start();
    const agent = fixtureSnapshot.agents[0]!;
    fake.bridge.send.mockResolvedValueOnce({ ok: false, requestId: null, code: 'unknown_outcome', message: '', retryable: false, mayHaveSideEffects: true });
    await store.send(agentSaveCommand(agent, 1));
    for (let i = 0; i < COMMAND_HISTORY_LIMIT; i++) await store.send({ type: 'preferences.set', requestId: RequestId.parse(`later-${i}`), preferences: fixtureSnapshot.preferences });
    const view = render(<ConnectionStatus state={store.getSnapshot()} store={store} />);
    fireEvent.click(screen.getByText('待核對操作（1）'));
    fireEvent.click(screen.getByRole('button', { name: '已核對結果' }));
    view.rerender(<ConnectionStatus state={store.getSnapshot()} store={store} />);
    expect(store.isBlocked('agent.save', `agent:${agent.id}`)).toBe(false);
    expect(screen.queryByText(/待核對操作/)).toBeNull();
    expect(fake.bridge.send).toHaveBeenCalledTimes(COMMAND_HISTORY_LIMIT + 1);
    store.dispose();
  });
});
