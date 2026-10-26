import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import type { AgentId, ModelOption, SessionId, Snapshot } from '../../../contracts';
import { fixtureSnapshot } from '../../../contracts/fixtures/snapshot';
import { SessionTree } from './SessionTree';
import { SessionWorkspace } from './SessionWorkspace';
import type { Selection } from './SessionWorkspace';
import { initialWorkspace, workspaceReducer } from './workbench-state';
import { WorkflowSummary } from './DetailPanel';
import { readTheme, THEME_KEY, type Theme } from './theme';
import { AgentCatalog } from './AgentCatalog';
import { createAgentDemo } from './agent-demo';
import { WorkflowEditor } from './WorkflowEditor';
import { createWorkflowDemo } from './workflow-demo';
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
  { id: 'workflow', title: 'Workflow 編輯器', pattern: /^\/workflows\/([^/]+)\/edit$/, navigation: true },
  { id: 'agents', title: 'Agent 管理', pattern: /^\/agents(?:\/([^/]+))?$/, navigation: true },
  { id: 'progress', title: 'Workflow 執行進度', pattern: /^\/workflow-instances\/([^/]+)$/, navigation: false },
] as const;
const currentRoute = () => window.location.hash.slice(1) || '/workbench';

interface TransferPreview { sessionId: SessionId; model: ModelOption; viewId: string }
function TransferDialog({ snapshot, preview, onClose }: { snapshot: Snapshot; preview: TransferPreview; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const session = snapshot.sessions.find(item => item.id === preview.sessionId);
  useEffect(() => {
    const element = dialog.current;
    if (element?.showModal) element.showModal(); else element?.setAttribute('open', '');
    return () => { if (element?.close) element.close(); };
  }, []);
  return <dialog ref={dialog} aria-labelledby="transfer-heading" onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    if (event.key === 'Tab') { event.preventDefault(); dialog.current?.querySelector('button')?.focus(); }
  }}>
    <span className="eyebrow">跨工具轉交 · 示意預覽</span><h2 id="transfer-heading">轉交到新的 session</h2>
    <p>{session?.title ?? preview.sessionId}</p>
    <div className="transfer-route">{session?.requestedModel.runtime} → {preview.model.runtime} · {preview.model.displayName}</div>
    <p>跨工具需先整理交接內容、審閱並確認，再建立新 session。</p>
    <p className="muted">本階段尚未接入轉交流程。原 session 與 Model 保持原設定，未建立新 session、未傳送內容。</p>
    <button className="primary" autoFocus onClick={onClose}>返回工作台</button>
  </dialog>;
}

