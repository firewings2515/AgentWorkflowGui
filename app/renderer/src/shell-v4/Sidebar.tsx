import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { LogicalSession, SessionId, Snapshot, WorkflowInstance } from '../../../../contracts';
import { statusLabel } from '../ui';
import { readOnlyProps } from '../read-only';
import type { Theme } from '../theme';
import { byRecent } from './demo-data';
import type { SidebarMode, V4Page } from './demo-data';
import { MenuList } from './MenuList';
import type { MenuItem } from './MenuList';
import { MovePicker } from './MovePicker';

// REVISION_V0_4 §3.1 / Q-9: one sidebar with a 對話｜Workflow switch on top. Both modes share the same parts and
// behaviour (＋, search, pinned, list, context menu, keys, rail, overlay); only the ＋ action and the list differ.

interface ContextTarget { kind: 'session' | 'run'; id: string; x: number; y: number; from: HTMLElement }
type Section = 'pinned' | 'list';

const modeLabels: Record<SidebarMode, string> = { chat: '對話', workflow: 'Workflow' };

/** A run's state in the list (U2_PLAN §2, Q-12): an open escalation is 等待核准; `blocked` is 卡住, in red. */
export function runStatus(snapshot: Snapshot, instance: WorkflowInstance) {
  const pending = snapshot.escalations.filter(item => item.state === 'open' && item.instanceId === instance.id).length;
  const state = instance.state === 'running' && pending ? 'waiting' : instance.state;
  const label = { running: '執行中', waiting: '等待核准', completed: '完成', blocked: '卡住', cancelled: '已取消' }[state];
  return { state, label, pending };
}

export const modeOf = (snapshot: Snapshot, id: string): SidebarMode =>
  snapshot.instances.some(instance => instance.id === id) || snapshot.sessions.find(session => session.id === id)?.kind === 'workflow' ? 'workflow' : 'chat';

export interface SidebarProps {
  snapshot: Snapshot; titles: Record<string, string>; pinned: Record<SidebarMode, ReadonlySet<string>>; mode: SidebarMode;
  selectedId: SessionId | undefined; page: V4Page; collapsed: boolean; overlay: boolean; theme: Theme;
  onMode: (mode: SidebarMode) => void; onCollapse: (collapsed: boolean) => void; onNewChat: () => void; onStartWorkflow: () => void;
  onOpen: (id: SessionId) => void; onSplit: (id: SessionId) => void; onPin: (id: string) => void; onRename: (id: SessionId) => void;
  onRenameRun: (id: string, title: string) => void; onPage: (page: V4Page) => void; onTheme: (theme: Theme) => void;
  /** WB-04 (T053): move an ordinary session below another one, or to the top with null. */
  onMove: (id: SessionId, parentId: SessionId | null) => void;
  /** Why moving this session is disabled now (read-only, not synchronised, a move in flight or unconfirmed); undefined when it can move. */
  moveReason: (id: SessionId) => string | undefined;
  /** Read-only data (T040): pinning and renaming are shown but disabled, with the reason. */
  readOnly: boolean;
  /** Pinning cannot be saved now (read-only, not synchronised, or a preferences change in flight). */
  pinBlocked: boolean;
  /** Why pinning is disabled, shown on the menu item (read-only, saving, not synchronised). */
  pinReason?: string | undefined;
  /** Why the theme cannot change now; undefined when it can. */
  themeReason?: string | undefined;
  /** The connection line at the bottom: the IPC state, or the demo note. */
  connection: ReactNode;
}

