// The v0.4 shell (REVISION_V0_4 §3, U2_PLAN §3 T051): a simple, Claude-like layout for the connected app and the demo.
// Connected: `store` is the IPC renderer store and every control sends a real command. Demo: `store` is undefined,
// `serviceStore` serves fixture data (history pages, preferences, backups) and controls say what they would send.
import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import type { LogicalSession, ModelOption, SessionId, Snapshot } from '../../../../contracts';
import { AgentId, MessageId, PINNED_LIMIT, pinnedOf, RequestId } from '../../../../contracts';
import { AgentCatalog } from '../AgentCatalog';
import { createAgentDemo } from '../agent-demo';
import { createIpcAgentRepository } from '../agent-repository';
import { commandFeedback } from '../command-feedback';
import { useEscalationNotice } from '../escalation-notify';
import { FolderButton } from '../FolderButton';
import type { RendererState, RendererStore } from '../renderer-store';
import { sessionBlocksSend } from '../renderer-store';
import { StorageBanner } from '../StorageSettings';
import { readOnlyProps } from '../read-only';
import { readTheme, THEME_KEY } from '../theme';
import type { Theme } from '../theme';
import { TransferDialog } from '../TransferDialog';
import type { TransferPreview } from '../TransferDialog';
import { WorkflowEditor } from '../WorkflowEditor';
import { createWorkflowDemo } from '../workflow-demo';
import { createIpcWorkflowRepository } from '../workflow-repository';
import { WorkflowProgress } from '../WorkflowProgress';
import { WorkflowStart } from '../WorkflowStart';
import { defaultModelKey, modelKey } from './Composer';
import type { ComposerChoice } from './Composer';
import { Conversation } from './Conversation';
import { useCreateFlow } from './create-flow';
import type { SidebarMode, V4Page } from './demo-data';
import { recentFolders, requestFolder } from './folders';
import { NewChat, SettingsV4 } from './Pages';
import { initialPanes, openTarget, paneReducer } from './pane-state';
import { modeOf, Sidebar } from './Sidebar';
import '../styles.css';
import './styles.css';

export const APP_NAME = 'AgentWorkflowGui';
export const SAVING_PREFERENCES = '正在儲存設定，完成後就能再改。';

// Below this width the sidebar collapses by itself and opens as an overlay.
const narrowQuery = '(max-width: 900px)';
const isNarrow = () => window.matchMedia?.(narrowQuery).matches ?? false;
const subscribeWidth = (onChange: () => void) => {
  const query = window.matchMedia?.(narrowQuery);
  query?.addEventListener('change', onChange);
  return () => query?.removeEventListener('change', onChange);
};
// Pages that belong to one sidebar mode; going there switches the sidebar too. Settings keeps the current mode.
const pageModes: Partial<Record<V4Page, SidebarMode>> = { new: 'chat', 'workflow-start': 'workflow', agents: 'workflow', templates: 'workflow', progress: 'workflow' };

