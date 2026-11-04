// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureBackupList, fixtureReadOnlySnapshot, fixtureSnapshot } from '../../../contracts/fixtures/snapshot';
import { App } from './App';
import { BackupSection, SupervisorSection, StorageBanner } from './StorageSettings';
import { createRendererStore } from './renderer-store';
import { createStorageDemo } from './query-bridge';
import { fakeBridge } from './ipc-test-helpers';
import { unknownResult } from './command-feedback';
import { THEME_KEY } from './theme';
import { RequestId } from '../../../contracts';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete window.awg; localStorage.clear(); window.history.replaceState(null, '', '/'); });

describe('T041 backup, settings and read-only UI', () => {
  it('requires explicit restore confirmation, permits read-only cancellation, and displays failures as text', async () => {
    const bridge = createStorageDemo({ ...fixtureReadOnlySnapshot, storage: {} });
    const send = vi.spyOn(bridge, 'send');
    const store = createRendererStore(bridge); await store.start();
    render(<BackupSection store={store} demo />);
    const restore = (await screen.findAllByRole('button', { name: /^還原 / }))[0]!;
    restore.focus(); fireEvent.click(restore);
    expect(send).not.toHaveBeenCalled();
    const confirm = screen.getByRole('dialog', { name: '確認還原' });
    expect(within(confirm).getByText(/下次啟動時套用，套用前會先備份現在的資料/)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: '關閉確認還原' }));
    expect(document.activeElement).toBe(restore);
    fireEvent.click(restore);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '確認下次啟動還原' })); await Promise.resolve(); });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].type).toBe('backup.restore');
    expect(screen.getByRole('button', { name: '取消待還原' })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '取消待還原' })); await Promise.resolve(); });
    expect(store.getSnapshot().snapshot?.storage.pendingRestore).toBeUndefined();
    store.dispose();
    cleanup();
    render(<StorageBanner snapshot={{ ...fixtureSnapshot, storage: { lastRestoreFailure: { backupId: fixtureReadOnlySnapshot.storage.pendingRestore!.backupId, reason: 'integrity-failed', at: fixtureSnapshot.messages[0]!.createdAt } } }} onBackups={() => {}} />);
    expect(screen.getByRole('status').textContent).toContain('備份完整性檢查失敗');
  });
  it('validates integer bounds and saves supervisor without overwriting theme', async () => {
    const bridge = createStorageDemo({ ...fixtureSnapshot, preferences: { ...fixtureSnapshot.preferences, theme: 'light' } });
    const send = vi.spyOn(bridge, 'send'); const store = createRendererStore(bridge); await store.start();
    render(<SupervisorSection store={store} demo />);
    const idle = screen.getByRole('spinbutton', { name: /閒置分鐘數/ });
    const limit = screen.getByRole('spinbutton', { name: /程序上限/ });
    for (const value of ['', '0', '1441', '1.5']) {
      fireEvent.change(idle, { target: { value } });
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '儲存設定' }).disabled).toBe(true);
    }
    fireEvent.change(idle, { target: { value: '1440' } });
    fireEvent.change(limit, { target: { value: '33' } });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '儲存設定' }).disabled).toBe(true);
    fireEvent.change(limit, { target: { value: '32' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '儲存設定' })); await Promise.resolve(); });
    expect(send.mock.calls[0]?.[0]).toMatchObject({ type: 'preferences.set', preferences: { theme: 'light', supervisor: { idleCloseMinutes: 1440, maxOpenRuntimes: 32 } } });
    store.dispose();
  });
  it('keeps readonly data browsable, disables writes, and reaches settings and backups from the banner (T051: was the app menu)', async () => {
    window.history.replaceState(null, '', '/#/sessions/s-plan-notes');
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    render(<App snapshot={fixtureReadOnlySnapshot} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('磁碟空間不足'));
    expect(screen.getByText(fixtureReadOnlySnapshot.app.status === 'read-only' ? fixtureReadOnlySnapshot.app.location : '')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '送出' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /^Model：/ }));
    for (const item of screen.getAllByRole<HTMLButtonElement>('menuitemradio')) expect(item.disabled).toBe(true);
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: '備份與還原' }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('設定');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '儲存設定' }).disabled).toBe(true);
    await screen.findByRole('button', { name: '取消待還原' });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '取消待還原' }).disabled).toBe(false);
  });
  it('keeps read-only themes local and exposes one collapsed banner with backup time', async () => {
    const fake = fakeBridge(fixtureReadOnlySnapshot);
    const demo = createStorageDemo(fixtureReadOnlySnapshot);
    window.awg = { ...fake.bridge, ...{ query: demo.query } };
    window.history.replaceState(null, '', '/#/sessions/s-plan-notes');
    render(<App />);
    await screen.findByRole('button', { name: '送出' });
    fireEvent.click(screen.getByRole('button', { name: '切換成淺色' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem(THEME_KEY)).toBe('light');
    expect(fake.bridge.send).not.toHaveBeenCalled();
    for (const button of [screen.getByRole<HTMLButtonElement>('button', { name: '送出' }), document.querySelector<HTMLButtonElement>('.v4-title')!]) {
      expect(button.getAttribute('aria-describedby')).toBe('read-only-reason');
      expect(button.title).toContain('唯讀');
    }
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '送出' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '設定' }));
    fireEvent.click(screen.getByRole('radio', { name: '深色' }));
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
    expect(fake.bridge.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^Workflow/ }));
    fireEvent.click(screen.getByRole('button', { name: '開始 Workflow' }));
    const start = screen.getByRole<HTMLButtonElement>('button', { name: '開始' });
    expect(start.disabled).toBe(true);
    expect(start.title).toContain('唯讀');
    fireEvent.click(screen.getByRole('button', { name: /^對話/ }));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '送出' }).title).toContain('唯讀');
    expect(document.querySelectorAll('.storage-summary')).toHaveLength(1);
    expect(document.getElementById('storage-details')!.hidden).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '展開詳情' }));
    if (!fixtureBackupList.ok || fixtureBackupList.type !== 'backup.list') throw new Error('wrong fixture');
    const backup = fixtureBackupList.backups.find(b => b.id === fixtureReadOnlySnapshot.storage.pendingRestore!.backupId)!;
    await waitFor(() => expect(document.getElementById('storage-details')!.textContent).toContain(new Date(backup.createdAt).toLocaleString('zh-TW', { hour12: false })));
  });
  it.each([false, true])('disables read-only send even with a nonempty draft (connected bridge: %s)', async connected => {
    const fake = fakeBridge(fixtureReadOnlySnapshot);
    if (connected) window.awg = fake.bridge;
    window.history.replaceState(null, '', '/#/sessions/s-plan-notes');
    // Snapshot mode isolates the UI guard from the store's independent guard.
    render(connected ? <App /> : <App snapshot={fixtureReadOnlySnapshot} />);
    const send = await screen.findByRole<HTMLButtonElement>('button', { name: '送出' });
    const draft = screen.getByRole<HTMLTextAreaElement>('textbox', { name: /^回覆 / });
    fireEvent.change(draft, { target: { value: '唯讀模式仍可保留草稿' } });
    expect(draft.value).toBe('唯讀模式仍可保留草稿');
    expect(send.disabled).toBe(true);
    fireEvent.click(send);
    expect(fake.bridge.send).not.toHaveBeenCalled();
  });
  it.each(['backup.restore', 'backup.cancelRestore', 'preferences.set'] as const)('reconciles %s inside the modal without replaying the command', async type => {
    const initial = type === 'backup.cancelRestore' ? fixtureReadOnlySnapshot : { ...fixtureSnapshot, storage: {} };
    const bridge = createStorageDemo(initial);
    const send = vi.spyOn(bridge, 'send').mockImplementation(command => Promise.resolve(unknownResult(RequestId.parse(command.requestId))));
    const store = createRendererStore(bridge); await store.start();
    render(type === 'preferences.set' ? <SupervisorSection store={store} demo={false} /> : <BackupSection store={store} demo={false} />);
    if (type === 'backup.restore') {
      fireEvent.click((await screen.findAllByRole('button', { name: /^還原 / }))[0]!);
      fireEvent.click(screen.getByRole('button', { name: '確認下次啟動還原' }));
    } else fireEvent.click(await screen.findByRole('button', { name: type === 'preferences.set' ? '儲存設定' : '取消待還原' }));
    await screen.findByText(/上次操作結果未明/);
    expect(screen.queryByRole('button', { name: '已核對結果，允許再次操作' })).toBeNull();
    vi.spyOn(bridge, 'snapshot').mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(screen.getByRole('button', { name: '重新讀取並核對' }));
    await screen.findByText('讀取失敗，請重試核對。');
    expect(screen.queryByRole('button', { name: '已核對結果，允許再次操作' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重新讀取並核對' }));
    fireEvent.click(await screen.findByRole('button', { name: '已核對結果，允許再次操作' }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.isBlocked(type, type === 'preferences.set' ? 'preferences' : 'storage')).toBe(false);
    store.dispose();
  });
});
