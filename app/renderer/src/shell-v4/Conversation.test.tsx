// @vitest-environment jsdom
// T051: the old SessionWorkspace tests (T040 long conversations, history pages, release causes) on the v0.4 conversation pane.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { fixtureSnapshot } from '../../../../contracts/fixtures/snapshot';
import type { QueryResult } from '../../../../contracts';
import { createRendererStore } from '../renderer-store';
import type { RendererStore } from '../renderer-store';
import { createStorageDemo } from '../query-bridge';
import { deferred, fakeBridge } from '../ipc-test-helpers';
import { transcriptGeometry } from '../transcript-test-geometry';
import { performanceSnapshot } from '../performance-demo';
import { ConversationHarness } from './conversation-test-harness';

const stores: RendererStore[] = [];
afterEach(() => { cleanup(); stores.forEach(store => store.dispose()); stores.length = 0; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const Harness = ({ store }: { store: RendererStore }) => <ConversationHarness store={store} />;
it('opens the full 2000-turn workspace at the latest message and restores context after a session switch', async () => {
  transcriptGeometry();
  const snapshot = performanceSnapshot();
  const store = createRendererStore(fakeBridge(snapshot).bridge); stores.push(store); await store.start();
  const view = render(<Harness store={store} />);
  const last = snapshot.messages.at(-1)!;
  expect(view.container.querySelector(`[data-message-id="${last.id}"]`)).not.toBeNull();
  const transcript = screen.getByRole<HTMLElement>('region', { name: /對話內容$/ });
  expect(transcript.scrollTop).toBe(transcript.scrollHeight - transcript.clientHeight);
  fireEvent.scroll(transcript, { target: { scrollTop: 16000 } });
  const saved = screen.getByTestId('reading').textContent;
  fireEvent.click(screen.getByRole('button', { name: '切換測試 session' }));
  fireEvent.click(screen.getByRole('button', { name: '切換測試 session' }));
  expect(screen.getByTestId('reading').textContent).toBe(saved);
  expect(view.container.querySelectorAll('[data-message-id]').length).toBeLessThan(30);
});
it('loads history by button or top scroll, shows loading, retries failures, then reaches earliest', async () => {
  transcriptGeometry();
  const bridge = createStorageDemo(fixtureSnapshot);
  const pending = deferred<QueryResult>();
  const query = vi.spyOn(bridge, 'query').mockImplementationOnce(() => pending.promise);
  const store = createRendererStore(bridge); stores.push(store); await store.start();
  render(<Harness store={store} />);
  const transcript = screen.getByRole('region', { name: /對話內容$/ });
  fireEvent.click(screen.getByRole('button', { name: '載入更早的對話' }));
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '正在載入更早的對話…' }).disabled).toBe(true);
  await act(async () => { pending.reject(new Error('歷史讀取失敗')); await Promise.resolve(); });
  expect(screen.getByRole('alert').textContent).toContain('歷史讀取失敗');
  fireEvent.click(screen.getByRole('button', { name: '重試' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: '載入更早的對話' }).disabled).toBe(false));
  fireEvent.scroll(transcript, { target: { scrollTop: 0 } });
  await waitFor(() => expect(query).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: '載入更早的對話' }).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '載入更早的對話' }));
  await screen.findByText('已到最早');
  fireEvent.scroll(transcript, { target: { scrollTop: 0 } });
  expect(query).toHaveBeenCalledTimes(4);
});

it.each([['idle', '閒置自動釋放'], ['process-limit', '超過程序上限而釋放']] as const)('shows release cause %s from the event', async (cause, label) => {
  transcriptGeometry();
  const fake = fakeBridge(); const store = createRendererStore(fake.bridge); stores.push(store); await store.start();
  render(<Harness store={store} />);
  act(() => fake.emit({ schemaVersion: fixtureSnapshot.schemaVersion, seq: fixtureSnapshot.seq + 1, event: { type: 'session.activity', sessionId: fixtureSnapshot.sessions[0]!.id, activity: 'closed', cause, at: fixtureSnapshot.messages[0]!.createdAt } }));
  expect(screen.getByText(label)).toBeTruthy();
});
