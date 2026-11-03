// The v0.4 shell (REVISION_V0_4 U-03): a simple, Claude-like layout. T047 (U0) runs it only in demo mode with `?shell=v4`.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { SessionId, Snapshot } from '../../../../contracts';
import { AgentCatalog } from '../AgentCatalog';
import { createAgentDemo } from '../agent-demo';
import { readTheme, THEME_KEY } from '../theme';
import type { Theme } from '../theme';
import { WorkflowEditor } from '../WorkflowEditor';
import { createWorkflowDemo } from '../workflow-demo';
import { WorkflowProgress } from '../WorkflowProgress';
import { defaultModelKey } from './Composer';
import type { ComposerChoice } from './Composer';
import { Conversation } from './Conversation';
import { demoPinned, nextAutoFolder, v4DemoSnapshot } from './demo-data';
import type { V4Page, V4Pane } from './demo-data';
import { NewChat, SettingsV4, WorkflowStartV4 } from './Pages';
import { Sidebar } from './Sidebar';
import '../styles.css';
import './shell-v4.css';

// Below this width the sidebar collapses by itself and opens as an overlay.
const narrowQuery = '(max-width: 900px)';
const isNarrow = () => window.matchMedia?.(narrowQuery).matches ?? false;
const subscribeWidth = (onChange: () => void) => {
  const query = window.matchMedia?.(narrowQuery);
  query?.addEventListener('change', onChange);
  return () => query?.removeEventListener('change', onChange);
};
const pages: readonly V4Page[] = ['new', 'chat', 'settings', 'workflow-start', 'agents', 'templates', 'progress'];
const tabs = ['files', 'tasks', 'messages', 'info'] as const;

/** Initial state from the URL, so each screenshot state can be opened directly. Interaction works from there as usual. */
function initial(snapshot: Snapshot) {
  const params = new URLSearchParams(window.location.search);
  const known = (id: string | null) => snapshot.sessions.find(session => session.id === id)?.id;
  const page = pages.find(value => value === params.get('page')) ?? 'new';
  const tab = tabs.find(value => value === params.get('tab')) ?? 'files';
  const first = known(params.get('session')) ?? snapshot.sessions[0]?.id;
  const second = known(params.get('split'));
  const panes: V4Pane[] = [
    ...(first ? [{ id: 'pane-1', sessionId: first, details: params.get('details') === '1', tab }] : []),
    ...(second ? [{ id: 'pane-2', sessionId: second, details: false, tab: 'files' as const }] : []),
  ];
  return { page: page === 'chat' && !panes.length ? 'new' as const : page, panes, sidebar: params.get('sidebar') !== '0', instance: params.get('instance') ?? snapshot.instances[0]?.id ?? '' };
}

