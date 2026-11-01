import { readOnlyProps } from './read-only';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import type { AgentId, SessionId, Snapshot } from '../../../contracts';
import { fixtureReadOnlySnapshot, fixtureSnapshot } from '../../../contracts/fixtures/snapshot';
import { SessionTree } from './SessionTree';
import { SessionWorkspace } from './SessionWorkspace';
import type { Selection } from './SessionWorkspace';
import { initialWorkspace, workspaceReducer } from './workbench-state';
import { WorkflowProgress } from './WorkflowProgress';
import { FolderButton } from './FolderButton';
import { TransferDialog } from './TransferDialog';
import type { TransferPreview } from './TransferDialog';
import { readTheme, THEME_KEY, type Theme } from './theme';
import { AgentCatalog } from './AgentCatalog';
import { createAgentDemo } from './agent-demo';
import { WorkflowEditor } from './WorkflowEditor';
import { createWorkflowDemo } from './workflow-demo';
import { RequestId } from '../../../contracts';
import { createIpcAgentRepository } from './agent-repository';
import { createIpcWorkflowRepository } from './workflow-repository';
import { createRendererStore, rendererStore } from './renderer-store';
import { createStorageDemo } from './query-bridge';
import { BackupDialog, SettingsDialog, StorageBanner } from './StorageSettings';
import { performanceSnapshot } from './performance-demo';
import type { RendererStore, RendererState } from './renderer-store';
import { ConnectionStatus } from './ConnectionStatus';
import { WorkflowStart } from './WorkflowStart';
import { SessionCreate } from './SessionCreate';
import type { SessionCreateDraft } from './SessionCreate';
import { AppMenu } from './AppMenu';
import './styles.css';

export const APP_NAME = 'AgentWorkflowGui';
export { THEME_KEY } from './theme';

// Keep visibility in sync with the CSS breakpoint, including window resizing.
const narrowQuery = '(max-width: 1250px)';
const isNarrow = () => window.matchMedia?.(narrowQuery).matches ?? false;
const subscribeWidth = (onChange: () => void) => {
  const query = window.matchMedia?.(narrowQuery);
  query?.addEventListener('change', onChange);
  return () => query?.removeEventListener('change', onChange);
};

// Hash transport keeps the specified route paths usable under Electron's file:// URL.
export const pageRegistry = [
  { id: 'workbench', title: '工作台', pattern: /^\/workbench$/, navigation: true },
  { id: 'start', title: '啟動 Workflow', pattern: /^\/workflows\/start$/, navigation: false },
  { id: 'create', title: '新增 session', pattern: /^\/sessions\/new$/, navigation: false },
  { id: 'workflow', title: 'Workflow 編輯器', pattern: /^\/workflows\/([^/]+)\/edit$/, navigation: true },
  { id: 'agents', title: 'Agent 管理', pattern: /^\/agents(?:\/([^/]+))?$/, navigation: true },
  { id: 'progress', title: 'Workflow 執行進度', pattern: /^\/workflow-instances\/([^/]+)$/, navigation: false },
] as const;
const currentRoute = () => window.location.hash.slice(1) || '/workbench';
const focusView = (viewId: string) => requestAnimationFrame(() => document.getElementById(`${viewId}-heading`)?.focus());

export function App({ snapshot }: { snapshot?: Snapshot }) {
  const demo = new URLSearchParams(window.location.search).get('demo');
  return window.awg ? <ConnectedApp store={rendererStore(window.awg)} /> : <DemoApp snapshot={snapshot ?? (demo === 'long' ? performanceSnapshot() : demo === 'read-only' ? fixtureReadOnlySnapshot : fixtureSnapshot)} />;
}

function DemoApp({ snapshot }: { snapshot: Snapshot }) {
  const serviceStore = useMemo(() => createRendererStore(createStorageDemo(snapshot)), [snapshot]);
  const state = useSyncExternalStore(serviceStore.subscribe, serviceStore.getSnapshot);
  useEffect(() => { void serviceStore.start(); return () => serviceStore.dispose(); }, [serviceStore]);
  return <AppContent snapshot={state.snapshot ?? snapshot} serviceStore={serviceStore} />;
}

