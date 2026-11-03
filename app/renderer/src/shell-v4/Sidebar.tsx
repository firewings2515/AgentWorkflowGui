import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { LogicalSession, SessionId, Snapshot } from '../../../../contracts';
import { openEscalations } from '../EscalationPanel';
import { statusLabel } from '../ui';
import type { Theme } from '../theme';
import { byRecent } from './demo-data';
import type { V4Page } from './demo-data';
import { MenuList } from './MenuList';

interface ContextTarget { sessionId: SessionId; x: number; y: number; from: HTMLElement }
type Section = 'pinned' | 'chats' | 'runs';

export interface SidebarProps {
  snapshot: Snapshot; titles: Record<string, string>; pinned: ReadonlySet<string>; selectedId: SessionId | undefined; page: V4Page;
  collapsed: boolean; overlay: boolean; theme: Theme;
  onCollapse: (collapsed: boolean) => void; onNewChat: () => void; onStartWorkflow: () => void; onOpen: (id: SessionId) => void; onSplit: (id: SessionId) => void;
  onPin: (id: SessionId) => void; onRename: (id: SessionId) => void; onPage: (page: V4Page) => void; onTheme: (theme: Theme) => void;
}

export function Sidebar(props: SidebarProps) {
  const { snapshot, titles, pinned, selectedId, collapsed } = props;
  const [query, setQuery] = useState('');
  const [closedSections, setClosedSections] = useState<Set<Section>>(new Set());
  const [closedRows, setClosedRows] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<ContextTarget | null>(null);
  const nav = useRef<HTMLElement>(null);
  const title = (session: LogicalSession) => titles[session.id] ?? session.title;
  const toggle = <T,>(set: (update: (previous: Set<T>) => Set<T>) => void, key: T) => set(previous => {
    const next = new Set(previous);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const openMenu = (sessionId: SessionId, from: HTMLElement, x?: number, y?: number) => {
    const box = from.getBoundingClientRect();
    setMenu({ sessionId, from, x: x ?? box.left + 24, y: y ?? box.bottom });
  };

  const row = (session: LogicalSession, pool: readonly LogicalSession[]) => {
    const children = pool.filter(child => child.parentId === session.id).sort(byRecent);
    const expanded = !closedRows.has(session.id);
    const pending = openEscalations(snapshot, session.id).length;
    return <li key={session.id} data-session-id={session.id}>
      <div className={`v4-row ${selectedId === session.id && props.page === 'chat' ? 'v4-row-selected' : ''}`}>
        {children.length > 0 ? <button type="button" className="v4-row-toggle" aria-label={`${expanded ? '收合' : '展開'} ${title(session)}`} aria-expanded={expanded}
          onClick={() => toggle(setClosedRows, session.id)}>{expanded ? '▾' : '▸'}</button> : <span className="v4-row-spacer" />}
        <button type="button" className="v4-session" aria-current={selectedId === session.id && props.page === 'chat' ? 'true' : undefined}
          title={`${title(session)} · ${statusLabel(session.activity)}`}
          onClick={() => props.onOpen(session.id)}
          onContextMenu={event => { event.preventDefault(); openMenu(session.id, event.currentTarget, event.clientX, event.clientY); }}
          onKeyDown={event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); openMenu(session.id, event.currentTarget); } }}>
          <span className="v4-activity" data-state={session.activity} aria-hidden="true" />
          <span className="v4-session-title">{title(session)}</span>
          {pending > 0 && <span className="v4-pending" aria-label={`待處理 ${pending} 件`}>{pending}</span>}
        </button>
      </div>
      {children.length > 0 && expanded && <ul>{children.map(child => row(child, pool))}</ul>}
    </li>;
  };
  const tree = (pool: readonly LogicalSession[]) => pool.filter(session => !pool.some(parent => parent.id === session.parentId)).sort(byRecent).map(session => row(session, pool));
  const section = (id: Section, label: string, body: ReactNode, count: number, action?: ReactNode) => <section className="v4-section" aria-label={label}>
    <h2><button type="button" aria-expanded={!closedSections.has(id)} onClick={() => toggle(setClosedSections, id)}>
      <span>{label}</span><span className="v4-count">{count}</span><span aria-hidden="true">{closedSections.has(id) ? '▸' : '▾'}</span></button>{action}</h2>
    {!closedSections.has(id) && body}
  </section>;

  const matches = query.trim() ? snapshot.sessions.filter(session => title(session).toLowerCase().includes(query.trim().toLowerCase())).sort(byRecent) : undefined;
  const pinnedSessions = snapshot.sessions.filter(session => pinned.has(session.id));
  const chats = snapshot.sessions.filter(session => session.kind === 'ordinary' && !pinned.has(session.id));
  const menuSession = menu && snapshot.sessions.find(session => session.id === menu.sessionId);

  if (collapsed && !props.overlay) return <aside className="v4-sidebar v4-rail" aria-label="側欄（已收合）">
    <button type="button" className="v4-icon" aria-label="展開側欄" title="展開側欄" onClick={() => props.onCollapse(false)}>☰</button>
    <button type="button" className="v4-icon" aria-label="新對話" title="新對話" onClick={props.onNewChat}>＋</button>
  </aside>;
  if (collapsed) return null;

  return <aside className={`v4-sidebar ${props.overlay ? 'v4-sidebar-overlay' : ''}`} aria-label="側欄" onKeyDown={event => {
    if (event.key === 'Escape' && props.overlay && !menu) props.onCollapse(true);
  }}>
    <div className="v4-sidebar-top">
      <strong className="v4-brand"><span aria-hidden="true">≋</span> AgentWorkflowGui</strong>
      <button type="button" className="v4-icon" aria-label="收合側欄" title="收合側欄" onClick={() => props.onCollapse(true)}>«</button>
    </div>
    <button type="button" className={`v4-new ${props.page === 'new' ? 'v4-new-active' : ''}`} onClick={props.onNewChat}><span aria-hidden="true">＋</span> 新對話</button>
    <label className="v4-search"><span className="sr-only">搜尋對話</span><span aria-hidden="true">⌕</span>
      <input type="search" placeholder="搜尋對話" value={query} onChange={event => setQuery(event.target.value)} /></label>
    <nav className="v4-sections" ref={nav} aria-label="對話清單" onKeyDown={event => {
      if (!(event.target instanceof HTMLElement) || !event.target.classList.contains('v4-session')) return;
      const item = event.target.closest<HTMLLIElement>('li[data-session-id]');
      if (!item) return;
      const id = item.dataset.sessionId!;
      const hasChildren = !!item.querySelector(':scope > .v4-row > .v4-row-toggle');
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const buttons = Array.from(nav.current?.querySelectorAll<HTMLButtonElement>('.v4-session') ?? []);
        buttons[buttons.indexOf(event.target as HTMLButtonElement) + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (hasChildren && !closedRows.has(id)) toggle(setClosedRows, id);
        else item.parentElement?.closest('li')?.querySelector<HTMLButtonElement>('.v4-session')?.focus();
      } else if (event.key === 'ArrowRight' && hasChildren) {
        event.preventDefault();
        if (closedRows.has(id)) toggle(setClosedRows, id); else item.querySelector<HTMLButtonElement>(':scope > ul .v4-session')?.focus();
      }
    }}>
      {matches ? <section className="v4-section" aria-label="搜尋結果"><h2 className="v4-section-plain">搜尋結果 <span className="v4-count">{matches.length}</span></h2>
        {matches.length ? <ul className="v4-tree">{matches.map(session => row(session, []))}</ul> : <p className="v4-muted v4-section-note">沒有符合的對話。</p>}</section> : <>
        {pinnedSessions.length > 0 && section('pinned', '釘選', <ul className="v4-tree">{pinnedSessions.sort(byRecent).map(session => row(session, []))}</ul>, pinnedSessions.length)}
        {section('chats', '對話', chats.length ? <ul className="v4-tree">{tree(chats)}</ul> : <p className="v4-muted v4-section-note">還沒有對話。</p>, chats.length)}
        {section('runs', 'Workflow 執行', <ul className="v4-tree">{snapshot.instances.map(instance => {
          const sessions = snapshot.sessions.filter(session => session.kind === 'workflow' && session.workflow.instanceId === instance.id && !pinned.has(session.id));
          const open = !closedRows.has(instance.id);
          return <li key={instance.id} className="v4-run">
            <div className="v4-row"><button type="button" className="v4-row-toggle" aria-label={`${open ? '收合' : '展開'} ${instance.title}`} aria-expanded={open} onClick={() => toggle(setClosedRows, instance.id)}>{open ? '▾' : '▸'}</button>
              <span className="v4-run-title">{instance.title}</span><span className="v4-muted v4-run-state">{statusLabel(instance.state)}</span></div>
            {open && <ul>{tree(sessions)}</ul>}
          </li>;
        })}</ul>, snapshot.instances.length,
          <button type="button" className="v4-icon v4-section-action" aria-label="開始 Workflow" title="開始 Workflow" onClick={props.onStartWorkflow}>＋</button>)}
      </>}
    </nav>
    <div className="v4-sidebar-foot">
      {([['templates', 'Workflow 模板', '⧉'], ['agents', 'Agent', '◎'], ['settings', '設定', '⚙']] as const).map(([page, label, icon]) =>
        <button type="button" key={page} className="v4-foot-link" aria-current={props.page === page ? 'page' : undefined} onClick={() => props.onPage(page)}><span aria-hidden="true">{icon}</span> {label}</button>)}
      <div className="v4-connection"><span className="v4-dot" aria-hidden="true" /> 示意模式 · 未連接 runtime
        <button type="button" className="v4-icon v4-theme" aria-label={props.theme === 'dark' ? '切換成淺色' : '切換成深色'} title="切換外觀" onClick={() => props.onTheme(props.theme === 'dark' ? 'light' : 'dark')}>{props.theme === 'dark' ? '☾' : '☀'}</button></div>
    </div>
    {menu && menuSession && <MenuList label={`${title(menuSession)} 的選單`} className="v4-context-menu"
      style={{ left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - 180) }}
      onClose={restore => { const from = menu.from; setMenu(null); if (restore) from.focus(); }}
      items={[
        { label: '開啟', onSelect: () => props.onOpen(menuSession.id) },
        { label: '在分割畫面開啟', disabled: menuSession.id === selectedId, onSelect: () => props.onSplit(menuSession.id) },
        { label: pinned.has(menuSession.id) ? '取消釘選' : '釘選', onSelect: () => props.onPin(menuSession.id) },
        { label: '重新命名', onSelect: () => props.onRename(menuSession.id) },
      ]} />}
  </aside>;
}
