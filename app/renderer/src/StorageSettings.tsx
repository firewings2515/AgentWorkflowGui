import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { RequestId, SupervisorSettings } from '../../../contracts';
import type { BackupInfo, Command, Snapshot } from '../../../contracts';
import type { RendererStore } from './renderer-store';
import { commandFeedback } from './command-feedback';
import { queryId } from './query-bridge';
import { FolderButton } from './FolderButton';
import { commandTarget } from './renderer-store';
import { readOnlyProps } from './read-only';

const readOnlyReasons = { 'disk-full': '磁碟空間不足', 'newer-schema': '資料由較新版本的應用程式建立', 'migration-failed': '資料升級失敗，已回復原有資料' };
const failureReasons = { 'backup-missing': '找不到備份', 'integrity-failed': '備份完整性檢查失敗', 'newer-schema': '備份版本比目前的應用程式新', 'io-failed': '讀寫資料失敗' };
const backupReasons = { daily: '每日自動備份', 'pre-migration': '資料升級前備份', 'pre-restore': '還原前備份' };
const date = (value: string) => new Date(value).toLocaleString('zh-TW', { hour12: false });

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current;
    if (element?.showModal) element.showModal(); else element?.setAttribute('open', '');
    element?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      element?.close?.();
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus();
        if (document.activeElement !== previous) previous.closest('dialog')?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
      }
    };
  }, []);
  return <dialog className="settings-dialog" ref={dialog} aria-label={title} onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
    if (event.key !== 'Tab') return;
    const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? []).filter(e => !e.closest('fieldset:disabled'));
    const first = elements[0]; const last = elements.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}><header><h2>{title}</h2><button onClick={onClose} aria-label={`關閉${title}`}>關閉</button></header>{children}</dialog>;
}

export function StorageBanner({ snapshot, onBackups, store }: { snapshot: Snapshot; onBackups: () => void; store?: RendererStore }) {
  const { app, storage } = snapshot;
  const [expanded, setExpanded] = useState(false);
  const [backup, setBackup] = useState<BackupInfo>();
  const pendingId = storage.pendingRestore?.backupId;
  useEffect(() => {
    let active = true;
    if (pendingId && store) void store.query({ type: 'backup.list', requestId: queryId() }).then(result => {
      if (active && result.ok && result.type === 'backup.list') setBackup(result.backups.find(b => b.id === pendingId));
    }, () => { if (active) setBackup(undefined); });
    return () => { active = false; };
  }, [pendingId, store]);
  if (app.status !== 'read-only' && !storage.pendingRestore && !storage.lastRestoreFailure) return null;
  const summary = [app.status === 'read-only' ? `唯讀模式：${readOnlyReasons[app.reason]}；寫入操作已停用` : '', storage.pendingRestore ? '待還原：下次啟動套用' : '', storage.lastRestoreFailure ? `上次還原失敗：${failureReasons[storage.lastRestoreFailure.reason]}` : ''].filter(Boolean).join(' · ');
  return <div className="storage-status">
    <aside className="storage-banner storage-summary" role={app.status === 'read-only' ? 'alert' : 'status'}>
      <span id="read-only-reason" title={summary}>{summary}</span>
      <button aria-expanded={expanded} aria-controls="storage-details" onClick={() => setExpanded(value => !value)}>{expanded ? '收合詳情' : '展開詳情'}</button>
      <button onClick={onBackups}>備份與還原</button>
    </aside>
    <div id="storage-details" className="storage-details" hidden={!expanded}>
      {app.status === 'read-only' && <p>可閱讀資料及安排還原。資料位置：<code>{app.location}</code> <FolderButton target={{ kind: 'app-data' }} /></p>}
      {storage.pendingRestore && <p>待還原：{storage.pendingRestore.backupId} · 備份時間：{backup && backup.id === pendingId ? date(backup.createdAt) : '尚未取得，請開啟備份與還原核對'}。下次啟動時套用，套用前會先備份現在的資料。</p>}
      {storage.lastRestoreFailure && <p>上次還原失敗：{failureReasons[storage.lastRestoreFailure.reason]}。目前資料已保留。</p>}
    </div>
  </div>;
}