function ConnectedApp({ store }: { store: RendererStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => {
    void store.start();
    const reconnect = () => { void store.reconnect(); };
    window.addEventListener('online', reconnect);
    return () => { window.removeEventListener('online', reconnect); store.dispose(); };
  }, [store]);
  if (!state.snapshot) return <div className="connection-screen"><h1>{APP_NAME}</h1><ConnectionStatus state={state} store={store} /></div>;
  return <AppContent snapshot={state.snapshot} store={store} serviceStore={store} ipcState={state} />;
}

function AppContent({ snapshot, store, serviceStore, ipcState }: { snapshot: Snapshot; store?: RendererStore; serviceStore: RendererStore; ipcState?: RendererState }) {
  const [{ repository: workflowRepository, controls: workflowDemo }] = useState(() => store
    ? { repository: createIpcWorkflowRepository(store), controls: undefined } : createWorkflowDemo(snapshot.workflows));
  const [{ repository: agentRepository, controls: agentDemo }] = useState(() => store
    ? { repository: createIpcAgentRepository(store), controls: undefined }
    : createAgentDemo(snapshot.agents, id => snapshot.sessions.some(session => session.agent.id === id) || workflowRepository.getSnapshot().some(workflow => workflow.nodes.some(node => node.kind === 'agent' && node.agentId === id))));
  const agentOptions = useSyncExternalStore(agentRepository.subscribe, agentRepository.getSnapshot);
  const [workspace, dispatch] = useReducer(workspaceReducer, snapshot.sessions, initialWorkspace);
  const [route, setRoute] = useState(currentRoute);
  const [demoTheme, setTheme] = useState<Theme>();
  const readOnly = snapshot.app.status === 'read-only';
  const theme = store && !readOnly ? snapshot.preferences.theme : demoTheme ?? readTheme(snapshot.preferences.theme);
  const narrow = useSyncExternalStore(subscribeWidth, isNarrow);
  const [notice, setNotice] = useState('');
  const [settings, setSettings] = useState(false);
  const [backups, setBackups] = useState(false);
  const [selections, setSelections] = useState<Record<string, Selection>>({});
  const [transfer, setTransfer] = useState<TransferPreview | null>(null);
  const [createDraft, setCreateDraft] = useState<SessionCreateDraft>({ agentId: '', modelKey: '', cwd: '', parentId: '' });
  // Discard the preview as soon as damaged data is observed, before recovery can render it again.
  if (snapshot.app.status === 'damaged' && transfer) setTransfer(null);
  const returnAnchor = useRef<{ viewId: string; sessionId: SessionId } | null>(null);
  const pageHeading = useRef<HTMLHeadingElement>(null);
  const path = route.split('?')[0] ?? '/workbench';
  const page = pageRegistry.find(candidate => candidate.pattern.test(path));
  const workbenchVisible = page?.id === 'workbench';
  const workspaceViewIds = workspace.views.map(view => view.id).join(',');
  const activeView = workspace.views.find(view => view.id === workspace.activeViewId);
  const workflowRoute = snapshot.workflows[0] ? `/workflows/${encodeURIComponent(snapshot.workflows[0].id)}/edit` : '/workflows/unavailable/edit';
  const routes: Record<string, string> = { workbench: '/workbench', workflow: workflowRoute, agents: '/agents' };

  useEffect(() => {
    const sync = () => setRoute(currentRoute());
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => { window.removeEventListener('hashchange', sync); window.removeEventListener('popstate', sync); };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(THEME_KEY, theme); }
    catch { /* In restricted environments the in-memory choice still works. */ }
  }, [theme]);
  // AgentCatalog owns focus for entering the page and changing its selection.
  useEffect(() => { if (page?.id !== 'agents' && page?.id !== 'workflow') pageHeading.current?.focus(); }, [path, page?.id]);
  useEffect(() => {
    if (workbenchVisible) {
      const query = new URLSearchParams({ workspaceViewIds });
      window.history.replaceState(null, '', `#/workbench?${query.toString()}`);
    }
  }, [workbenchVisible, workspaceViewIds]);

  const navigate = useCallback((next: string) => { window.history.pushState(null, '', `#${next}`); setRoute(next); }, []);
  const openSession = useCallback((sessionId: SessionId, viewId?: string) => {
    if (!snapshot.sessions.some(session => session.id === sessionId)) { setNotice(`找不到 session：${sessionId}`); return; }
    dispatch({ type: 'open', sessionId, ...(viewId ? { viewId } : {}) });
    focusView(viewId ?? (workspace.activeViewId || workspace.closedViews.at(-1)?.id || `view-${workspace.nextId}`));
  }, [snapshot.sessions, workspace.activeViewId, workspace.closedViews, workspace.nextId]);
  const openProgressSession = useCallback((id: SessionId) => {
    navigate('/workbench');
    openSession(id, returnAnchor.current?.viewId);
  }, [navigate, openSession]);
  const changeSelection = (sessionId: SessionId, patch: Partial<Selection>) => {
    const session = snapshot.sessions.find(candidate => candidate.id === sessionId);
    if (!session) return;
    setSelections(previous => ({ ...previous, [sessionId]: { ...(previous[sessionId] ?? { agentId: session.agent.id, model: session.requestedModel }), ...patch } }));
  };
  const changeAgent = (sessionId: SessionId, agentId: AgentId) => {
    const session = snapshot.sessions.find(item => item.id === sessionId);
    if (store && session) void store.send({ type: 'session.setAgent', requestId: RequestId.parse(crypto.randomUUID()), sessionId, expectedRevision: session.revision, agentId });
    else changeSelection(sessionId, { agentId });
  };
  const closeTransfer = () => {
    const viewId = transfer?.viewId;
    setTransfer(null);
    requestAnimationFrame(() => {
      const view = document.querySelector(`[data-workspace="${viewId}"]`);
      view?.querySelector<HTMLElement>(transfer?.model ? 'select[aria-label="Model"]' : '[data-transfer-trigger]')?.focus();
    });
  };
  const commandDisabled = snapshot.app.status !== 'ready' || (!!store && ipcState?.connection !== 'ready');
  const themeDisabled = !readOnly && (commandDisabled || !!store?.isBlocked('preferences.set', 'preferences'));
  const tabDisabled = workspace.views.length >= 2 || snapshot.sessions.length === 0;
  const addTab = () => {
    if (tabDisabled) return;
    const sessionId = workspace.closedViews.at(-1)?.sessionId ?? snapshot.sessions.find(session => !workspace.views.some(view => view.sessionId === session.id))?.id ?? snapshot.sessions[0]?.id;
    if (sessionId) {
      const id = workspace.closedViews.at(-1)?.id ?? `view-${workspace.nextId}`;
      dispatch({ type: 'add', sessionId }); navigate('/workbench'); focusView(id);
    }
  };
  const createSession = () => {
    if (commandDisabled) return;
    navigate('/sessions/new');
  };
  const changeTheme = (next: Theme) => {
    if (themeDisabled || next === theme) return;
    if (store && !readOnly) void store.send({ type: 'preferences.set', requestId: RequestId.parse(crypto.randomUUID()), preferences: { ...snapshot.preferences, theme: next } });
    else setTheme(next);
  };
  const header = <header className="app-header"><div className="brand"><span className="brand-mark" aria-hidden="true">≋</span>
    <AppMenu readOnly={readOnly} theme={theme} commandDisabled={commandDisabled} themeDisabled={themeDisabled} tabDisabled={tabDisabled} reloadDisabled={!store || ipcState?.connection === 'loading'}
      onBackups={() => setBackups(true)} onSettings={() => setSettings(true)}
      onCreate={createSession} onWorkflow={() => { if (!commandDisabled) navigate('/workflows/start'); }} onTab={addTab}
      onNavigate={page => navigate(routes[page] ?? '/workbench')} onTheme={changeTheme} onReload={() => void store?.reconnect()} />
    <strong>{APP_NAME}</strong>{!store && <span className="demo-badge">示意資料 · 示意模式</span>}</div>
    <label className="theme-picker">外觀<select aria-label="外觀主題" value={theme} disabled={themeDisabled} onChange={event => changeTheme(event.target.value === 'light' ? 'light' : 'dark')}><option value="dark">深色</option><option value="light">淺色</option></select></label>
  </header>;

  let entityId = page?.pattern.exec(path)?.[1] ?? '';
  try { entityId = decodeURIComponent(entityId); } catch { /* Keep a malformed ID visible as missing. */ }

  if (snapshot.app.status === 'damaged') return <div className="connection-screen damaged-screen">
    {header}<section role="alert"><h2>資料損壞，所有操作已停用</h2>
      <p>請保留資料庫並交由維護人員檢查。</p><dl><dt>原因代碼</dt><dd><code>{snapshot.app.reason}</code></dd><dt>資料庫位置</dt><dd><code>{snapshot.app.location}</code></dd></dl>
      <FolderButton target={{ kind: 'app-data' }} />
    </section>
    <button disabled={!store || ipcState?.connection === 'loading'} onClick={() => void store?.reconnect()}>重新讀取資料</button>
    {ipcState?.connection === 'loading' && <p role="status">正在重新讀取資料…</p>}
    {ipcState?.connection === 'error' && <p role="alert">資料同步失敗，請再次重新讀取。</p>}
  </div>;

  return <div className="app-shell">
    {header}
    <StorageBanner snapshot={snapshot} store={serviceStore} onBackups={() => setBackups(true)} />
    <nav className="app-nav" aria-label="主要導覽">{pageRegistry.filter(entry => entry.navigation).map(entry => <a key={entry.id} href={`#${routes[entry.id]}`} aria-current={page?.id === entry.id ? 'page' : undefined} onClick={event => { event.preventDefault(); navigate(routes[entry.id] ?? '/workbench'); }}>{entry.title}</a>)}<span className="nav-note">{store ? '資料來自應用程式服務' : '以契約假資料預覽工作台'}</span></nav>
    <div className="page-toolbar"><h1 ref={pageHeading} tabIndex={-1}>{page?.title ?? '找不到頁面'}</h1>
      {workbenchVisible && <button {...readOnlyProps(readOnly)} disabled={commandDisabled} onClick={createSession}>新增 session</button>}
      {(workbenchVisible || page?.id === 'workflow') && <button {...readOnlyProps(readOnly)} disabled={commandDisabled} onClick={() => navigate('/workflows/start')}>啟動 Workflow</button>}
      {workbenchVisible && <button className="primary" disabled={tabDisabled} title={workspace.views.length >= 2 ? '此階段提供兩組工作區' : '開啟第二組並排工作區'} onClick={addTab}>＋ 新增 tab</button>}
    </div>
    <main className="page-content">
      <div className="workbench" hidden={!workbenchVisible}>
        <SessionTree snapshot={snapshot} demo={!store} selectedId={activeView?.sessionId} onOpen={id => openSession(id)} />
        <div className="workspace-area">
          {workspace.views.length > 1 && <div className="workspace-switcher" aria-label="可見工作區">{workspace.views.map(view => <button key={view.id} aria-pressed={view.id === workspace.activeViewId} onClick={() => { dispatch({ type: 'focus', viewId: view.id }); focusView(view.id); }}>{snapshot.sessions.find(session => session.id === view.sessionId)?.title ?? view.sessionId}</button>)}</div>}
          {workspace.views.length === 0 && <div className="empty-workbench"><h2>開啟一段對話</h2><p>從左側選取 session，恢復工作區。</p><p className="muted">Sessions 仍保留在清單中。</p></div>}
          <div className={`workspace-grid ${workspace.views.length > 1 ? 'split' : ''}`}>{workspace.views.map(view => <SessionWorkspace key={view.id} snapshot={snapshot} historyStore={serviceStore} store={store} ipcState={ipcState} agentOptions={agentOptions} view={view} active={view.id === workspace.activeViewId} visible={workbenchVisible && (!narrow || view.id === workspace.activeViewId)} selection={selections[view.sessionId]}
            onFocus={() => { if (view.id !== workspace.activeViewId) dispatch({ type: 'focus', viewId: view.id }); }}
            onClose={() => {
              dispatch({ type: 'close', viewId: view.id });
              const remaining = workspace.views.find(other => other.id !== view.id);
              if (remaining) focusView(remaining.id); else requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.session-link')?.focus());
              setNotice('已關閉工作區視圖；session 與草稿保留，未送出停止、封存或刪除指令。');
            }}
            onContext={patch => dispatch({ type: 'context', viewId: view.id, sessionId: view.sessionId, patch })}
            onOpen={id => openSession(id, view.id)} onAgent={id => changeAgent(view.sessionId, id)}
            onTransfer={() => setTransfer({ sessionId: view.sessionId, viewId: view.id })}
            onModel={model => {
              const session = snapshot.sessions.find(candidate => candidate.id === view.sessionId);
              if (model.runtime !== session?.requestedModel.runtime) {
                if (session?.kind === 'ordinary') setTransfer({ sessionId: view.sessionId, model, viewId: view.id });
                else setNotice('workflow 的 node 不能換工具。');
              }
              else {
                const selection = { runtime: model.runtime, model: model.model, ...(model.defaultEffort ? { effort: model.defaultEffort } : {}) };
                if (store && session) void store.send({ type: 'session.setModel', requestId: RequestId.parse(crypto.randomUUID()), sessionId: session.id, expectedRevision: session.revision, model: selection });
                else changeSelection(view.sessionId, { model: selection });
              }
            }}
            onProgress={instanceId => { returnAnchor.current = { viewId: view.id, sessionId: view.sessionId }; navigate(`/workflow-instances/${encodeURIComponent(instanceId)}`); }} onNotice={setNotice} />)}</div>
        </div>
      </div>
      <AgentCatalog readOnly={snapshot.app.status === 'read-only'} repository={agentRepository} demo={agentDemo} selectedId={page?.id === 'agents' ? entityId : ''} visible={page?.id === 'agents'} onSelect={id => navigate(id ? `/agents/${encodeURIComponent(id)}` : '/agents')} />
      <WorkflowEditor readOnly={snapshot.app.status === 'read-only'} repository={workflowRepository} demo={workflowDemo} agents={agentOptions} models={snapshot.modelOptions} selectedId={page?.id === 'workflow' ? entityId : ''} visible={page?.id === 'workflow'} onSelect={id => navigate(`/workflows/${encodeURIComponent(id)}/edit`)} />
      {page?.id === 'start' && <WorkflowStart snapshot={snapshot} store={store} ipcState={ipcState} onOpen={id => { navigate('/workbench'); openSession(id); }} />}
      {page?.id === 'create' && <SessionCreate snapshot={snapshot} store={store} ipcState={ipcState} draft={createDraft} onDraft={setCreateDraft} onOpen={id => { setCreateDraft({ agentId: '', modelKey: '', cwd: '', parentId: '' }); navigate('/workbench'); openSession(id); }} />}
      {page?.id === 'progress' && <WorkflowProgress snapshot={snapshot} instanceId={entityId} store={store} ipcState={ipcState} onOpen={openProgressSession} onBack={() => {
          navigate('/workbench');
          if (returnAnchor.current) { const anchor = returnAnchor.current; openSession(anchor.sessionId, anchor.viewId); }
        }} />}
      {!page && <section className="placeholder-page">
        <p>無法辨識路由：<code>{path}</code></p><button onClick={() => navigate('/workbench')}>返回工作台</button>
      </section>}
    </main>
    <footer className="app-footer">{store && ipcState ? <ConnectionStatus store={store} state={ipcState} /> : <span>示意資料 · 示意模式 · 未連接 runtime</span>}<span>{workspace.views.length} 組工作區</span></footer>
    {notice && <div className="notice" role="status"><span>{notice}</span><button aria-label="關閉提示" onClick={() => setNotice('')}>×</button></div>}
    {transfer && <TransferDialog key={`${transfer.sessionId}:${transfer.viewId}`} snapshot={snapshot} preview={transfer} store={store} ipcState={ipcState} onClose={closeTransfer} onOpen={id => { openSession(id, transfer.viewId); closeTransfer(); }} />}
    {settings && <SettingsDialog store={serviceStore} demo={!store} onClose={() => setSettings(false)} />}
    {backups && <BackupDialog store={serviceStore} demo={!store} onClose={() => setBackups(false)} />}
  </div>;
}
