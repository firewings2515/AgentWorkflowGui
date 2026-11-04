import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { LogicalSession, Message, SessionItem } from '../../../contracts';
import { formatTime, Status } from './ui';
import type { TranscriptPosition } from './shell-v4/pane-state';

/** One row of the conversation: a message, or consecutive tool calls folded into one group (T047). */
export type TimelineEntry = { kind: 'message'; id: string; message: Message } | { kind: 'tools'; id: string; items: SessionItem[] };

/** Messages and tool calls in time order; consecutive tool calls fold into one group. Both inputs are main-conversation only. */
export function timeline(messages: readonly Message[], items: readonly SessionItem[] = []): TimelineEntry[] {
  if (!items.length) return messages.map(message => ({ kind: 'message', id: message.id, message }));
  const byTime = [...items].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const entries: TimelineEntry[] = [];
  let next = 0;
  const itemsBefore = (at: string | undefined) => {
    while (next < byTime.length && (at === undefined || byTime[next]!.startedAt < at)) {
      const item = byTime[next++]!;
      const last = entries.at(-1);
      if (last?.kind === 'tools') last.items.push(item); else entries.push({ kind: 'tools', id: `tools:${item.id}`, items: [item] });
    }
  };
  for (const message of messages) { itemsBefore(message.createdAt); entries.push({ kind: 'message', id: message.id, message }); }
  itemsBefore(undefined);
  return entries;
}

function toolTitle(item: SessionItem) {
  switch (item.kind) {
    case 'command': return `執行 ${item.command}`;
    case 'fileChange': return `修改 ${item.changes.length} 個檔案`;
    case 'toolCall': return `${item.tool} · ${item.summary}`;
  }
}

/** Tool calls start folded (REVISION_V0_4 §3.1); a folded group renders only its summary, so long conversations stay light. */
const ToolGroup = memo(function ToolGroup({ items }: { items: SessionItem[] }) {
  const [open, setOpen] = useState(false);
  return <details className="v4-tools" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><span aria-hidden="true">⚙</span> {items.length === 1 ? toolTitle(items[0]!) : `使用了 ${items.length} 個工具`}</summary>
    {open && <ul>{items.map(item => <li key={item.id}><details className="v4-tool">
      <summary>{toolTitle(item)} <Status value={item.state} /></summary>
      {item.kind === 'command' && <><p className="v4-tool-meta">資料夾 <code>{item.cwd}</code>{item.exitCode !== undefined && <> · 結束碼 {item.exitCode}</>}</p>{item.output && <pre>{item.output}</pre>}</>}
      {item.kind === 'fileChange' && <ul className="v4-files">{item.changes.map(change => <li key={change.path}><span className={`v4-change v4-change-${change.change}`}>{change.change === 'add' ? '新增' : change.change === 'delete' ? '刪除' : '修改'}</span> <code>{change.path}</code></li>)}</ul>}
      {item.kind === 'toolCall' && <p className="v4-tool-meta">{item.server ? `${item.server} · ` : ''}{item.summary}</p>}
    </details></li>)}</ul>}
  </details>;
});

const MessageView = memo(function MessageView({ message, sessions, runtime }: { message: Message; sessions: LogicalSession[]; runtime: string }) {
  const fromUser = message.role === 'user' && message.origin.kind === 'user';
  const source = 'fromSessionId' in message.origin ? message.origin : undefined;
  const sourceTitle = source && (sessions.find(item => item.id === source.fromSessionId)?.title ?? source.fromSessionId);
  const label = source ? `${source.kind === 'transfer' ? '轉交自' : '來自'} ${sourceTitle}` : message.role === 'user' ? '訊息' : '';
  return <article className={`v4-message v4-${message.role} ${fromUser ? 'v4-from-user' : ''}`} data-origin={message.origin.kind}>
    {!fromUser && label && <p className="v4-origin">{label}</p>}
    <p className="v4-text">{message.text}</p>
    {message.observedModel && runtime === 'claude' && <small className="v4-muted v4-observed">訊息回報 · {message.observedModel}</small>}
    {message.attachments.length > 0 && <ul className="v4-attachments">{message.attachments.map(item => <li key={`${item.kind}:${item.path}`}><span aria-hidden="true">{item.kind === 'folder' ? '▤' : '▧'}</span> {item.name}</li>)}</ul>}
    <time className="v4-time" dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
  </article>;
});

