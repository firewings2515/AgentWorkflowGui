import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { LogicalSession, SessionId, Snapshot, WorkflowInstance } from '../../../../contracts';
import { statusLabel } from '../ui';
import { readOnlyProps } from '../read-only';
import type { Theme } from '../theme';
import { archivedBusy, archiveTargetOf, childrenIndex, isArchived } from './archive';
import type { ArchivedIndex, ArchivedOpen, ArchiveTarget } from './archive';
import type { SidebarMode, V4Page } from './demo-data';
import { byLastMessage, lastMessageAt, runLastMessageAt } from './last-message';
import type { LastMessageTimes } from './last-message';
import { MenuList } from './MenuList';
import type { MenuItem } from './MenuList';
import { moveTargets } from './move-targets';
import { MovePicker } from './MovePicker';
import { useSessionDrag } from './session-drag';

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
  /** Last-message time per session (Q-17): every list is ordered by it, newest first. */
  times: LastMessageTimes;
  /** Sessions with an assistant reply not seen yet (Q-14): a blue dot at the end of the row. */
  unread: ReadonlySet<string>;
  /** The connection line at the bottom: the IPC state, or the demo note. */
  connection: ReactNode;
  /** U4 (T060): what is archived, worked out once per Snapshot by the shell. Archived items show only in 「已封存」. */
  archived: ArchivedIndex;
  /** Whether each mode's 「已封存」 section is open (closed by default, kept in localStorage by the shell). */
  archivedOpen: ArchivedOpen;
  onArchivedOpen: (mode: SidebarMode, open: boolean) => void;
  /** Archives (true) or unarchives (false) a conversation's top session or a run. */
  onArchive: (target: ArchiveTarget, archive: boolean) => void;
  /** Why archiving (true) or unarchiving (false) is disabled now; undefined when it can be sent. */
  archiveReason: (target: ArchiveTarget, archive: boolean) => string | undefined;
}

type Kids = (id: string) => readonly LogicalSession[];
const none: readonly LogicalSession[] = [];
const noKids: Kids = () => none;

/** The mark of an archived search result. */
export const ARCHIVED_TAG = '已封存';
/** On the 釘選 item of an archived item that is not pinned: it would show nowhere but in 「已封存」. */
export const ARCHIVED_PIN = '已封存的項目不能釘選，請先取消封存。';