/** Reconciliation stays inside the modal; re-reading never resends a command. */
function OutcomeCheck({ store, types }: { store: RendererStore; types: Command['type'][] }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const unresolved = Object.values(state.blockedCommands).filter(a => types.includes(a.command.type) && a.result && !a.result.ok);
  const signature = unresolved.map(a => a.command.requestId).join(',');
  const [checked, setChecked] = useState('');
  if (!unresolved.length) return null;
  return <section className="command-warning" aria-label="操作結果核對">
    <p>上次操作結果未明，可能已經生效。請重新讀取並核對目前狀態，再決定是否操作；不會自動重送。</p>
    <button disabled={state.connection === 'loading'} onClick={() => {
      setChecked('');
      void store.reconnect().then(() => { if (store.getSnapshot().connection === 'ready') setChecked(signature); });
    }}>重新讀取並核對</button>
    {state.connection === 'error' && <p role="alert">讀取失敗，請重試核對。</p>}
    {checked === signature && state.connection === 'ready' && <>
      <p role="status">目前狀態：{types.includes('preferences.set') ? `閒置 ${state.snapshot?.preferences.supervisor.idleCloseMinutes} 分鐘，程序上限 ${state.snapshot?.preferences.supervisor.maxOpenRuntimes}` : state.snapshot?.storage.pendingRestore ? `待還原 ${state.snapshot.storage.pendingRestore.backupId}` : '沒有待還原'}</p>
      <button onClick={() => unresolved.forEach(a => store.acknowledge(a.command.type, commandTarget(a.command)))}>已核對結果，允許再次操作</button>
    </>}
  </section>;
}

