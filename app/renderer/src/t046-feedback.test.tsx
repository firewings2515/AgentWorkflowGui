// @vitest-environment jsdom
// T046 r1/r2 P2: a session that cannot be resumed nor opened again must tell the user where things stand and how to go
// on. A retry it refused says the retry is saved and to start a new session; a send it refused says the message was not
// sent and to start a new session; a session in `error` says so where messages are written. The words come from the
// code and the operation, never from the service's own message (which may be misleading).
import { useState, useSyncExternalStore } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EscalationId, RequestId } from '../../../contracts';
import { fixtureSnapshot } from '../../../contracts/fixtures/snapshot';
import { commandFeedback } from './command-feedback';
import { ConnectionStatus } from './ConnectionStatus';
import { createRendererStore, type RendererStore } from './renderer-store';
import { SessionWorkspace } from './SessionWorkspace';
import { contextFor, initialWorkspace } from './workbench-state';
import { fakeBridge } from './ipc-test-helpers';

const stores: RendererStore[] = [];
afterEach(() => {
  cleanup();
  stores.forEach((store) => store.dispose());
  stores.length = 0;
});

const failure = (code: 'runtime_unavailable' | 'invalid_transition', mayHaveSideEffects = false) => ({ ok: false as const, requestId: null, code, message: 'SUCCESS: sent', retryable: false, mayHaveSideEffects });

describe('T046: what a refused retry or send tells the user', () => {
  it('a refused retry says it is saved, when it is tried again, and to start a new session; other operations keep the general words', () => {
    // Saved: the service says a change was made (the decision is recorded).
    const retry = commandFeedback(failure('runtime_unavailable', true), 'delivery.resolve');
    expect(retry).toContain('重試已保存');
    expect(retry).toContain('下次啟動時會再試一次');
    expect(retry).toContain('另開一個新的 session');
    expect(retry).not.toContain('SUCCESS');
    // r4 P2: refused before anything was saved (the app closing): never told it is saved.
    expect(commandFeedback(failure('runtime_unavailable'), 'delivery.resolve')).toBe('Runtime 目前無法使用。');
    expect(commandFeedback(failure('runtime_unavailable'), 'session.send')).toBe('Runtime 目前無法使用。');
    expect(commandFeedback(failure('runtime_unavailable'))).toBe('Runtime 目前無法使用。');
  });

  it('a refused send says the message was not sent and to start a new session', () => {
    const send = commandFeedback(failure('invalid_transition'), 'session.send');
    expect(send).toContain('訊息沒有送出');
    // r3 P2: the message itself may be the one that ended (the session still takes new ones), or the session cannot take any.
    expect(send).toContain('這則訊息已經結束、不會再送');
    expect(send).toContain('可以用新的訊息重送');
    expect(send).toContain('另開一個新的 session');
    expect(commandFeedback(failure('invalid_transition'), 'agent.delete')).toBe('Agent 仍被 Workflow 或 session 使用，無法刪除。');
    expect(commandFeedback(failure('invalid_transition'))).toBe('目前狀態不允許此操作。');
  });

  it("a refused retry's explanation stays in the operation results after its escalation has closed", async () => {
    const fake = fakeBridge();
    const store = createRendererStore(fake.bridge);
    stores.push(store);
    await store.start();
    fake.bridge.send.mockResolvedValueOnce({ ...failure('runtime_unavailable', true), requestId: RequestId.parse('t046-retry') });
    await store.send({ type: 'delivery.resolve', requestId: RequestId.parse('t046-retry'), escalationId: EscalationId.parse('delivery:op/attempt-1'), decision: 'retry', acceptDuplicateRisk: true });
    render(<ConnectionStatus state={store.getSnapshot()} store={store} />);
    fireEvent.click(screen.getByText(/^操作結果/));
    const history = screen.getByRole('list', { name: '操作結果' });
    const entry = within(history).getByText(/重試已保存/);
    expect(entry.textContent).toContain('另開一個新的 session');
    expect(within(history).getByText(/錯誤代碼：runtime_unavailable/)).toBeTruthy();
  });
});

describe('T046: a session in error says so where messages are written', () => {
  function Harness({ store }: { store: RendererStore }) {
    const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
    const snapshot = state.snapshot!;
    const [view, setView] = useState(() => initialWorkspace(snapshot.sessions).views[0]!);
    return (
      <SessionWorkspace snapshot={snapshot} store={store} ipcState={state} agentOptions={snapshot.agents} view={view} active visible selection={undefined}
        onFocus={() => {}} onClose={() => {}} onOpen={() => {}} onAgent={() => {}} onModel={() => {}} onTransfer={() => {}} onProgress={() => {}} onNotice={() => {}}
        onContext={(patch) => setView((previous) => ({ ...previous, contexts: { ...previous.contexts, [previous.sessionId]: { ...contextFor(previous), ...patch } } }))} />
    );
  }
  const first = fixtureSnapshot.sessions[0]!;
  const renderWith = async (activity: typeof first.activity) => {
    const snapshot = { ...fixtureSnapshot, sessions: fixtureSnapshot.sessions.map((s) => (s.id === first.id ? { ...s, activity } : s)) };
    const store = createRendererStore(fakeBridge(snapshot).bridge);
    stores.push(store);
    await store.start();
    return render(<Harness store={store} />);
  };

  it('error: a plain note that new messages may not go and a new session goes on', async () => {
    const view = await renderWith('error');
    const note = view.container.querySelector('[data-session-error]');
    expect(note?.textContent).toContain('錯誤狀態');
    expect(note?.textContent).toContain('另開一個新的 session');
  });

  it('idle or closed: no such note', async () => {
    for (const activity of ['idle', 'closed'] as const) {
      const view = await renderWith(activity);
      expect(view.container.querySelector('[data-session-error]')).toBeNull();
      view.unmount();
    }
  });
});
