import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { LogicalSession, SessionId, Snapshot } from '../../../../contracts';
import { lastMessageTimes } from './last-message';
import { moveTargets } from './move-targets';

/**
 * 「移到…底下」 (WB-04, T053): a search box over the ordinary sessions the session can move below, newest last message
 * first. Focus stays in the box; ↑↓ choose, Enter confirms, Esc closes. Titles are text, never markup (T042).
 */
export function MovePicker({ snapshot, sessionId, titles, onPick, onClose }: {
  snapshot: Snapshot; sessionId: SessionId; titles: Record<string, string>;
  onPick: (parentId: SessionId) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const [query, setQuery] = useState('');
  // The choice is kept by ID: when the list changes (search, a Snapshot update) it stays if still there, else the first.
  const [activeId, setActiveId] = useState<string>();
  const ids = useId();
  const { sessions, messages } = snapshot;
  const moving = sessions.find(session => session.id === sessionId);
  const times = useMemo(() => lastMessageTimes({ messages }), [messages]);
  const targets = useMemo(() => moveTargets({ sessions, messages }, sessionId, (session: LogicalSession) => titles[session.id] ?? session.title, query, times),
    [sessions, messages, sessionId, titles, query, times]);
  const index = Math.max(0, targets.findIndex(session => session.id === activeId));
  const active = targets[index];
  const name = (session: LogicalSession) => titles[session.id] ?? session.title;
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });

  useEffect(() => {
    const element = dialog.current;
    if (element?.showModal) element.showModal(); else element?.setAttribute('open', '');
    // autoFocus ran before the dialog was open; the menu item that opened it gave focus back to the row meanwhile.
    search.current?.focus();
  }, []);
  // The session went away or cannot move any more: nothing to choose for.
  const gone = moving?.kind !== 'ordinary';
  useEffect(() => { if (gone) close.current(); }, [gone]);

  const finish = (target?: LogicalSession) => {
    if (done.current) return;
    done.current = true;
    onClose();
    if (target) onPick(target.id);
  };
  const heading = `${ids}-heading`;
  const option = (at: number) => `${ids}-option-${at}`;
  return <dialog ref={dialog} className="v4-move-picker" aria-labelledby={heading}
    onCancel={event => { event.preventDefault(); finish(); }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(); } }}>
    <h2 id={heading}>把「{moving ? name(moving) : ''}」移到…底下</h2>
    <input type="search" className="v4-move-search" role="combobox" aria-label="搜尋對話" aria-expanded="true" aria-autocomplete="list"
      aria-controls={`${ids}-list`} aria-activedescendant={active ? option(index) : undefined} placeholder="搜尋對話" ref={search} value={query}
      onChange={event => setQuery(event.target.value)}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const next = targets[Math.min(targets.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))];
          if (next) setActiveId(next.id);
        } else if (event.key === 'Enter') {
          event.preventDefault();
          if (!event.repeat && !event.nativeEvent.isComposing && active) finish(active);
        }
      }} />
    {targets.length ? <ul id={`${ids}-list`} className="v4-move-list" role="listbox" aria-label="可以移過去的對話">
      {targets.map((session, at) => <li key={session.id} id={option(at)} role="option" aria-selected={at === index}
        onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActiveId(session.id)} onClick={() => finish(session)}>{name(session)}</li>)}
    </ul> : <p id={`${ids}-list`} className="v4-muted" role="status">沒有可以移過去的對話</p>}
    <div className="v4-move-actions"><button type="button" onClick={() => finish()}>取消</button></div>
  </dialog>;
}