export function rowAt(offsets: number[], offset: number): number {
  let low = 0; let high = Math.max(0, offsets.length - 2);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((offsets[mid] ?? 0) <= offset) low = mid; else high = mid - 1;
  }
  return low;
}

/** Variable-height window with measured rows and an ID-based reading anchor.
 * The browser's scroll anchoring is disabled to avoid applying the correction twice. */
interface WindowProps {
  sessions: LogicalSession[]; runtime: string;
  scroll: RefObject<HTMLDivElement | null>; visible: boolean;
  initialPosition?: TranscriptPosition | undefined;
  onPosition?: ((reading: TranscriptPosition, scrollTop: number) => void) | undefined;
}

/** The conversation as timeline rows (messages and folded tool groups). A message row keeps its message ID, so reading anchors stay message IDs. */
export const VirtualMessages = memo(function VirtualMessages({ messages, items, ...rest }: WindowProps & { messages: Message[]; items?: SessionItem[] | undefined }) {
  const entries = useMemo(() => timeline(messages, items), [messages, items]);
  return <VirtualRows messages={entries} total={messages.length} {...rest} />;
});

// T041: the window keeps measured row heights, the reading anchor and the follow state in refs on purpose, read during
// render and written by scroll handlers, so a re-render never loses or re-applies a scroll correction.
const VirtualRows = memo(function VirtualRows({ messages, total, sessions, runtime, scroll, visible, initialPosition, onPosition }: WindowProps & { messages: TimelineEntry[]; total: number }) {
  const list = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const anchor = useRef(initialPosition?.anchor ?? null);
  const following = useRef(initialPosition?.following ?? true);
  const touchY = useRef<number | undefined>(undefined);
  const report = useRef(onPosition);
  const lastReport = useRef('');
  const jump = useRef<() => void>(() => {});
  const [showLatest, setShowLatest] = useState(!following.current);
  useLayoutEffect(() => { report.current = onPosition; });
  const [measurement, setMeasurement] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 500 });
  const offsets = useMemo(() => {
    void measurement;
    const result = [0];
    for (const message of messages) result.push(result[result.length - 1]! + (heights.current.get(message.id) ?? 140));
    return result;
  // measurement is the revision of the measured-height cache.
  }, [messages, measurement]);
  const start = Math.max(0, rowAt(offsets, Math.max(0, viewport.top - 400)));
  const end = Math.min(messages.length, rowAt(offsets, viewport.top + viewport.height + 400) + 1);
  useLayoutEffect(() => {
    const root = list.current;
    // On first mount the parent's ref may attach after this child's layout effect.
    const element = scroll.current ?? root?.closest<HTMLElement>('[data-scroll-root]') ?? root?.parentElement;
    if (!element || !root || !visible) return;
    const origin = () => root.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop;
    const update = () => {
      const top = element.scrollTop - origin();
      const index = rowAt(offsets, top);
      anchor.current = messages[index] ? { id: messages[index].id, offset: top - offsets[index]! } : null;
      setViewport(previous => previous.top === top && previous.height === element.clientHeight ? previous : { top, height: element.clientHeight || 500 });
      setShowLatest(!following.current);
      const reading = { anchor: anchor.current, following: following.current };
      const signature = JSON.stringify([reading, element.scrollTop]);
      if (signature !== lastReport.current) {
        lastReport.current = signature;
        report.current?.(reading, element.scrollTop);
      }
    };
    let lastTop = element.scrollTop;
    const restore = () => {
      if (following.current) element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
      else if (anchor.current) {
        const index = messages.findIndex(m => m.id === anchor.current?.id);
        if (index >= 0) element.scrollTop = Math.max(0, origin() + offsets[index]! + anchor.current.offset);
      }
      // Record our writes before the browser delivers their scroll events.
      lastTop = element.scrollTop;
      update();
    };
    const stopFollowing = () => { following.current = false; update(); };
    const onScroll = () => {
      // This also catches scrollbar drags. Our own writes equal lastTop and
      // cannot stop following or resume it after an anchor correction.
      // Reaching the bottom follows again; that includes the browser clamping scrollTop when the content got shorter
      // (measured rows smaller than estimated), which is not the user scrolling up (T051).
      const atBottom = element.scrollHeight - element.clientHeight - element.scrollTop <= 1;
      if (element.scrollTop !== lastTop && atBottom) following.current = true;
      else if (element.scrollTop < lastTop) following.current = false;
      lastTop = element.scrollTop;
      update();
    };
    const onWheel = (event: WheelEvent) => { if (event.deltaY < 0) stopFollowing(); };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target === element && !event.defaultPrevented &&
        (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey))) stopFollowing();
    };
    const onPointerDown = (event: PointerEvent) => {
      const left = element.getBoundingClientRect().left + element.clientLeft;
      if (event.target === element && event.pointerType !== 'touch' &&
        (event.clientX < left || event.clientX >= left + element.clientWidth)) stopFollowing();
    };
    const onTouchStart = (event: TouchEvent) => { touchY.current = event.touches[0]?.clientY; };
    const onTouchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY;
      if (nextY !== undefined && touchY.current !== undefined && nextY > touchY.current) stopFollowing();
      touchY.current = nextY;
    };
    const onTouchEnd = () => { touchY.current = undefined; };
    jump.current = () => { following.current = true; restore(); };
    restore();
    element.addEventListener('scroll', onScroll, { passive: true });
    element.addEventListener('wheel', onWheel, { passive: true });
    element.addEventListener('keydown', onKeyDown);
    element.addEventListener('pointerdown', onPointerDown, { passive: true });
    element.addEventListener('touchstart', onTouchStart, { passive: true });
    element.addEventListener('touchmove', onTouchMove, { passive: true });
    element.addEventListener('touchend', onTouchEnd, { passive: true });
    element.addEventListener('touchcancel', onTouchEnd, { passive: true });
    let width = element.clientWidth;
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => {
      if (width !== element.clientWidth) { width = element.clientWidth; heights.current.clear(); setMeasurement(value => value + 1); }
      restore();
    });
    observer?.observe(element);
    // Include the history controls, lock waits, pending panel and streaming tail.
    // Their heights may change without messages or the viewport changing.
    Array.from(element.children).forEach(child => observer?.observe(child));
    return () => {
      element.removeEventListener('scroll', onScroll);
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('keydown', onKeyDown);
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchmove', onTouchMove);
      element.removeEventListener('touchend', onTouchEnd);
      element.removeEventListener('touchcancel', onTouchEnd);
      observer?.disconnect();
    };
  }, [messages, offsets, scroll, visible]);
  useLayoutEffect(() => {
    const root = list.current;
    if (!root || !visible) return;
    const measure = () => {
      let changed = false;
      root.querySelectorAll<HTMLElement>('[data-entry-id]').forEach(row => {
        const id = row.dataset.entryId!;
        const height = row.getBoundingClientRect().height;
        if (height > 0 && heights.current.get(id) !== height) { heights.current.set(id, height); changed = true; }
      });
      if (changed) setMeasurement(value => value + 1);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    root.querySelectorAll('[data-entry-id]').forEach(row => observer?.observe(row));
    return () => observer?.disconnect();
  }, [messages, start, end, visible, measurement]);
  return <><div ref={list} className="virtual-messages" role="list" aria-label={`訊息（共 ${total} 則）`}>
    <div aria-hidden="true" style={{ height: offsets[start] ?? 0 }} />
    {messages.slice(start, end).map((entry, index) => <div className="virtual-message-row" data-entry-id={entry.id} {...(entry.kind === 'message' ? { 'data-message-id': entry.id } : {})} role="listitem" aria-posinset={start + index + 1} aria-setsize={messages.length} key={entry.id}>
      {entry.kind === 'message' ? <MessageView message={entry.message} sessions={sessions} runtime={runtime} /> : <ToolGroup items={entry.items} />}
    </div>)}
    <div aria-hidden="true" style={{ height: (offsets.at(-1) ?? 0) - (offsets[end] ?? 0) }} />
  </div>{showLatest && <button className="jump-latest" onClick={() => jump.current()}>跳到最新</button>}</>;
});