export function ShellV4({ snapshot = v4DemoSnapshot }: { snapshot?: Snapshot }) {
  const start = useMemo(() => initial(snapshot), [snapshot]);
  const [page, setPage] = useState<V4Page>(start.page);
  const [panes, setPanes] = useState<V4Pane[]>(start.panes);
  const [activePane, setActivePane] = useState('pane-1');
  const [nextPane, setNextPane] = useState(3);
  const [instanceId, setInstanceId] = useState(start.instance);
  const [theme, setTheme] = useState<Theme>(() => readTheme('dark'));
  const narrow = useSyncExternalStore(subscribeWidth, isNarrow);
  const [sidebarOpen, setSidebarOpen] = useState(start.sidebar);
  const [narrowOpen, setNarrowOpen] = useState(false);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [pinned, setPinned] = useState<Set<string>>(() => new Set(demoPinned));
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [choices, setChoices] = useState<Record<string, ComposerChoice>>({});
  const [editTitle, setEditTitle] = useState<{ sessionId: string; nonce: number }>({ sessionId: '', nonce: 0 });
  const [notice, setNotice] = useState('');
  const [{ repository: agentRepository, controls: agentDemo }] = useState(() => createAgentDemo(snapshot.agents, id => snapshot.sessions.some(session => session.agent.id === id)));
  const [{ repository: workflowRepository, controls: workflowDemo }] = useState(() => createWorkflowDemo(snapshot.workflows));
  const agents = useSyncExternalStore(agentRepository.subscribe, agentRepository.getSnapshot);
  const autoFolder = nextAutoFolder(new Date());
  const collapsed = narrow ? !narrowOpen : !sidebarOpen;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* The in-memory choice still works. */ }
  }, [theme]);
  // The new-chat page focuses its input instead; a conversation keeps focus where the user clicked.
  useEffect(() => { document.getElementById(page === 'settings' ? 'v4-settings-heading' : page === 'workflow-start' ? 'v4-start-heading' : '')?.focus({ preventScroll: true }); }, [page]);

  const active = panes.find(pane => pane.id === activePane) ?? panes[0];
  // An existing session starts from its own Agent and Model; a new chat starts with no Agent and the default Model.
  const choiceFor = (key: string, session?: Snapshot['sessions'][number]): ComposerChoice => choices[key] ?? (session
    ? { folder: { kind: 'picked', path: session.cwd }, agentId: session.agent.id, modelKey: `${session.requestedModel.runtime}:${session.requestedModel.model}` }
    : { folder: { kind: 'auto' }, agentId: '', modelKey: defaultModelKey(snapshot.modelOptions) });
  const go = (next: V4Page) => { setPage(next); if (narrow) setNarrowOpen(false); };
  const patchPane = (id: string, patch: Partial<V4Pane>) => setPanes(previous => previous.map(pane => pane.id === id ? { ...pane, ...patch } : pane));
  const open = (sessionId: SessionId) => {
    const shown = panes.find(pane => pane.sessionId === sessionId);
    if (shown) setActivePane(shown.id);
    else if (active) patchPane(active.id, { sessionId });
    else { setPanes([{ id: 'pane-1', sessionId, details: false, tab: 'files' }]); setActivePane('pane-1'); }
    go('chat');
  };
  const split = (sessionId: SessionId) => {
    const other = panes.find(pane => pane.id !== active?.id);
    if (!active) { open(sessionId); return; }
    if (other) { patchPane(other.id, { sessionId }); setActivePane(other.id); }
    else { const id = `pane-${nextPane}`; setNextPane(nextPane + 1); setPanes([...panes, { id, sessionId, details: false, tab: 'files' }]); setActivePane(id); }
    go('chat');
  };
  const closePane = (id: string) => {
    const remaining = panes.filter(pane => pane.id !== id);
    setPanes(remaining);
    if (remaining[0]) setActivePane(remaining[0].id); else setPage('new');
  };

  let main;
  if (page === 'chat' && panes.length) main = <div className={`v4-panes ${panes.length > 1 ? 'v4-split' : ''}`}>{panes.map(pane => {
    const session = snapshot.sessions.find(item => item.id === pane.sessionId);
    const title = titles[pane.sessionId] ?? session?.title ?? pane.sessionId;
    return <Conversation key={pane.id} snapshot={snapshot} pane={pane} title={title} active={pane.id === active?.id} split={panes.length > 1}
      agents={agents} draft={drafts[pane.sessionId] ?? ''} choice={choiceFor(pane.sessionId, session)}
      editTitle={editTitle.sessionId === pane.sessionId ? editTitle.nonce : 0}
      onDraft={text => setDrafts(previous => ({ ...previous, [pane.sessionId]: text }))}
      onChoice={choice => setChoices(previous => ({ ...previous, [pane.sessionId]: choice }))}
      onPane={patch => patchPane(pane.id, patch)} onRename={name => setTitles(previous => ({ ...previous, [pane.sessionId]: name }))}
      onClose={() => closePane(pane.id)} onFocus={() => { if (pane.id !== activePane) setActivePane(pane.id); }}
      onOpen={open} onProgress={id => { setInstanceId(id); go('progress'); }} onNotice={setNotice} />;
  })}</div>;
  else if (page === 'settings') main = <SettingsV4 snapshot={snapshot} theme={theme} onTheme={setTheme} onNotice={setNotice} />;
  else if (page === 'workflow-start') main = <WorkflowStartV4 snapshot={snapshot} autoFolder={autoFolder} onNotice={setNotice} />;
  else if (page === 'progress') main = <div className="v4-page v4-page-wide"><WorkflowProgress snapshot={snapshot} instanceId={instanceId} store={undefined} ipcState={undefined} onOpen={open} onBack={() => go(active ? 'chat' : 'new')} /></div>;
  else if (page === 'agents' || page === 'templates') main = null;
  else main = <NewChat snapshot={snapshot} agents={agents} draft={drafts.new ?? ''} onDraft={text => setDrafts(previous => ({ ...previous, new: text }))}
    choice={choiceFor('new')} onChoice={choice => setChoices(previous => ({ ...previous, new: choice }))} autoFolder={autoFolder} onNotice={setNotice} />;

  return <div className={`v4-shell ${collapsed ? 'v4-collapsed' : ''} ${narrow ? 'v4-narrow' : ''}`} data-testid="shell-v4">
    <Sidebar snapshot={snapshot} titles={titles} pinned={pinned} selectedId={active?.sessionId} page={page} collapsed={collapsed} overlay={narrow} theme={theme}
      onCollapse={value => { if (narrow) setNarrowOpen(!value); else setSidebarOpen(!value); }}
      onNewChat={() => go('new')} onStartWorkflow={() => go('workflow-start')} onOpen={open} onSplit={split} onTheme={setTheme} onPage={go}
      onPin={id => setPinned(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; })}
      onRename={id => { open(id); setEditTitle(previous => ({ sessionId: id, nonce: previous.nonce + 1 })); }} />
    {narrow && narrowOpen && <div className="v4-scrim" aria-hidden="true" onClick={() => setNarrowOpen(false)} />}
    <main className="v4-main">
      {narrow && collapsed && <div className="v4-narrow-bar"><button type="button" className="v4-icon" aria-label="開啟側欄" onClick={() => setNarrowOpen(true)}>☰</button><strong>AgentWorkflowGui</strong>
        <button type="button" className="v4-icon" aria-label="新對話" onClick={() => go('new')}>＋</button></div>}
      {page === 'new' && <div className="v4-main-actions"><button type="button" onClick={() => go('workflow-start')}>開始 Workflow…</button></div>}
      {main}
      <div className="v4-page v4-page-wide" hidden={page !== 'agents'}>
        <AgentCatalog repository={agentRepository} demo={agentDemo} selectedId="" visible={page === 'agents'} onSelect={() => undefined} />
      </div>
      <div className="v4-page v4-page-wide v4-editor-page" hidden={page !== 'templates'}>
        <WorkflowEditor repository={workflowRepository} demo={workflowDemo} agents={agents} models={snapshot.modelOptions} runtimes={snapshot.runtimes}
          selectedId={snapshot.workflows[0]?.id ?? ''} visible={page === 'templates'} onSelect={() => undefined} />
      </div>
    </main>
    {notice && <div className="v4-notice" role="status"><span>{notice}</span><button type="button" className="v4-icon" aria-label="關閉提示" onClick={() => setNotice('')}>×</button></div>}
  </div>;
}