export function Sidebar(props: SidebarProps) {
  const { snapshot, titles, mode, selectedId, collapsed } = props;
  const [query, setQuery] = useState('');
  const [closedSections, setClosedSections] = useState<Set<string>>(new Set());
  const [openRows, setOpenRows] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<ContextTarget | null>(null);
  const [renaming, setRenaming] = useState('');
  const [picker, setPicker] = useState<{ sessionId: SessionId; from: HTMLElement } | null>(null);
  const nav = useRef<HTMLElement>(null);
  const pinned = props.pinned[mode];
  const readOnly = props.readOnly ? { title: readOnlyProps(true).title } : {};
  const title = (session: LogicalSession) => titles[session.id] ?? session.title;
  const runTitle = (instance: WorkflowInstance) => titles[instance.id] ?? instance.title;
  const chatSelected = props.page === 'chat' ? selectedId : undefined;
  const selectedSession = snapshot.sessions.find(session => session.id === chatSelected);
  const selectedRun = selectedSession?.kind === 'workflow' ? selectedSession.workflow.instanceId : undefined;
  const toggleSection = (key: string) => setClosedSections(previous => {
    const next = new Set(previous);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const openMenu = (kind: ContextTarget['kind'], id: string, from: HTMLElement, x?: number, y?: number) => {
    const box = from.getBoundingClientRect();
    setMenu({ kind, id, from, x: x ?? box.left + 24, y: y ?? box.bottom });
  };
  const pendingFrom = (id: string) => snapshot.escalations.filter(item => item.state === 'open' && item.fromSessionId === id).length;
  const pendingIn = (value: SidebarMode) => snapshot.escalations.filter(item => item.state === 'open' && modeOf(snapshot, item.fromSessionId) === value).length;

  /** One list row, the same for a chat, a node session and a run: toggle, main button, children. Pending items show as a dot, not a count. */
  const listRow = (row: {
    key: string; data: Record<string, string>; label: string; tooltip: string; dot: string; pending: number; extra?: ReactNode;
    selected: boolean; current?: boolean; children: ReactNode[]; defaultOpen: boolean; onOpen: () => void; menu: ContextTarget['kind'];
  }) => {
    const expanded = openRows[row.key] ?? row.defaultOpen;
    return <li key={row.key} {...row.data}>
      <div className={`v4-row ${row.selected ? 'v4-row-selected' : ''} ${row.current ? 'v4-row-current' : ''}`}>
        {row.children.length > 0 ? <button type="button" className="v4-row-toggle" aria-label={`${expanded ? '收合' : '展開'} ${row.label}`} aria-expanded={expanded}
          onClick={() => setOpenRows(previous => ({ ...previous, [row.key]: !expanded }))}>{expanded ? '▾' : '▸'}</button> : <span className="v4-row-spacer" />}
        {renaming === row.key ? <input className="v4-rename" aria-label="執行名稱" defaultValue={row.label} ref={input => { input?.focus(); input?.select(); }}
          onBlur={event => { const value = event.currentTarget.value.trim(); if (value && value !== row.label) props.onRenameRun(row.key, value); setRenaming(''); }}
          onKeyDown={event => {
            if (event.key === 'Enter') event.currentTarget.blur();
            else if (event.key === 'Escape') { event.stopPropagation(); event.currentTarget.value = row.label; event.currentTarget.blur(); }
          }} /> : <button type="button" className="v4-session" aria-current={row.selected ? 'true' : undefined} title={row.tooltip} onClick={row.onOpen}
          onContextMenu={event => { event.preventDefault(); openMenu(row.menu, row.key, event.currentTarget, event.clientX, event.clientY); }}
          onKeyDown={event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); openMenu(row.menu, row.key, event.currentTarget); } }}>
          <span className="v4-activity" data-state={row.dot} aria-hidden="true" />
          <span className="v4-session-title">{row.label}</span>
          {row.extra}
          {row.pending > 0 && <span className="v4-alert" role="img" aria-label="有待處理項目" />}
        </button>}
      </div>
      {row.children.length > 0 && expanded && <ul>{row.children}</ul>}
    </li>;
  };
  const sessionRow = (session: LogicalSession, pool: readonly LogicalSession[], tag?: string): ReactNode => listRow({
    key: session.id, data: { 'data-session-id': session.id }, label: title(session), tooltip: `${title(session)} · ${statusLabel(session.activity)}`,
    dot: session.activity, pending: pendingFrom(session.id), selected: chatSelected === session.id, defaultOpen: true, menu: 'session',
    ...(tag ? { extra: <span className="v4-row-tag">{tag}</span> } : {}),
    children: pool.filter(child => child.parentId === session.id).sort(byRecent).map(child => sessionRow(child, pool)), onOpen: () => props.onOpen(session.id),
  });
  const tree = (pool: readonly LogicalSession[]) => pool.filter(session => !pool.some(parent => parent.id === session.parentId)).sort(byRecent).map(session => sessionRow(session, pool));
  const runSessions = (instance: WorkflowInstance) => snapshot.sessions.filter(session => session.kind === 'workflow' && session.workflow.instanceId === instance.id);
  const lastActive = (instance: WorkflowInstance) => runSessions(instance).reduce((latest, session) => session.updatedAt > latest ? session.updatedAt : latest, instance.createdAt);
  // A run row stands for its root session; its other node sessions are indented below, folded unless the selection is inside.
  const runRow = (instance: WorkflowInstance): ReactNode => {
    const status = runStatus(snapshot, instance);
    const nodes = runSessions(instance).filter(session => session.id !== instance.rootSessionId && !pinned.has(session.id));
    return listRow({
      key: instance.id, data: { 'data-run-id': instance.id, className: 'v4-run' }, label: runTitle(instance), tooltip: `${runTitle(instance)} · ${status.label}`,
      dot: status.state, pending: status.pending, extra: <span className="v4-run-state" data-state={status.state}>{status.label}</span>,
      selected: chatSelected === instance.rootSessionId, current: selectedRun === instance.id, defaultOpen: selectedRun === instance.id, menu: 'run',
      children: tree(nodes),
      onOpen: () => props.onOpen(instance.rootSessionId),
    });
  };
  const section = (id: Section, label: string, body: ReactNode, count: number) => <section className="v4-section" aria-label={label}>
    <h2><button type="button" aria-expanded={!closedSections.has(`${mode}:${id}`)} onClick={() => toggleSection(`${mode}:${id}`)}>
      <span>{label}</span><span className="v4-count">{count}</span><span aria-hidden="true">{closedSections.has(`${mode}:${id}`) ? '▸' : '▾'}</span></button></h2>
    {!closedSections.has(`${mode}:${id}`) && body}
  </section>;

  // Search covers both modes; opening a result switches the sidebar to that result's mode.
  const matches = query.trim() ? snapshot.sessions.filter(session => title(session).toLowerCase().includes(query.trim().toLowerCase())).sort(byRecent) : undefined;
  const runOf = (session: LogicalSession) => session.kind === 'workflow' ? snapshot.instances.find(instance => instance.id === session.workflow.instanceId) : undefined;
  const runs = snapshot.instances.filter(instance => !pinned.has(instance.id)).sort((a, b) => lastActive(b).localeCompare(lastActive(a)));
  const chats = snapshot.sessions.filter(session => session.kind === 'ordinary' && !pinned.has(session.id));
  const pinnedRows = [
    ...snapshot.instances.filter(instance => pinned.has(instance.id)).map(runRow),
    ...snapshot.sessions.filter(session => pinned.has(session.id)).sort(byRecent).map(session => sessionRow(session, [])),
  ];
  const menuSession = menu?.kind === 'session' ? snapshot.sessions.find(session => session.id === menu.id) : undefined;
  const menuRun = menu?.kind === 'run' ? snapshot.instances.find(instance => instance.id === menu.id) : undefined;
  const menuOpenId = menuSession?.id ?? menuRun?.rootSessionId;
  const menuTitle = menuSession ? title(menuSession) : menuRun ? runTitle(menuRun) : '';
  // WB-04: only an ordinary session moves in the tree, wherever its row is (list, pinned, search in either mode).
  const moveItems = (session: LogicalSession | undefined, from: HTMLElement): MenuItem[] => {
    if (session?.kind !== 'ordinary') return [];
    const reason = props.moveReason(session.id);
    const below: MenuItem = { label: '移到…底下', disabled: !!reason, title: reason, onSelect: () => setPicker({ sessionId: session.id, from }) };
    return session.parentId === undefined ? [below] : [below, { label: '移到最上層', disabled: !!reason, title: reason, onSelect: () => props.onMove(session.id, null) }];
  };
  const add = mode === 'chat' ? { label: '新對話', onClick: props.onNewChat, active: props.page === 'new' } : { label: '開始 Workflow', onClick: props.onStartWorkflow, active: props.page === 'workflow-start' };

  if (collapsed && !props.overlay) return <aside className="v4-sidebar v4-rail" aria-label="側欄（已收合）">
    <button type="button" className="v4-icon" aria-label="展開側欄" title="展開側欄" onClick={() => props.onCollapse(false)}>☰</button>
    <button type="button" className="v4-icon" aria-label={add.label} title={add.label} onClick={add.onClick}>＋</button>
  </aside>;
  if (collapsed) return null;

  return <aside className={`v4-sidebar ${props.overlay ? 'v4-sidebar-overlay' : ''}`} aria-label="側欄" onKeyDown={event => {
    if (event.key === 'Escape' && props.overlay && !menu && !picker) props.onCollapse(true);
  }}>
    <div className="v4-sidebar-top">
      <div className="v4-mode" role="group" aria-label="側欄模式">
        {(['chat', 'workflow'] as const).map(value => {
          const count = value === mode ? 0 : pendingIn(value);
          return <button type="button" key={value} aria-pressed={value === mode} aria-label={count ? `${modeLabels[value]}，有待處理項目` : modeLabels[value]}
            onClick={() => props.onMode(value)}>{modeLabels[value]}{count > 0 && <span className="v4-alert" aria-hidden="true" />}</button>;
        })}
      </div>
      <button type="button" className="v4-icon" aria-label="收合側欄" title="收合側欄" onClick={() => props.onCollapse(true)}>«</button>
    </div>
    <button type="button" className={`v4-new ${add.active ? 'v4-new-active' : ''}`} onClick={add.onClick}><span aria-hidden="true">＋</span> {add.label}</button>
    <label className="v4-search"><span className="sr-only">搜尋對話與 Workflow</span><span aria-hidden="true">⌕</span>
      <input type="search" placeholder="搜尋" value={query} onChange={event => setQuery(event.target.value)} /></label>
    {mode === 'workflow' && <div className="v4-mode-links">
      {([['templates', '模板', '⧉'], ['agents', 'Agent', '◎']] as const).map(([page, label, icon]) =>
        <button type="button" key={page} className="v4-foot-link" aria-current={props.page === page ? 'page' : undefined} onClick={() => props.onPage(page)}><span aria-hidden="true">{icon}</span> {label}</button>)}
    </div>}
    <nav className="v4-sections" ref={nav} aria-label={mode === 'chat' ? '對話清單' : 'Workflow 清單'} onKeyDown={event => {
      if (!(event.target instanceof HTMLElement) || !event.target.classList.contains('v4-session')) return;
      const item = event.target.closest<HTMLLIElement>('li');
      const toggle = item?.querySelector<HTMLButtonElement>(':scope > .v4-row > .v4-row-toggle');
      const expanded = toggle?.getAttribute('aria-expanded') === 'true';
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const buttons = Array.from(nav.current?.querySelectorAll<HTMLButtonElement>('.v4-session') ?? []);
        buttons[buttons.indexOf(event.target as HTMLButtonElement) + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (toggle && expanded) toggle.click();
        else item?.parentElement?.closest('li')?.querySelector<HTMLButtonElement>('.v4-session')?.focus();
      } else if (event.key === 'ArrowRight' && toggle) {
        event.preventDefault();
        if (!expanded) toggle.click(); else item?.querySelector<HTMLButtonElement>(':scope > ul .v4-session')?.focus();
      }
    }}>
      {matches ? <section className="v4-section" aria-label="搜尋結果"><h2 className="v4-section-plain">搜尋結果 <span className="v4-count">{matches.length}</span></h2>
        {matches.length ? <ul className="v4-tree">{matches.map(session => sessionRow(session, [], runOf(session) && runTitle(runOf(session)!)))}</ul>
          : <p className="v4-muted v4-section-note">沒有符合的對話或 Workflow。</p>}</section> : <>
        {pinnedRows.length > 0 && section('pinned', '釘選', <ul className="v4-tree">{pinnedRows}</ul>, pinnedRows.length)}
        {mode === 'chat'
          ? section('list', '對話', chats.length ? <ul className="v4-tree">{tree(chats)}</ul> : <p className="v4-muted v4-section-note">還沒有對話。</p>, chats.length)
          : section('list', '執行', runs.length ? <ul className="v4-tree">{runs.map(runRow)}</ul> : <p className="v4-muted v4-section-note">還沒有執行過 Workflow。</p>, runs.length)}
      </>}
    </nav>
    <div className="v4-sidebar-foot">
      <button type="button" className="v4-foot-link" aria-current={props.page === 'settings' ? 'page' : undefined} onClick={() => props.onPage('settings')}><span aria-hidden="true">⚙</span> 設定</button>
      <div className="v4-connection">{props.connection}
        <button type="button" className="v4-icon v4-theme" aria-label={props.theme === 'dark' ? '切換成淺色' : '切換成深色'} title={props.themeReason ?? '切換外觀'} disabled={!!props.themeReason} onClick={() => props.onTheme(props.theme === 'dark' ? 'light' : 'dark')}>{props.theme === 'dark' ? '☾' : '☀'}</button></div>
    </div>
    {menu && menuOpenId && <MenuList label={`${menuTitle} 的選單`} className="v4-context-menu"
      style={{ left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - (menuSession?.kind === 'ordinary' ? 250 : 180)) }}
      onClose={restore => { const from = menu.from; setMenu(null); if (restore) from.focus(); }}
      items={[
        { label: '開啟', onSelect: () => props.onOpen(menuOpenId) },
        { label: '在分割畫面開啟', disabled: menuOpenId === selectedId, onSelect: () => props.onSplit(menuOpenId) },
        { label: props.pinned[modeOf(snapshot, menu.id)].has(menu.id) ? '取消釘選' : '釘選', disabled: props.pinBlocked, title: props.pinBlocked ? props.pinReason : undefined, onSelect: () => props.onPin(menu.id) },
        { label: '重新命名', disabled: props.readOnly, ...readOnly, onSelect: () => { if (menuRun) setRenaming(menuRun.id); else props.onRename(menuOpenId); } },
        ...moveItems(menuSession, menu.from),
      ]} />}
    {picker && <MovePicker snapshot={snapshot} sessionId={picker.sessionId} titles={titles}
      onClose={() => { const from = picker.from; setPicker(null); if (from.isConnected) from.focus(); }}
      onPick={parentId => props.onMove(picker.sessionId, parentId)} />}
  </aside>;
}
