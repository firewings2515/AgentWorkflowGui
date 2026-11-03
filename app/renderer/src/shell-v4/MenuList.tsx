import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

export interface MenuItem { label: string; onSelect: () => void; disabled?: boolean; danger?: boolean }

/** A role=menu list: focuses its first item, moves with arrows/Home/End, and closes on Esc, Tab or a click outside. */
export function MenuList({ label, items, onClose, className = '', style, autoFocus = true }: {
  label: string; items: MenuItem[]; onClose: (restoreFocus: boolean) => void; className?: string; style?: CSSProperties; autoFocus?: boolean;
}) {
  const list = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });
  useEffect(() => {
    if (autoFocus) list.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !list.current?.contains(event.target)) close.current(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [autoFocus]);
  return <div className={`v4-menu ${className}`} role="menu" aria-label={label} ref={list} style={style} onKeyDown={event => {
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(true); return; }
    if (event.key === 'Tab') { event.preventDefault(); onClose(true); return; }
    const next = event.key === 'ArrowDown' ? (current + 1) % buttons.length : event.key === 'ArrowUp' ? (current - 1 + buttons.length) % buttons.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1;
    if (next >= 0) { event.preventDefault(); buttons[next]?.focus(); }
  }}>{items.map(item => <button key={item.label} type="button" role="menuitem" className={item.danger ? 'danger' : undefined} disabled={item.disabled}
    onClick={() => { onClose(true); item.onSelect(); }}>{item.label}</button>)}</div>;
}

/** Opens on hover (the UI draft's confirmed entry for a workflow session's owner) and on click or Enter for keyboard users. */
export function HoverMenu({ label, items, children }: { label: string; items: MenuItem[]; children: ReactNode }) {
  const [open, setOpen] = useState<false | 'hover' | 'focus'>(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const hold = () => { window.clearTimeout(timer.current); setOpen(current => current || 'hover'); };
  const release = () => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setOpen(false), 200); };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return <span className="v4-hover-menu" onMouseEnter={hold} onMouseLeave={release}>
    <button type="button" ref={trigger} className="v4-workflow-badge" aria-haspopup="menu" aria-expanded={!!open} onClick={() => setOpen(open === 'focus' ? false : 'focus')}>{children}</button>
    {open && <MenuList key={open} label={label} items={items} className="v4-menu-below" autoFocus={open === 'focus'} onClose={restore => { setOpen(false); if (restore) trigger.current?.focus(); }} />}
  </span>;
}