export function App({ snapshot = fixtureSnapshot }: { snapshot?: Snapshot }) {
  const [{ repository: agentRepository, controls: agentDemo }] = useState(() => createAgentDemo(snapshot.agents));
  const [{ repository: workflowRepository, controls: workflowDemo }] = useState(() => createWorkflowDemo(snapshot.workflows));
  const agentOptions = useSyncExternalStore(agentRepository.subscribe, agentRepository.getSnapshot);
  const [workspace, dispatch] = useReducer(workspaceReducer, snapshot.sessions, initialWorkspace);
  const [route, setRoute] = useState(currentRoute);
  const [theme, setTheme] = useState<Theme>(() => readTheme(snapshot.preferences.theme));
  const narrow = useSyncExternalStore(subscribeWidth, isNarrow);
  const [notice, setNotice] = useState('');
  const [selections, setSelections] = useState<Record<string, Selection>>({});
  const [transfer, setTransfer] = useState<TransferPreview | null>(null);
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

  const navigate = (next: string) => { window.history.pushState(null, '', `#${next}`); setRoute(next); };
  const focusView = (viewId: string) => requestAnimationFrame(() => document.getElementById(`${viewId}-heading`)?.focus());
  const openSession = (sessionId: SessionId, viewId?: string) => {
    if (!snapshot.sessions.some(session => session.id === sessionId)) { setNotice(`找不到 session：${sessionId}`); return; }
    dispatch({ type: 'open', sessionId, ...(viewId ? { viewId } : {}) });
    focusView(viewId ?? (workspace.activeViewId || workspace.closedViews.at(-1)?.id || `view-${workspace.nextId}`));
  };
  const changeSelection = (sessionId: SessionId, patch: Partial<Selection>) => {
    const session = snapshot.sessions.find(candidate => candidate.id === sessionId);
    if (!session) return;
    setSelections(previous => ({ ...previous, [sessionId]: { ...(previous[sessionId] ?? { agentId: session.agent.id, model: session.requestedModel }), ...patch } }));
  };
  const changeAgent = (sessionId: SessionId, agentId: AgentId) => changeSelection(sessionId, { agentId });
  const closeTransfer = () => {
    const viewId = transfer?.viewId;
    setTransfer(null);
    requestAnimationFrame(() => {
      const view = document.querySelector(`[data-workspace="${viewId}"]`);
      view?.querySelector<HTMLSelectElement>('select[aria-label="Model"]')?.focus();
    });
  };

  let entityId = page?.pattern.exec(path)?.[1] ?? '';
  try { entityId = decodeURIComponent(entityId); } catch { /* Keep a malformed ID visible as missing. */ }
  const instance = snapshot.instances.find(item => item.id === entityId);

  return <div className="app-shell">
    <header className="app-header"><div className="brand"><span className="brand-mark" aria-hidden="true">≋</span><strong>{APP_NAME}</strong><span className="demo-badge">示意模式</span></div>
      <label className="theme-picker">外觀<select aria-label="外觀主題" value={theme} onChange={event => setTheme(event.target.value === 'light' ? 'light' : 'dark')}><option value="dark">深色</option><option value="light">淺色</option></select></label>
    </header>
    <nav className="app-nav" aria-label="主要導覽">{pageRegistry.filter(entry => entry.navigation).map(entry => <a key={entry.id} href={`#${routes[entry.id]}`} aria-current={page?.id === entry.id ? 'page' : undefined} onClick={event => { event.preventDefault(); navigate(routes[entry.id] ?? '/workbench'); }}>{entry.title}</a>)}<span className="nav-note">以契約假資料預覽工作台</span></nav>
    <div className="page-toolbar"><h1 ref={pageHeading} tabIndex={-1}>{page?.title ?? '找不到頁面'}</h1>
      {workbenchVisible && <button className="primary" disabled={workspace.views.length >= 2 || snapshot.sessions.length === 0} title={workspace.views.length >= 2 ? '此階段提供兩組工作區' : '開啟第二組並排工作區'} onClick={() => {
        const sessionId = workspace.closedViews.at(-1)?.sessionId ?? snapshot.sessions.find(session => !workspace.views.some(view => view.sessionId === session.id))?.id ?? snapshot.sessions[0]?.id;
        if (sessionId) { const id = workspace.closedViews.at(-1)?.id ?? `view-${workspace.nextId}`; dispatch({ type: 'add', sessionId }); focusView(id); }
      }}>＋ 新增 tab</button>}
    </div>
    <main className="page-content">
      <div className="workbench" hidden={!workbenchVisible}>
        <SessionTree snapshot={snapshot} selectedId={activeView?.sessionId} onOpen={id => openSession(id)} />
        <div className="workspace-area">
          {workspace.views.length > 1 && <div className="workspace-switcher" aria-label="可見工作區">{workspace.views.map(view => <button key={view.id} aria-pressed={view.id === workspace.activeViewId} onClick={() => { dispatch({ type: 'focus', viewId: view.id }); focusView(view.id); }}>{snapshot.sessions.find(session => session.id === view.sessionId)?.title ?? view.sessionId}</button>)}</div>}
          {workspace.views.length === 0 && <div className="empty-workbench"><h2>開啟一段對話</h2><p>從左側選取 session，恢復工作區。</p><p className="muted">Sessions 仍保留在清單中。</p></div>}
          <div className={`workspace-grid ${workspace.views.length > 1 ? 'split' : ''}`}>{workspace.views.map(view => <SessionWorkspace key={view.id} snapshot={snapshot} agentOptions={agentOptions} view={view} active={view.id === workspace.activeViewId} visible={workbenchVisible && (!narrow || view.id === workspace.activeViewId)} selection={selections[view.sessionId]}
            onFocus={() => { if (view.id !== workspace.activeViewId) dispatch({ type: 'focus', viewId: view.id }); }}
            onClose={() => {
              dispatch({ type: 'close', viewId: view.id });
              const remaining = workspace.views.find(other => other.id !== view.id);
              if (remaining) focusView(remaining.id); else requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.session-link')?.focus());
              setNotice('已關閉工作區視圖；session 與草稿保留，未送出停止、封存或刪除指令。');
            }}
            onContext={patch => dispatch({ type: 'context', viewId: view.id, sessionId: view.sessionId, patch })}
            onOpen={id => openSession(id, view.id)} onAgent={id => changeAgent(view.sessionId, id)}
            onModel={model => {
              const session = snapshot.sessions.find(candidate => candidate.id === view.sessionId);
              if (model.runtime !== session?.requestedModel.runtime) setTransfer({ sessionId: view.sessionId, model, viewId: view.id });
              else changeSelection(view.sessionId, { model: { runtime: model.runtime, model: model.model, ...(model.defaultEffort ? { effort: model.defaultEffort } : {}) } });
            }}
            onProgress={instanceId => { returnAnchor.current = { viewId: view.id, sessionId: view.sessionId }; navigate(`/workflow-instances/${encodeURIComponent(instanceId)}`); }} onNotice={setNotice} />)}</div>
        </div>
      </div>
      <AgentCatalog repository={agentRepository} demo={agentDemo} selectedId={page?.id === 'agents' ? entityId : ''} visible={page?.id === 'agents'} onSelect={id => navigate(id ? `/agents/${encodeURIComponent(id)}` : '/agents')} />
      <WorkflowEditor repository={workflowRepository} demo={workflowDemo} agents={agentOptions} models={snapshot.modelOptions} selectedId={page?.id === 'workflow' ? entityId : ''} visible={page?.id === 'workflow'} onSelect={id => navigate(`/workflows/${encodeURIComponent(id)}/edit`)} />
      {!workbenchVisible && page?.id !== 'agents' && page?.id !== 'workflow' && <section className="placeholder-page">
        {page?.id === 'progress' && <><span className="eyebrow">唯讀 · 指定執行群組</span><h2>{instance?.title ?? '找不到指定的 Workflow 執行群組'}</h2><p className="muted">{entityId || '無效 ID'} · 完整進度畫布將於後續任務提供。</p>{instance && <WorkflowSummary snapshot={snapshot} instance={instance} />}</>}
        {!page && <p>無法辨識路由：<code>{path}</code></p>}
        <button onClick={() => {
          navigate('/workbench');
          if (page?.id === 'progress' && returnAnchor.current) { const anchor = returnAnchor.current; openSession(anchor.sessionId, anchor.viewId); }
        }}>返回工作台</button>
      </section>}
    </main>
    <footer className="app-footer"><span>示意模式 · 未連接 runtime</span><span>{workspace.views.length} 組工作區</span></footer>
    {notice && <div className="notice" role="status"><span>{notice}</span><button aria-label="關閉提示" onClick={() => setNotice('')}>×</button></div>}
    {transfer && <TransferDialog snapshot={snapshot} preview={transfer} onClose={closeTransfer} />}
  </div>;
}