/** Backup and restore, a section of the settings page (Q-13; it was a dialog of the old app menu). */
export function BackupSection({ store, demo }: { store: RendererStore; demo: boolean }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<BackupInfo | null>(null);
  const [feedback, setFeedback] = useState('');
  const storage = state.snapshot?.storage;
  useEffect(() => {
    let active = true;
    void store.query({ type: 'backup.list', requestId: queryId() }).then(result => {
      if (active && result.ok && result.type === 'backup.list') { setBackups(result.backups); setError(''); }
    }, (error: unknown) => { if (active) setError(error instanceof Error ? error.message : '讀取備份失敗。'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [store, revision, storage?.lastBackupAt]);
  const blocked = state.connection !== 'ready' || state.snapshot?.app.status === 'damaged' || store.isBlocked('backup.restore', 'storage') || store.isBlocked('backup.cancelRestore', 'storage');
  return <section className="v4-card" id="settings-backups" aria-labelledby="settings-backups-heading"><h2 id="settings-backups-heading" tabIndex={-1}>備份與還原</h2>
    {demo && <p className="demo-badge">示意模式：僅變更示意資料，不會還原磁碟上的資料。</p>}
    <p>每天首次啟動自動備份，保留 30 天；資料升級前也會先備份。僅備份本應用程式資料，不包含工具登入憑證或工具自己的資料目錄。</p>
    {storage?.pendingRestore && <section role="status"><p>待還原：{storage.pendingRestore.backupId} · 備份時間：{backups.some(b => b.id === storage.pendingRestore?.backupId) ? date(backups.find(b => b.id === storage.pendingRestore?.backupId)!.createdAt) : '尚未取得或備份已不在清單中'}。下次啟動時套用，套用前會先備份現在的資料。</p><button disabled={blocked} onClick={() => {
      void store.send({ type: 'backup.cancelRestore', requestId: queryId() }).then(result => setFeedback(result.ok ? '取消還原已接受，等待資料狀態更新。' : commandFeedback(result)));
    }}>取消待還原</button></section>}
    {storage?.lastRestoreFailure && <p role="alert">上次還原失敗（{date(storage.lastRestoreFailure.at)}）：{failureReasons[storage.lastRestoreFailure.reason]}。目前資料已保留。</p>}
    {loading && <p role="status">正在讀取備份…</p>}
    {error && <p role="alert">{error} <button onClick={() => { setLoading(true); setRevision(value => value + 1); }}>重試</button></p>}
    {!loading && !error && !backups.length && <p>尚無可用備份。</p>}
    <ul className="backup-list">{backups.map(backup => <li key={backup.id}><div><time dateTime={backup.createdAt}>{date(backup.createdAt)}</time><p>{backupReasons[backup.reason]} · {(backup.sizeBytes / 1024 / 1024).toLocaleString('zh-TW', { maximumFractionDigits: 2 })} MiB（{backup.sizeBytes.toLocaleString()} bytes）</p><small>資料版本 {backup.storageVersion}</small></div><button disabled={blocked || !!storage?.pendingRestore} onClick={() => setSelected(backup)} aria-label={`還原 ${date(backup.createdAt)}`}>還原</button></li>)}</ul>
    {feedback && <p role="status">{feedback}</p>}
    <OutcomeCheck store={store} types={['backup.restore', 'backup.cancelRestore']} />
    {selected && <Modal title="確認還原" onClose={() => setSelected(null)}><p>還原 {date(selected.createdAt)} 的「{backupReasons[selected.reason]}」。</p><p>下次啟動時套用，套用前會先備份現在的資料。備份檢查失敗時會保留目前資料。</p><button disabled={blocked || !!storage?.pendingRestore || !backups.some(b => b.id === selected.id)} onClick={() => {
      void store.send({ type: 'backup.restore', requestId: queryId(), backupId: selected.id }).then(result => { setFeedback(result.ok ? '還原已接受，等待資料狀態更新；下次啟動時套用。' : commandFeedback(result)); setSelected(null); });
    }}>確認下次啟動還原</button></Modal>}
  </section>;
}

/** How long idle runtimes stay open and how many may be open (the old app menu's 設定 dialog, now a settings section). */
export function SupervisorSection({ store, demo }: { store: RendererStore; demo: boolean }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const preferences = state.snapshot?.preferences;
  const [idle, setIdle] = useState(String(preferences?.supervisor.idleCloseMinutes ?? 15));
  const [limit, setLimit] = useState(String(preferences?.supervisor.maxOpenRuntimes ?? 6));
  const [feedback, setFeedback] = useState('');
  const parsed = SupervisorSettings.safeParse({ idleCloseMinutes: Number(idle), maxOpenRuntimes: Number(limit) });
  const disabled = state.connection !== 'ready' || state.snapshot?.app.status !== 'ready' || store.isBlocked('preferences.set', 'preferences');
  return <section className="v4-card" aria-labelledby="settings-supervisor-heading"><h2 id="settings-supervisor-heading">Runtime 程序</h2><p>閒置程序釋放後，會在需要時恢復；超過上限時先釋放最久未使用的閒置程序。</p>{demo && <p>示意模式：設定僅保留在這次預覽。</p>}
    {state.snapshot?.app.status === 'read-only' && <p>唯讀模式，設定無法儲存。</p>}
    {store.savingPreferences() && <p role="status">正在儲存設定，完成後就能再改。</p>}
    <form onSubmit={event => {
      event.preventDefault(); if (disabled || !parsed.success) return;
      const latest = store.getSnapshot().snapshot?.preferences;
      if (!latest) return;
      void store.send({ type: 'preferences.set', requestId: RequestId.parse(crypto.randomUUID()), preferences: { ...latest, supervisor: parsed.data } }).then(result => setFeedback(result.ok ? '設定已接受。' : commandFeedback(result)));
    }}><label>閒置分鐘數（1～1440）<input type="number" min={1} max={1440} step={1} required value={idle} onChange={e => setIdle(e.target.value)} /></label>
      <label>程序上限（1～32）<input type="number" min={1} max={32} step={1} required value={limit} onChange={e => setLimit(e.target.value)} /></label>
      {!parsed.success && <p role="alert">請輸入範圍內的整數。</p>}<button {...readOnlyProps(state.snapshot?.app.status === 'read-only')} type="submit" disabled={disabled || !parsed.success}>儲存設定</button></form>
    {feedback && <p role="status">{feedback}</p>}
    <OutcomeCheck store={store} types={['preferences.set']} />
  </section>;
}
