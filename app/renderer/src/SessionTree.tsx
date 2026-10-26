import { useRef, useState } from 'react';
import type { LogicalSession, SessionId, Snapshot } from '../../../contracts';
import { Status } from './ui';

export function SessionTree({ snapshot, demo = true, selectedId, onOpen }: { snapshot: Snapshot; demo?: boolean; selectedId: SessionId | undefined; onOpen: (id: SessionId) => void }) {
  const [mode, setMode] = useState<'ordinary' | 'workflow'>('ordinary');
  const [collapsed, setCollapsed] = useState<Set<SessionId>>(new Set());
  const tree = useRef<HTMLUListElement>(null);
  const sessions = snapshot.sessions.filter(session => session.kind === mode);
  const toggle = (id: SessionId) => setCollapsed(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const renderBranch = (session: LogicalSession) => {
    const children = sessions.filter(child => child.parentId === session.id);
    const expanded = !collapsed.has(session.id);
    return <li key={session.id} data-session-id={session.id}>
      <div className={`tree-row ${selectedId === session.id ? 'selected' : ''}`}>
        {children.length > 0 ? <button className="tree-toggle" aria-label={`${expanded ? '收合' : '展開'} ${session.title}`} aria-expanded={expanded} onClick={() => toggle(session.id)}>{expanded ? '▾' : '▸'}</button> : <span className="tree-spacer" />}
        <button className="session-link" aria-current={selectedId === session.id ? 'true' : undefined} onClick={() => onOpen(session.id)}>
          <span>{session.title}</span>{' '}<Status value={session.activity} />
        </button>
      </div>
      {children.length > 0 && expanded && <ul>{children.map(renderBranch)}</ul>}
    </li>;
  };
  return <aside className="session-sidebar" aria-label="Session 清單">
    <div className="sidebar-title"><strong>Sessions</strong><span className="count">{sessions.length}</span></div>
    <div className="segmented" aria-label="Session 檢視">
      <button aria-pressed={mode === 'ordinary'} onClick={() => setMode('ordinary')}>一般</button>
      <button aria-pressed={mode === 'workflow'} onClick={() => setMode('workflow')}>Workflow</button>
    </div>
    <p className="sidebar-note">{mode === 'ordinary' ? '開啟對話，繼續你的工作。' : '依 Workflow 建立的對話關係。'}</p>
    <ul className="session-tree" ref={tree} aria-label={mode === 'ordinary' ? '一般 sessions' : 'Workflow sessions'} onKeyDown={event => {
      if (!(event.target instanceof HTMLElement)) return;
      const item = event.target.closest<HTMLLIElement>('li[data-session-id]');
      const session = sessions.find(candidate => candidate.id === item?.dataset.sessionId);
      if (!session || !item) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (!collapsed.has(session.id) && sessions.some(child => child.parentId === session.id)) {
          toggle(session.id); item.querySelector<HTMLButtonElement>('.session-link')?.focus();
        } else item.parentElement?.closest('li')?.querySelector<HTMLButtonElement>('.session-link')?.focus();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        if (collapsed.has(session.id)) toggle(session.id);
        else item.querySelector<HTMLButtonElement>(':scope > ul .session-link')?.focus();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const buttons = Array.from(tree.current?.querySelectorAll<HTMLButtonElement>('.session-link') ?? []);
        const current = buttons.findIndex(button => button.closest('li') === item);
        buttons[current + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
      }
    }}>{sessions.filter(session => !sessions.some(parent => parent.id === session.parentId)).map(renderBranch)}</ul>
    <p className="sidebar-foot">{demo ? '示意資料 · ' : ''}{snapshot.sessions.length} 個 sessions<br />收合僅隱藏樹狀子項。</p>
  </aside>;
}