/** Hash routes keep pages addressable under Electron's file:// URL (and the Agent／template selection in the URL). */
export interface Route { page: V4Page | 'missing'; id: string; path: string }
const decode = (value: string | undefined) => { try { return decodeURIComponent(value ?? ''); } catch { return value ?? ''; } };
export function parseRoute(hash: string): Route {
  const path = (hash.replace(/^#/, '').split('?')[0] ?? '') || '/new';
  let match: RegExpExecArray | null;
  if (path === '/new' || path === '/workbench') return { page: 'new', id: '', path };
  if ((match = /^\/sessions\/([^/]+)$/.exec(path))) return { page: 'chat', id: decode(match[1]), path };
  if (path === '/settings') return { page: 'settings', id: '', path };
  if (path === '/workflows/start') return { page: 'workflow-start', id: '', path };
  if ((match = /^\/workflows\/([^/]+)\/edit$/.exec(path))) return { page: 'templates', id: decode(match[1]), path };
  if ((match = /^\/agents(?:\/([^/]+))?$/.exec(path))) return { page: 'agents', id: decode(match[1]), path };
  if ((match = /^\/workflow-instances\/([^/]+)$/.exec(path))) return { page: 'progress', id: decode(match[1]), path };
  return { page: 'missing', id: '', path };
}
const routePath = (page: V4Page, id = '') => ({
  new: '/new', chat: `/sessions/${encodeURIComponent(id)}`, settings: '/settings', 'workflow-start': '/workflows/start',
  templates: `/workflows/${encodeURIComponent(id || 'unavailable')}/edit`, agents: id ? `/agents/${encodeURIComponent(id)}` : '/agents',
  progress: `/workflow-instances/${encodeURIComponent(id)}`,
})[page];
const currentRoute = () => parseRoute(window.location.hash);
const keyCodes: Record<string, string> = { n: 'KeyN', f5: 'F5' };
const newId = () => RequestId.parse(crypto.randomUUID());

export interface ShellProps { snapshot: Snapshot; store?: RendererStore | undefined; serviceStore: RendererStore; ipcState?: RendererState | undefined }

export function ShellV4({ snapshot, store, serviceStore, ipcState }: ShellProps) {
  const [route, setRoute] = useState(currentRoute);
  const known = (id: string) => snapshot.sessions.some(session => session.id === id);
  const [panes, dispatch] = useReducer(paneReducer, route, start => initialPanes(start.page === 'chat' && known(start.id) ? start.id as SessionId : undefined));
  const [mode, setMode] = useState<SidebarMode>(() => route.page === 'chat' && known(route.id) ? modeOf(snapshot, route.id) : route.page !== 'missing' ? pageModes[route.page] ?? 'chat' : 'chat');
  const [demoTheme, setDemoTheme] = useState<Theme>();
  const narrow = useSyncExternalStore(subscribeWidth, isNarrow);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [narrowOpen, setNarrowOpen] = useState(false);
  // Demo only: renames and pins stay in this preview.
  const [titles, setTitles] = useState<Record<string, string>>({});
  // Demo only: Agent／Model choices of existing sessions (connected: those are commands).
  const [choices, setChoices] = useState<Record<string, ComposerChoice>>({});
  const [newDraft, setNewDraft] = useState('');
  const [newChoice, setNewChoice] = useState<ComposerChoice>(() => ({ folder: { kind: 'auto' }, agentId: '', modelKey: defaultModelKey(snapshot.modelOptions) }));
  const [editTitle, setEditTitle] = useState<{ sessionId: string; nonce: number }>({ sessionId: '', nonce: 0 });
  const [firstNotSent, setFirstNotSent] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState('');
  const [transfer, setTransfer] = useState<TransferPreview | null>(null);
  const progressFrom = useRef<string | undefined>(undefined);
  const [{ repository: workflowRepository, controls: workflowDemo }] = useState(() => store
    ? { repository: createIpcWorkflowRepository(store), controls: undefined } : createWorkflowDemo(snapshot.workflows));
  const [{ repository: agentRepository, controls: agentDemo }] = useState(() => store
    ? { repository: createIpcAgentRepository(store), controls: undefined }
    : createAgentDemo(snapshot.agents, id => snapshot.sessions.some(session => session.agent?.id === id) || workflowRepository.getSnapshot().some(workflow => workflow.nodes.some(node => node.kind === 'agent' && node.agentId === id))));
  const agents = useSyncExternalStore(agentRepository.subscribe, agentRepository.getSnapshot);

  const readOnly = snapshot.app.status === 'read-only';
  const damaged = snapshot.app.status === 'damaged';
  const theme = store && !readOnly ? snapshot.preferences.theme : demoTheme ?? readTheme(snapshot.preferences.theme);
  const commandDisabled = snapshot.app.status !== 'ready' || (!!store && ipcState?.connection !== 'ready');
  const themeDisabled = !readOnly && (commandDisabled || !!store?.isBlocked('preferences.set', 'preferences'));
  const collapsed = narrow ? !narrowOpen : !sidebarOpen;
  const active = panes.panes.find(pane => pane.id === panes.active) ?? panes.panes[0];
  const page: V4Page | 'missing' = route.page === 'chat' && !known(route.id) ? 'missing' : route.page;
  // Discard the preview as soon as damaged data is observed, before recovery can render it again.
  if (damaged && transfer) setTransfer(null);

  const navigate = useCallback((path: string, replace = false) => {
    if (replace) window.history.replaceState(null, '', `#${path}`); else window.history.pushState(null, '', `#${path}`);
    setRoute(parseRoute(path));
  }, []);
  const go = (next: V4Page, id = '') => {
    navigate(routePath(next, id));
    const nextMode = pageModes[next];
    if (nextMode) setMode(nextMode);
    if (narrow) setNarrowOpen(false);
  };
  const open = (sessionId: SessionId, paneId?: string, draft?: string) => {
    if (!known(sessionId)) { setNotice(`找不到 session：${sessionId}`); return; }
    dispatch({ type: 'open', sessionId, ...(paneId ? { paneId } : {}), ...(draft !== undefined ? { draft } : {}) });
    // Opening a node session from anywhere (split view, search, a link) shows it in Workflow mode, under its run.
    setMode(modeOf(snapshot, sessionId));
    navigate(routePath('chat', sessionId));
    if (narrow) setNarrowOpen(false);
  };
  const split = (sessionId: SessionId) => {
    if (!known(sessionId)) return;
    dispatch({ type: 'split', sessionId });
    setMode(modeOf(snapshot, sessionId));
    navigate(routePath('chat', sessionId));
  };
  const closePane = (paneId: string) => {
    const remaining = panes.panes.filter(pane => pane.id !== paneId);
    dispatch({ type: 'close', paneId });
    const next = remaining.find(pane => pane.id === panes.active) ?? remaining[0];
    if (next) {
      navigate(routePath('chat', next.sessionId), true);
      // The close button goes with its pane (r1 P2): keyboard focus moves to the remaining conversation's input.
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-pane="${next.id}"] .v4-composer textarea`)?.focus());
    } else go('new');
  };

  // A route changed outside the app (back／forward, a typed address) opens its session in the active pane.
  const onRoute = useRef<(next: Route) => void>(() => undefined);
  useEffect(() => {
    onRoute.current = next => {
      if (next.page !== 'chat' || !known(next.id)) return;
      if (active?.sessionId !== next.id) dispatch({ type: 'open', sessionId: next.id as SessionId });
      setMode(modeOf(snapshot, next.id));
    };
  });
  useEffect(() => {
    const sync = () => { const next = currentRoute(); setRoute(next); onRoute.current(next); };
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => { window.removeEventListener('hashchange', sync); window.removeEventListener('popstate', sync); };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* The in-memory choice still works. */ }
  }, [theme]);
  // The new-chat page focuses its input instead; a conversation keeps focus where the user clicked.
  useEffect(() => {
    const heading = page === 'settings' ? 'v4-settings-heading' : page === 'workflow-start' ? 'v4-start-heading' : page === 'missing' ? 'v4-missing-heading' : '';
    if (heading) document.getElementById(heading)?.focus({ preventScroll: true });
  }, [page]);

  // T055: a clicked notification opens the session that raised the escalation (an open pane is just selected) and scrolls to its card.
  const openEscalation = useRef<(sessionId: SessionId, escalationId: string) => void>(() => undefined);
  const scrollFrame = useRef<number | undefined>(undefined);
  useEffect(() => { openEscalation.current = (sessionId, escalationId) => {
    open(sessionId);
    // A newer click replaces the search of an older one; leaving the shell ends it (r1 P2-2).
    if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current);
    let tries = 0;
    const scroll = () => {
      scrollFrame.current = undefined;
      const card = Array.from(document.querySelectorAll<HTMLElement>('[data-escalation-id]')).find(item => item.dataset['escalationId'] === escalationId);
      if (card) card.scrollIntoView?.({ block: 'center' });
      else if (++tries < 30) scrollFrame.current = requestAnimationFrame(scroll);
    };
    scrollFrame.current = requestAnimationFrame(scroll);
  }; });
  useEffect(() => () => { if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current); scrollFrame.current = undefined; }, []);
  useEscalationNotice(store, (sessionId, escalationId) => openEscalation.current(sessionId, escalationId));

  const reload = () => { if (store && ipcState?.connection !== 'loading') void store.reconnect(); };
  // U2_PLAN §3-10: Ctrl+N (in Workflow mode: start a Workflow), Ctrl+Shift+N, F5. Physical key codes keep them working
  // with a non-Latin layout; IME composition, key repeat and an open dialog never trigger them (T027).
  const shortcut = useRef<(event: KeyboardEvent) => void>(() => undefined);
  useEffect(() => { shortcut.current = event => {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.metaKey) return;
    const code = event.code || keyCodes[event.key.toLowerCase()];
    const action = event.ctrlKey && code === 'KeyN' ? (event.shiftKey || mode === 'workflow' ? 'workflow' : 'new')
      : !event.ctrlKey && !event.shiftKey && code === 'F5' ? 'reload' : undefined;
    if (!action) return;
    event.preventDefault();
    if (event.repeat || document.querySelector('dialog[open]')) return;
    if (action === 'reload') reload();
    else if (!damaged) go(action === 'new' ? 'new' : 'workflow-start');
  }; });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => shortcut.current(event);
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  /** Sends with the revision of the latest Snapshot at the moment of sending, never the one rendered earlier. */
  const sendTo = (sessionId: SessionId, text: string) => {
    if (!store) return;
    const current = store.getSnapshot().snapshot;
    const latest = current?.sessions.find(session => session.id === sessionId);
    if (!current || !latest || sessionBlocksSend(current, sessionId)) return;
    void store.send({ type: 'session.send', requestId: newId(), sessionId, messageId: MessageId.parse(crypto.randomUUID()), expectedRevision: latest.revision, text, attachments: [] }).then(result => {
      if (!result.ok) return;
      dispatch({ type: 'sent', sessionId, text });
      setFirstNotSent(previous => { if (!previous.has(sessionId)) return previous; const next = new Set(previous); next.delete(sessionId); return next; });
    });
  };
  const flow = useCreateFlow({ snapshot, store, ipcState, onOpened: (sessionId, text, send) => {
    const draft = text || newDraft;
    const paneId = openTarget(panes, sessionId);
    // A draft the user already typed in that session (opened from the sidebar while creating) is kept.
    const typed = panes.panes.find(pane => pane.id === paneId)?.contexts[sessionId]?.draft;
    open(sessionId, paneId, typed ? undefined : draft);
    setNewDraft(previous => previous === draft ? '' : previous);
    if (send) sendTo(sessionId, draft);
    else setFirstNotSent(previous => new Set(previous).add(sessionId));
  } });
  const pickNewFolder = () => { void requestFolder().then(outcome => {
    if (outcome.kind === 'picked') setNewChoice(previous => ({ ...previous, folder: { kind: 'picked', path: outcome.path } }));
    else if (outcome.kind === 'failed') setNotice(outcome.message);
  }); };

  const latestRevision = (sessionId: SessionId) => store?.getSnapshot().snapshot?.sessions.find(session => session.id === sessionId)?.revision;
  const choiceFor = (session: LogicalSession): ComposerChoice => choices[session.id]
    ?? { folder: { kind: 'picked', path: session.cwd }, agentId: session.agent?.id ?? '', modelKey: modelKey(session.requestedModel) };
  const changeChoice = (session: LogicalSession, paneId: string, next: ComposerChoice) => {
    const previous = choiceFor(session);
    if (next.agentId !== previous.agentId && session.kind === 'ordinary') {
      const revision = latestRevision(session.id);
      if (store && revision !== undefined) void store.send({ type: 'session.setAgent', requestId: newId(), sessionId: session.id, expectedRevision: revision, agentId: next.agentId ? AgentId.parse(next.agentId) : null });
      else if (!store) setChoices(all => ({ ...all, [session.id]: { ...previous, agentId: next.agentId } }));
    }
    if (next.modelKey !== previous.modelKey) {
      const model: ModelOption | undefined = snapshot.modelOptions.find(item => modelKey(item) === next.modelKey);
      if (!model) return;
      if (model.runtime !== session.requestedModel.runtime) {
        // Another tool is a transfer (R-02, R-12); a workflow node cannot change tools.
        if (session.kind === 'ordinary') setTransfer({ sessionId: session.id, model, viewId: paneId });
        else setNotice('workflow 的 node 不能換工具。');
        return;
      }
      const selection = { runtime: model.runtime, model: model.model, ...(model.defaultEffort ? { effort: model.defaultEffort } : {}) };
      const revision = latestRevision(session.id);
      if (store && revision !== undefined) void store.send({ type: 'session.setModel', requestId: newId(), sessionId: session.id, expectedRevision: revision, model: selection });
      else if (!store) setChoices(all => ({ ...all, [session.id]: { ...(all[session.id] ?? previous), modelKey: next.modelKey } }));
    }
  };
  const renameSession = (sessionId: SessionId, title: string) => {
    if (!store) { setTitles(previous => ({ ...previous, [sessionId]: title })); return; }
    const revision = latestRevision(sessionId);
    if (revision === undefined || readOnly) return;
    void store.send({ type: 'session.rename', requestId: newId(), sessionId, expectedRevision: revision, title }).then(result => {
      if (!result.ok) setNotice(`沒有改名：${result.code === 'stale_revision' ? '標題剛被更新，請再改一次。' : commandFeedback(result, 'session.rename')}`);
    });
  };
  /**
   * Pins or unpins in the mode the item belongs to (WB-11: a run or a node session in Workflow mode). preferences.set
   * replaces the whole record (T050 ★F), so it is built from the latest Snapshot at the moment of sending. IDs that name
   * nothing loaded any more are dropped from the list being changed, so they do not hold places of the 50.
   */
  const togglePin = (id: string) => {
    const current = preferenceStore.getSnapshot().snapshot;
    const base = current?.preferences;
    if (!current || !base || pinBlocked) return;
    const lists = pinnedOf(base);
    const key = modeOf(current, id);
    const loaded = (item: string) => current.sessions.some(session => session.id === item) || (key === 'workflow' && current.instances.some(instance => instance.id === item));
    const kept = lists[key].filter(loaded);
    // The IDs come from the Snapshot (sessions and instances), so they already are session or instance IDs.
    const target = id as (typeof kept)[number];
    let next: typeof kept;
    if (kept.includes(target)) next = kept.filter(item => item !== target);
    else if (kept.length >= PINNED_LIMIT) { setNotice(`釘選已滿（${PINNED_LIMIT}），請先取消一些釘選。`); return; }
    else next = [...kept, target];
    void preferenceStore.send({ type: 'preferences.set', requestId: newId(), preferences: { ...base, pinned: key === 'chat' ? { ...lists, chat: next as typeof lists.chat } : { ...lists, workflow: next } } }).then(result => {
      if (!result.ok) setNotice(`釘選沒有儲存：${commandFeedback(result)}`);
    });
  };
  /** Renames a run with workflow.rename (T050) and the run's latest revision; the demo keeps the name in this preview. */
  const renameRun = (instanceId: string, title: string) => {
    if (!store) { setTitles(previous => ({ ...previous, [instanceId]: title })); return; }
    const instance = store.getSnapshot().snapshot?.instances.find(item => item.id === instanceId);
    if (!instance || readOnly) return;
    void store.send({ type: 'workflow.rename', requestId: newId(), instanceId: instance.id, expectedRevision: instance.revision, title }).then(result => {
      if (!result.ok) setNotice(`沒有改名：${result.code === 'stale_revision' ? '這次執行剛被更新，請再改一次。' : commandFeedback(result, 'workflow.rename')}`);
    });
  };
  const closeTransfer = () => {
    const viewId = transfer?.viewId;
    setTransfer(null);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-pane="${viewId}"] .v4-model > button`)?.focus());
  };
  const changeTheme = (next: Theme) => {
    if (themeDisabled || next === theme) return;
    const latest = store?.getSnapshot().snapshot?.preferences;
    if (store && !readOnly) { if (latest) void store.send({ type: 'preferences.set', requestId: newId(), preferences: { ...latest, theme: next } }); }
    else setDemoTheme(next);
  };

  if (damaged && snapshot.app.status === 'damaged') return <div className="connection-screen damaged-screen" data-testid="shell-v4">
    <h1>{APP_NAME}</h1>
    <section role="alert"><h2>資料損壞，所有操作已停用</h2>
      <p>請保留資料庫並交由維護人員檢查。</p><dl><dt>原因代碼</dt><dd><code>{snapshot.app.reason}</code></dd><dt>資料庫位置</dt><dd><code>{snapshot.app.location}</code></dd></dl>
      <FolderButton target={{ kind: 'app-data' }} />
    </section>
    <button type="button" disabled={!store || ipcState?.connection === 'loading'} onClick={reload}>重新讀取資料</button>
    {ipcState?.connection === 'loading' && <p role="status">正在重新讀取資料…</p>}
    {ipcState?.connection === 'error' && <p role="alert">資料同步失敗，請再次重新讀取。</p>}
  </div>;

  const connectionText = !store ? '示意模式 · 未連接 runtime' : ipcState?.connection === 'ready' ? 'IPC 已連線'
    : ipcState?.connection === 'error' ? '資料同步失敗，保留上次資料' : '正在同步資料…';
  const connection = <><span className="v4-dot" data-state={store ? ipcState?.connection : 'demo'} aria-hidden="true" /><span role="status">{connectionText}</span>
    {store && <button type="button" className="v4-icon" aria-label="重新讀取資料" title="重新讀取資料（F5）" disabled={ipcState?.connection === 'loading'} onClick={reload}>↻</button>}</>;
  // The demo's own service stores preferences too, so pins work the same way there.
  const preferenceStore = store ?? serviceStore;
  const pinnedLists = pinnedOf(snapshot.preferences);
  const pinned = { chat: new Set<string>(pinnedLists.chat), workflow: new Set<string>(pinnedLists.workflow) };
  const pinBlocked = readOnly || commandDisabled || preferenceStore.isBlocked('preferences.set', 'preferences');
  // r2: a preferences write waits until the Snapshot shows the previous one; normally that is a few milliseconds.
  const savingReason = preferenceStore.savingPreferences() ? SAVING_PREFERENCES : undefined;
  const pinReason = readOnly ? readOnlyProps(true).title : savingReason ?? (pinBlocked ? '資料尚未同步完成，或上次設定的結果還待核對。' : undefined);
  const themeReason = themeDisabled ? (store?.savingPreferences() ? SAVING_PREFERENCES : '資料尚未同步完成，或上次設定的結果還待核對。') : undefined;

  let main;
  if (page === 'chat' && panes.panes.length) main = <div className={`v4-panes ${panes.panes.length > 1 ? 'v4-split' : ''}`}>{panes.panes.map(pane => {
    const session = snapshot.sessions.find(item => item.id === pane.sessionId);
    const title = (session && titles[session.id]) ?? session?.title ?? pane.sessionId;
    const runTitle = session?.kind === 'workflow' ? titles[session.workflow.instanceId] : undefined;
    return <Conversation key={pane.id} snapshot={snapshot} store={store} historyStore={serviceStore} ipcState={ipcState} pane={pane} title={title} runTitle={runTitle}
      active={pane.id === active?.id} split={panes.panes.length > 1} agents={agents} choice={session ? choiceFor(session) : newChoice}
      editTitle={editTitle.sessionId === pane.sessionId ? editTitle.nonce : 0} firstNotSent={firstNotSent.has(pane.sessionId)}
      onContext={patch => dispatch({ type: 'context', paneId: pane.id, sessionId: pane.sessionId, patch })}
      onChoice={next => { if (session) changeChoice(session, pane.id, next); }} onSend={text => sendTo(pane.sessionId, text)}
      onRename={name => renameSession(pane.sessionId, name)} onClose={() => closePane(pane.id)}
      onFocus={() => {
        if (pane.id === panes.active) return;
        dispatch({ type: 'focus', paneId: pane.id });
        // The focused pane of a split is the address of the page.
        if (route.page === 'chat' && route.id !== pane.sessionId) navigate(routePath('chat', pane.sessionId), true);
      }}
      onOpen={id => open(id, pane.id)} onProgress={id => { progressFrom.current = pane.id; go('progress', id); }} onNotice={setNotice} />;
  })}</div>;
  else if (page === 'settings') main = <SettingsV4 snapshot={snapshot} store={store} serviceStore={serviceStore} ipcState={ipcState} theme={theme} themeDisabled={themeDisabled} onTheme={changeTheme} />;
  else if (page === 'workflow-start') main = <WorkflowStart snapshot={snapshot} store={store} ipcState={ipcState} onOpen={id => open(id)} />;
  else if (page === 'progress') main = <div className="v4-page v4-page-wide"><WorkflowProgress snapshot={snapshot} instanceId={route.id} store={store} ipcState={ipcState}
    onOpen={id => open(id, progressFrom.current)} onBack={() => { if (active) open(active.sessionId); else go('new'); }} /></div>;
  else if (page === 'missing') main = <section className="v4-page" aria-labelledby="v4-missing-heading"><div className="v4-page-column">
    <h1 id="v4-missing-heading" tabIndex={-1}>{route.page === 'chat' ? `找不到 session：${route.id}` : '找不到頁面'}</h1>
    {route.page !== 'chat' && <p>無法辨識路由：<code>{route.path}</code></p>}
    <button type="button" onClick={() => go('new')}>回到新對話</button></div></section>;
  else if (page === 'agents' || page === 'templates' || page === 'chat') main = null;
  else main = <NewChat snapshot={snapshot} store={store} ipcState={ipcState} agents={agents} draft={newDraft} onDraft={setNewDraft} choice={newChoice} onChoice={setNewChoice}
    flow={flow} recent={recentFolders(snapshot)} onPickFolder={pickNewFolder} onNotice={setNotice}
    onSend={() => { if (!store) setNotice('示意模式：未連接 runtime，草稿已保留。連線時會依序送 session.create 與 session.send。'); else void flow.submit(newDraft, newChoice); }} />;

  const selectedSession = page === 'chat' ? active?.sessionId : undefined;
  return <div className={`v4-shell ${collapsed ? 'v4-collapsed' : ''} ${narrow ? 'v4-narrow' : ''}`} data-testid="shell-v4">
    <Sidebar snapshot={snapshot} titles={titles} pinned={pinned} mode={mode} selectedId={selectedSession} page={page === 'missing' ? 'chat' : page} collapsed={collapsed} overlay={narrow} theme={theme}
      readOnly={readOnly} pinBlocked={pinBlocked} pinReason={pinReason} themeReason={themeReason} connection={connection}
      onCollapse={value => { if (narrow) setNarrowOpen(!value); else setSidebarOpen(!value); }}
      onMode={value => { setMode(value); if (page === 'new' && value === 'workflow') go('workflow-start'); else if (page === 'workflow-start' && value === 'chat') go('new'); }}
      onNewChat={() => go('new')} onStartWorkflow={() => go('workflow-start')} onOpen={id => open(id)} onSplit={split}
      onTheme={changeTheme} onPage={next => go(next, next === 'templates' ? snapshot.workflows[0]?.id ?? '' : '')}
      onPin={togglePin} onRenameRun={renameRun}
      onRename={id => { open(id); setEditTitle(previous => ({ sessionId: id, nonce: previous.nonce + 1 })); }} />
    {narrow && narrowOpen && <div className="v4-scrim" aria-hidden="true" onClick={() => setNarrowOpen(false)} />}
    <main className="v4-main">
      {narrow && collapsed && <div className="v4-narrow-bar"><button type="button" className="v4-icon" aria-label="開啟側欄" onClick={() => setNarrowOpen(true)}>☰</button><strong>{APP_NAME}</strong>
        {mode === 'chat' ? <button type="button" className="v4-icon" aria-label="新對話" onClick={() => go('new')}>＋</button>
          : <button type="button" className="v4-icon" aria-label="開始 Workflow" onClick={() => go('workflow-start')}>＋</button>}</div>}
      <StorageBanner snapshot={snapshot} store={serviceStore} onBackups={() => { go('settings'); requestAnimationFrame(() => document.getElementById('settings-backups-heading')?.focus()); }} />
      {page === 'new' && <div className="v4-main-actions"><button type="button" onClick={() => go('workflow-start')}>開始 Workflow…</button></div>}
      {main}
      <div className="v4-page v4-page-wide" hidden={page !== 'agents'}>
        <AgentCatalog readOnly={readOnly} repository={agentRepository} demo={agentDemo} selectedId={page === 'agents' ? route.id : ''} visible={page === 'agents'}
          onSelect={id => navigate(routePath('agents', id))} />
      </div>
      <div className="v4-page v4-page-wide v4-editor-page" hidden={page !== 'templates'}>
        <WorkflowEditor readOnly={readOnly} repository={workflowRepository} demo={workflowDemo} agents={agents} models={snapshot.modelOptions} runtimes={snapshot.runtimes}
          selectedId={page === 'templates' ? route.id : ''} visible={page === 'templates'} onSelect={id => navigate(routePath('templates', id))} />
      </div>
    </main>
    {notice && <div className="v4-notice" role="status"><span>{notice}</span><button type="button" className="v4-icon" aria-label="關閉提示" onClick={() => setNotice('')}>×</button></div>}
    {transfer && <TransferDialog key={`${transfer.sessionId}:${transfer.viewId}`} snapshot={snapshot} preview={transfer} store={store} ipcState={ipcState} onClose={closeTransfer}
      onOpen={id => { open(id, transfer.viewId); closeTransfer(); }} />}
  </div>;
}
