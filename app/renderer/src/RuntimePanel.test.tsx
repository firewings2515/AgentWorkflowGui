// @vitest-environment jsdom
import { useSyncExternalStore } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Command, RequestId } from '../../../contracts';
import type { RuntimeStatus, Snapshot } from '../../../contracts';
import { fixtureSnapshot } from '../../../contracts/fixtures/snapshot';
import { App } from './App';
import { createRendererStore } from './renderer-store';
import type { RendererStore } from './renderer-store';
import { fakeBridge } from './ipc-test-helpers';
import { RuntimeNotice } from './RuntimeNotice';
import { RuntimePanel } from './RuntimePanel';
import { SessionCreate } from './SessionCreate';

const stores: RendererStore[] = [];
afterEach(() => { cleanup(); stores.forEach(store => store.dispose()); stores.length = 0; });
function Harness({ store }: { store: RendererStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return <RuntimePanel snapshot={state.snapshot!} store={store} ipcState={state} />;
}
async function setup(snapshot: Snapshot = fixtureSnapshot) {
  const fake = fakeBridge(snapshot);
  const store = createRendererStore(fake.bridge, 15000);
  stores.push(store);
  await store.start();
  return { fake, store, ...render(<Harness store={store} />) };
}
const card = (name: string) => screen.getByRole('region', { name });

describe('T045 Runtime panel', () => {
  it('shows one card per runtime with the status, version, path, source, sign-in, models and time', async () => {
    await setup();
    const claude = within(card('Claude Code'));
    expect(claude.getByText('可用')).toBeTruthy();
    expect(claude.getByText('2.1.309')).toBeTruthy();
    expect(claude.getByText('需要 2.1.309 以上', { exact: false })).toBeTruthy();
    expect(claude.getByText('C:/Users/demo/.local/bin/claude.exe')).toBeTruthy();
    expect(claude.getByText('PATH')).toBeTruthy();
    expect(claude.getByText('訂閱')).toBeTruthy();
    expect(claude.getByText('3')).toBeTruthy();
    const codex = within(card('Codex'));
    expect(codex.getByText('版本太舊')).toBeTruthy();
    expect(codex.getByText('0.150.0')).toBeTruthy();
    expect(codex.getByRole('status').textContent).toContain('請更新 Codex');
    expect(claude.queryByRole('status')).toBeNull();
  });

  it('shows the category only: nothing like an account or a key is rendered', async () => {
    const status: RuntimeStatus = { ...fixtureSnapshot.runtimes[0]!, auth: 'api-key' };
    await setup({ ...fixtureSnapshot, runtimes: [status, fixtureSnapshot.runtimes[1]!] });
    expect(within(card('Claude Code')).getByText('API key')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/@|sk-/);
  });

  it.each([
    ['not-installed', '未安裝'], ['signed-out', '未登入'], ['failed', '讀不到版本'],
  ] as const)('shows the %s state and its explanation', async (state, label) => {
    const base = { runtime: 'claude' as const, requiredVersion: '2.1.309', modelCount: 0, checkedAt: '2026-11-01T10:00:00.000Z', detail: `說明 ${state}` };
    const status: RuntimeStatus = state === 'not-installed' ? { ...base, state, auth: 'unknown' }
      : state === 'signed-out' ? { ...base, state, auth: 'signed-out', executable: 'C:/c/claude.exe', source: 'path', version: '2.1.309' }
        : { ...base, state, auth: 'unknown', executable: 'C:/c/claude.exe', source: 'env' };
    await setup({ ...fixtureSnapshot, runtimes: [status] });
    const claude = within(card('Claude Code'));
    expect(card('Claude Code').querySelector('.runtime-state')?.textContent).toContain(label);
    expect(claude.getByRole('status').textContent).toBe(`說明 ${state}`);
    expect(within(card('Codex')).getByText('尚未偵測')).toBeTruthy();
  });

  it('"重新偵測" sends runtime.detect for that runtime only, and is disabled while it runs', async () => {
    const { fake } = await setup();
    let finish: () => void = () => undefined;
    fake.bridge.send.mockImplementation(command => new Promise(resolve => { finish = () => resolve({ ok: true, requestId: RequestId.parse(command.requestId), created: [] }); }));
    const button = within(card('Codex')).getByRole<HTMLButtonElement>('button', { name: '重新偵測 Codex' });
    fireEvent.click(button);
    await waitFor(() => expect(fake.bridge.send).toHaveBeenCalledTimes(1));
    const command = Command.parse(fake.bridge.send.mock.calls[0]![0]);
    expect(command).toMatchObject({ type: 'runtime.detect', runtime: 'codex' });
    expect(button.disabled).toBe(true);
    expect(within(card('Claude Code')).getByRole<HTMLButtonElement>('button', { name: '重新偵測 Claude Code' }).disabled).toBe(false);
    finish();
    await waitFor(() => expect(button.disabled).toBe(false));
  });

  it('says so when a re-detection fails', async () => {
    const { fake } = await setup();
    fake.bridge.send.mockImplementation(command => Promise.resolve({ ok: false, requestId: RequestId.parse(command.requestId), code: 'unsupported', message: 'x', retryable: false, mayHaveSideEffects: false }));
    fireEvent.click(within(card('Claude Code')).getByRole('button', { name: '重新偵測 Claude Code' }));
    expect((await screen.findByRole('alert')).textContent).toContain('unsupported');
  });

  it('demo mode (no service) disables the buttons and says why', () => {
    render(<RuntimePanel snapshot={fixtureSnapshot} store={undefined} ipcState={undefined} />);
    expect(screen.getByText(/示意模式/)).toBeTruthy();
    for (const button of screen.getAllByRole<HTMLButtonElement>('button')) expect(button.disabled).toBe(true);
  });
});

describe('T045 the dropdown notice', () => {
  it('names each unavailable runtime and its reason, and nothing when all are available', () => {
    render(<RuntimeNotice runtimes={fixtureSnapshot.runtimes} />);
    const notice = screen.getByRole('list', { name: '無法使用的 Runtime' });
    expect(notice.textContent).toContain('Codex 目前不可用');
    expect(notice.textContent).toContain('請更新 Codex');
    expect(notice.textContent).not.toContain('Claude Code');
    cleanup();
    const { container } = render(<RuntimeNotice runtimes={fixtureSnapshot.runtimes.map(r => ({ ...r, state: 'available' as const, version: '9.9.9', auth: 'unknown' as const }))} />);
    expect(container.textContent).toBe('');
  });

  it('shows next to the Model dropdown of the new-session form', async () => {
    const fake = fakeBridge(fixtureSnapshot);
    const store = createRendererStore(fake.bridge, 15000);
    stores.push(store);
    await store.start();
    function Form() {
      const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
      return <SessionCreate snapshot={state.snapshot!} store={store} ipcState={state} onOpen={() => undefined} draft={{ agentId: '', modelKey: '', cwd: '', parentId: '' }} onDraft={() => undefined} />;
    }
    render(<Form />);
    expect(screen.getByRole('list', { name: '無法使用的 Runtime' }).textContent).toContain('Codex');
  });
});

describe('T045 settings page', () => {
  it('is reachable from the navigation and shows the Runtime section', () => {
    window.location.hash = '#/settings';
    render(<App snapshot={fixtureSnapshot} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('設定');
    expect(screen.getByRole('heading', { name: 'Runtime', level: 2 })).toBeTruthy();
    expect(card('Claude Code')).toBeTruthy();
    window.location.hash = '';
  });
});