export function Sidebar(props: SidebarProps) {
  const { snapshot, titles, mode, selectedId, collapsed } = props;
  const [query, setQuery] = useState('');
  const [closedSections, setClosedSections] = useState<Set<string>>(new Set());
  const [openRows, setOpenRows] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<ContextTarget | null>(null);
  const [renaming, setRenaming] = useState('');
  const [picker, setPicker] = useState<{ sessionId: SessionId; from: HTMLElement } | null>(null);
  // r1 P2-1: the row gets focus back only after the modal picker has closed and unmounted; until then it is inert.
  const restoreFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (picker || !restoreFocus.current) return;
    const from = restoreFocus.current;
    restoreFocus.current = null;
    if (from.isConnected) from.focus();
  }, [picker]);
  const nav = useRef<HTMLElement>(null);
  // Q-17: one ordering for every list. Filtering keeps it, so no list is sorted while rendering; a message.delta keeps
  // `sessions`, `instances` and `times` (useMessageTimes), so it does not sort again either.
  const { times } = props;
  const sortedSessions = useMemo(() => snapshot.sessions.toSorted(byLastMessage(times)), [snapshot.sessions, times]);
  const sortedRuns = useMemo(() => {
    const nodes = new Map<string, LogicalSession[]>();
    for (const session of snapshot.sessions) if (session.kind === 'workflow') nodes.set(session.workflow.instanceId, [...(nodes.get(session.workflow.instanceId) ?? []), session]);
    const at = new Map(snapshot.instances.map(instance => [instance.id, runLastMessageAt(times, instance, nodes.get(instance.id) ?? [])]));
    return snapshot.instances.toSorted((a, b) => at.get(b.id)! - at.get(a.id)! || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }, [snapshot.instances, snapshot.sessions, times]);
  const { archived } = props;
  // U4 (T060): the 「已封存」 sections, derived like the lists above: worked out again only when the sessions, runs, times
  // or what is archived change, never on a render that changes none of them (T040). Conversations go by the newest
  // message of the whole tree (Q-17, as the auto-archive does); runs keep sortedRuns' order.
  const archivedLists = useMemo(() => {
    const chatPool = archived.sessions.size ? sortedSessions.filter(session => archived.sessions.has(session.id)) : [];
    const treeAt = new Map<string, number>();
    for (const session of chatPool) {
      const top = archived.tops.get(session.id)?.id ?? session.id;
      treeAt.set(top, Math.max(treeAt.get(top) ?? -Infinity, lastMessageAt(times, session)));
    }
    const roots = chatPool.filter(session => archived.roots.has(session.id))
      .sort((a, b) => treeAt.get(b.id)! - treeAt.get(a.id)! || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const runs = archived.runs.size ? sortedRuns.filter(instance => archived.runs.has(instance.id)) : [];
    return { roots, runs, children: childrenIndex(chatPool) };
  }, [archived, sortedSessions, sortedRuns, times]);
  // The headings' running mark: sessions and running turns (r1 P2-2), apart from the lists so a turn does not sort again.
  const { turns } = snapshot;
  const archivedRunning = useMemo(() => archivedBusy(archived, { sessions: snapshot.sessions, turns }), [archived, snapshot.sessions, turns]);
  const archivedPending = useMemo(() => {
    let chat = false; let workflow = false;
    if (archived.sessions.size || archived.runs.size) for (const item of snapshot.escalations) {
      if (item.state !== 'open') continue;
      if (archived.sessions.has(item.fromSessionId)) chat = true;
      if (archived.runSessions.has(item.fromSessionId) || (item.instanceId !== undefined && archived.runs.has(item.instanceId))) workflow = true;
    }
    return { chat, workflow };
  }, [archived, snapshot.escalations]);
  const pinned = props.pinned[mode];
  const readOnly = props.readOnly ? { title: readOnlyProps(true).title } : {};
  const title = (session: LogicalSession) => titles[session.id] ?? session.title;
  const runTitle = (instance: WorkflowInstance) => titles[instance.id] ?? instance.title;
  // T056: only rows of the chat tree drag (not pinned, not search, not Workflow mode), and only while they can move.
  const inChatTree = (id: SessionId) => {
    const session = snapshot.sessions.find(item => item.id === id);
    return mode === 'chat' && !query.trim() && session?.kind === 'ordinary' && !props.pinned.chat.has(id) && !archived.sessions.has(id);
  };
  const canDrag = (id: SessionId) => !props.readOnly && !props.moveReason(id);
  const drag = useSessionDrag({
    canDrag: id => canDrag(id) && inChatTree(id),
    start: id => {
      const session = snapshot.sessions.find(item => item.id === id);
      if (session?.kind !== 'ordinary') return undefined;
      return { targets: new Set(moveTargets(snapshot, id, item => item.title, '', times).map(item => item.id)), toTop: session.parentId !== undefined };
    },
    live: current => canDrag(current.sessionId) && inChatTree(current.sessionId),
    onDrop: props.onMove,
  });
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
    key: string; data: Record<string, string>; label: string; tooltip: string; dot: string; pending: number; unread: boolean; extra?: ReactNode;
    selected: boolean; current?: boolean; defaultOpen: boolean; onOpen: () => void; menu: ContextTarget['kind'];
    /** How many children the row has; their rows are built only while it is unfolded (T060 r1 P2-1). */
    childCount: number; children: () => ReactNode[];
    /** T056: a row of the chat tree is a drag source and a drop target. */
    drag?: { source: ReturnType<typeof drag.source>; target: ReturnType<typeof drag.target>; dragging: boolean };
  }) => {
    const expanded = openRows[row.key] ?? row.defaultOpen;
    return <li key={row.key} {...row.data}>
      <div className={`v4-row ${row.selected ? 'v4-row-selected' : ''} ${row.current ? 'v4-row-current' : ''}`} {...row.drag?.target}>
        {row.childCount > 0 ? <button type="button" className="v4-row-toggle" aria-label={`${expanded ? '收合' : '展開'} ${row.label}`} aria-expanded={expanded}
          onClick={() => setOpenRows(previous => ({ ...previous, [row.key]: !expanded }))}>{expanded ? '▾' : '▸'}</button> : <span className="v4-row-spacer" />}
        {renaming === row.key ? <input className="v4-rename" aria-label="執行名稱" defaultValue={row.label} ref={input => { input?.focus(); input?.select(); }}
          onBlur={event => { const value = event.currentTarget.value.trim(); if (value && value !== row.label) props.onRenameRun(row.key, value); setRenaming(''); }}
          onKeyDown={event => {
            if (event.key === 'Enter') event.currentTarget.blur();
            else if (event.key === 'Escape') { event.stopPropagation(); event.currentTarget.value = row.label; event.currentTarget.blur(); }
          }} /> : <button type="button" className="v4-session" aria-current={row.selected ? 'true' : undefined} title={row.tooltip} onClick={row.onOpen}
          {...row.drag?.source} data-dragging={row.drag?.dragging ? 'true' : undefined}
          onContextMenu={event => { event.preventDefault(); openMenu(row.menu, row.key, event.currentTarget, event.clientX, event.clientY); }}
          onKeyDown={event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); openMenu(row.menu, row.key, event.currentTarget); } }}>
          <span className="v4-activity" data-state={row.dot} aria-hidden="true" />
          <span className="v4-session-title">{row.label}</span>
          {row.extra}
          {/* Q-14: a pending escalation's dot wins over the unread dot. */}
          {row.pending > 0 ? <span className="v4-alert" role="img" aria-label="有待處理項目" />
            : row.unread && <span className="v4-unread" role="img" aria-label="有新訊息" />}
        </button>}
      </div>
      {row.childCount > 0 && expanded && <ul>{row.children()}</ul>}
    </li>;
  };
  /**
   * `kids`: the children of a session in the list being built (none for pinned rows and search results). `tags`: small
   * labels after the title (a search result's run, 已封存). `open`: whether children start unfolded.
   */
  const sessionRow = (session: LogicalSession, kids: Kids, tags: readonly string[] = [], inTree = false, open = true): ReactNode => {
    const children = kids(session.id);
    return listRow({
    key: session.id, data: { 'data-session-id': session.id }, label: title(session), tooltip: `${title(session)} · ${statusLabel(session.activity)}`,
    dot: session.activity, pending: pendingFrom(session.id), unread: props.unread.has(session.id), selected: chatSelected === session.id, defaultOpen: open, menu: 'session',
    ...(tags.length ? { extra: <>{tags.map(tag => <span key={tag} className={`v4-row-tag ${tag === ARCHIVED_TAG ? 'v4-archived-tag' : ''}`}>{tag}</span>)}</> } : {}),
    childCount: children.length, children: () => children.map(child => sessionRow(child, kids, [], inTree, open)), onOpen: () => props.onOpen(session.id),
    ...(inTree ? { drag: { source: drag.source(session.id), target: drag.target(session.id), dragging: drag.dragging === session.id } } : {}),
    });
  };
  /** Pools come from `sortedSessions`, so roots and children are already newest first. `inTree`: the chat list's tree (T056). */
  const tree = (pool: readonly LogicalSession[], inTree = false) => {
    const index = childrenIndex(pool);
    const ids = new Set<string>(pool.map(session => session.id));
    const kids: Kids = id => index.get(id) ?? none;
    return pool.filter(session => session.parentId === undefined || !ids.has(session.parentId)).map(session => sessionRow(session, kids, [], inTree));
  };
  const runSessions = (instance: WorkflowInstance) => sortedSessions.filter(session => session.kind === 'workflow' && session.workflow.instanceId === instance.id);
  // A run row stands for its root session; its other node sessions are indented below, folded unless the selection is inside.
  const runRow = (instance: WorkflowInstance): ReactNode => {
    const status = runStatus(snapshot, instance);
    const sessions = runSessions(instance);
    // A pinned node shows in 釘選 instead, unless its run is archived (then the pin shows nowhere, T060).
    const nodes = sessions.filter(session => session.id !== instance.rootSessionId && (!pinned.has(session.id) || archived.runs.has(instance.id)));
    return listRow({
      key: instance.id, data: { 'data-run-id': instance.id, className: 'v4-run' }, label: runTitle(instance), tooltip: `${runTitle(instance)} · ${status.label}`,
      // Q-14: the run row lights up when any of its node sessions has an unseen reply.
      dot: status.state, pending: status.pending, unread: sessions.some(session => props.unread.has(session.id)), extra: <span className="v4-run-state" data-state={status.state}>{status.label}</span>,
      selected: chatSelected === instance.rootSessionId, current: selectedRun === instance.id, defaultOpen: selectedRun === instance.id, menu: 'run',
      childCount: nodes.length, children: () => tree(nodes),
      onOpen: () => props.onOpen(instance.rootSessionId),
    });
  };
  // T056: the 「移到最上層」 zone covers the list's heading while it shows, so the rows below never shift under the cursor.
  const section = (id: Section, label: string, body: ReactNode, count: number, overlay?: ReactNode) => <section className="v4-section" aria-label={label}>
    <h2>{overlay}<button type="button" aria-expanded={!closedSections.has(`${mode}:${id}`)} onClick={() => toggleSection(`${mode}:${id}`)}>
      <span>{label}</span><span className="v4-count">{count}</span><span aria-hidden="true">{closedSections.has(`${mode}:${id}`) ? '▸' : '▾'}</span></button></h2>
    {!closedSections.has(`${mode}:${id}`) && body}
  </section>;

  // Search covers both modes; opening a result switches the sidebar to that result's mode.
  const matches = query.trim() ? sortedSessions.filter(session => title(session).toLowerCase().includes(query.trim().toLowerCase())) : undefined;
  const runOf = (session: LogicalSession) => session.kind === 'workflow' ? snapshot.instances.find(instance => instance.id === session.workflow.instanceId) : undefined;
  // U4 (T060): archived items show only in 「已封存」, also when a pin of theirs was left in the preferences (T059 ★H).
  const runs = sortedRuns.filter(instance => !pinned.has(instance.id) && !archived.runs.has(instance.id));
  const chats = sortedSessions.filter(session => session.kind === 'ordinary' && !pinned.has(session.id) && !archived.sessions.has(session.id));
  // Pinned: runs first, then sessions; each group newest last message first.
  const pinnedRows = [
    ...sortedRuns.filter(instance => pinned.has(instance.id) && !archived.runs.has(instance.id)).map(runRow),
    ...sortedSessions.filter(session => pinned.has(session.id) && !archived.sessions.has(session.id) && !archived.runSessions.has(session.id)).map(session => sessionRow(session, noKids)),
  ];
  // Archived trees start folded, unless the open session is inside (as a run row does).
  const selectedTop = chatSelected && archived.sessions.has(chatSelected) ? archived.tops.get(chatSelected)?.id : undefined;
  const archivedKids: Kids = id => archivedLists.children.get(id) ?? none;
  const archivedCount = mode === 'chat' ? archivedLists.roots.length : archivedLists.runs.length;
  const archivedOpen = props.archivedOpen[mode];
  // T060 r1 P2-1: the rows are built only while the section shows and is open; closed, it costs its heading only.
  const archivedSection = () => archivedCount > 0 && <section className="v4-section v4-archived" aria-label="已封存">
    <h2><button type="button" aria-expanded={archivedOpen} onClick={() => props.onArchivedOpen(mode, !archivedOpen)}>
      <span>已封存</span>
      {archivedRunning[mode] && <span className="v4-activity" data-state="running" role="img" aria-label="已封存的項目裡有工作正在進行" />}
      {archivedPending[mode] && <span className="v4-alert" role="img" aria-label="已封存的項目有待處理項目" />}
      <span className="v4-count">{archivedCount}</span><span aria-hidden="true">{archivedOpen ? '▾' : '▸'}</span></button></h2>
    {archivedOpen && <ul className="v4-tree">{mode === 'chat'
      ? archivedLists.roots.map(root => sessionRow(root, archivedKids, [], false, root.id === selectedTop)) : archivedLists.runs.map(runRow)}</ul>}
  </section>;
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
  // U4 (T060): 封存／取消封存 only for a conversation's top session and for a run. The reasons come from the shell
  // (read-only, not synchronised, in flight, and what the Snapshot shows); the backend's answer still has the last word.
  const archiveItems = (): MenuItem[] => {
    let target: ArchiveTarget | undefined;
    if (menuRun) target = { kind: 'run', id: menuRun.id };
    else if (menuSession?.kind === 'ordinary') {
      const top = archiveTargetOf(snapshot, menuSession.id);
      if (top?.id === menuSession.id) target = top;
    }
    if (!target) return [];
    const done = target.kind === 'run' ? archived.runs.has(target.id) : archived.roots.has(target.id);
    const reason = props.archiveReason(target, !done);
    const chosen = target;
    return [{ label: done ? '取消封存' : '封存', disabled: !!reason, title: reason, onSelect: () => props.onArchive(chosen, !done) }];
  };
  const menuPinned = menu ? props.pinned[modeOf(snapshot, menu.id)].has(menu.id) : false;
  // An archived item is not pinned (it would show only in 「已封存」); a pin left behind can still be taken away.
  const pinArchived = !!menu && !menuPinned && isArchived(archived, menu.id);
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
    <nav className="v4-sections" ref={nav} aria-label={mode === 'chat' ? '對話清單' : 'Workflow 清單'} {...drag.list} onKeyDown={event => {
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
        {matches.length ? <ul className="v4-tree">{matches.map(session => {
          const run = runOf(session);
          return sessionRow(session, noKids, [...(run ? [runTitle(run)] : []), ...(archived.sessions.has(session.id) || archived.runSessions.has(session.id) ? [ARCHIVED_TAG] : [])]);
        })}</ul>
          : <p className="v4-muted v4-section-note">沒有符合的對話或 Workflow。</p>}</section> : <>
        {pinnedRows.length > 0 && section('pinned', '釘選', <ul className="v4-tree">{pinnedRows}</ul>, pinnedRows.length)}
        {mode === 'chat'
          ? section('list', '對話', chats.length ? <ul className="v4-tree">{tree(chats, true)}</ul> : <p className="v4-muted v4-section-note">還沒有對話。</p>, chats.length,
            drag.top && <div className="v4-drop-top" aria-hidden="true" {...drag.top}>移到最上層</div>)
          : section('list', '執行', runs.length ? <ul className="v4-tree">{runs.map(runRow)}</ul> : <p className="v4-muted v4-section-note">還沒有執行過 Workflow。</p>, runs.length)}
        {archivedSection()}
      </>}
    </nav>
    <div className="v4-sidebar-foot">
      <button type="button" className="v4-foot-link" aria-current={props.page === 'settings' ? 'page' : undefined} onClick={() => props.onPage('settings')}><span aria-hidden="true">⚙</span> 設定</button>
      <div className="v4-connection">{props.connection}
        <button type="button" className="v4-icon v4-theme" aria-label={props.theme === 'dark' ? '切換成淺色' : '切換成深色'} title={props.themeReason ?? '切換外觀'} disabled={!!props.themeReason} onClick={() => props.onTheme(props.theme === 'dark' ? 'light' : 'dark')}>{props.theme === 'dark' ? '☾' : '☀'}</button></div>
    </div>
    {menu && menuOpenId && <MenuList label={`${menuTitle} 的選單`} className="v4-context-menu"
      style={{ left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - (menuSession?.kind === 'ordinary' ? 290 : 215)) }}
      onClose={restore => { const from = menu.from; setMenu(null); if (restore) from.focus(); }}
      items={[
        { label: '開啟', onSelect: () => props.onOpen(menuOpenId) },
        { label: '在分割畫面開啟', disabled: menuOpenId === selectedId, onSelect: () => props.onSplit(menuOpenId) },
        { label: menuPinned ? '取消釘選' : '釘選', disabled: props.pinBlocked || pinArchived,
          title: props.pinBlocked ? props.pinReason : pinArchived ? ARCHIVED_PIN : undefined, onSelect: () => props.onPin(menu.id) },
        { label: '重新命名', disabled: props.readOnly, ...readOnly, onSelect: () => { if (menuRun) setRenaming(menuRun.id); else props.onRename(menuOpenId); } },
        ...moveItems(menuSession, menu.from),
        ...archiveItems(),
      ]} />}
    {picker && <MovePicker snapshot={snapshot} sessionId={picker.sessionId} titles={titles}
      onClose={() => { restoreFocus.current = picker.from; setPicker(null); }}
      onPick={parentId => props.onMove(picker.sessionId, parentId)} />}
  </aside>;
}
