import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { LogicalSession, Message } from '../../../contracts';
import { formatTime } from './ui';
import type { TranscriptPosition } from './workbench-state';

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
export const VirtualMessages = memo(function VirtualMessages({ messages, sessions, runtime, scroll, visible, initialPosition, onPosition }: {
  messages: Message[]; sessions: LogicalSession[]; runtime: string;
  scroll: RefObject<HTMLDivElement | null>; visible: boolean;
  initialPosition?: TranscriptPosition | undefined;
  onPosition?: ((reading: TranscriptPosition, scrollTop: number) => void) | undefined;
}) {
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
    const element = scroll.current ?? root?.parentElement;
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
      if (element.scrollTop < lastTop) following.current = false;
      else if (element.scrollTop > lastTop && element.scrollHeight - element.clientHeight - element.scrollTop <= 1) following.current = true;
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
      root.querySelectorAll<HTMLElement>('[data-message-id]').forEach(row => {
        const id = row.dataset.messageId!;
        const height = row.getBoundingClientRect().height;
        if (height > 0 && heights.current.get(id) !== height) { heights.current.set(id, height); changed = true; }
      });
      if (changed) setMeasurement(value => value + 1);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    root.querySelectorAll('[data-message-id]').forEach(row => observer?.observe(row));
    return () => observer?.disconnect();
  }, [messages, start, end, visible, measurement]);
  return <><div ref={list} className="virtual-messages" role="list" aria-label={`訊息（共 ${messages.length} 則）`}>
    <div aria-hidden="true" style={{ height: offsets[start] ?? 0 }} />
    {messages.slice(start, end).map((message, index) => <div className="virtual-message-row" data-message-id={message.id} role="listitem" aria-posinset={start + index + 1} aria-setsize={messages.length} key={message.id}>
      <article className={`message message-${message.role} origin-${message.origin.kind}`}>
        <div className="message-meta"><strong>{'fromSessionId' in message.origin
          ? `${message.origin.kind === 'transfer' ? '轉交自' : '來自'} ${sessions.find(source => 'fromSessionId' in message.origin && source.id === message.origin.fromSessionId)?.title ?? message.origin.fromSessionId}`
          : message.role === 'user' ? '你' : message.role === 'system' ? '系統' : 'Agent'}</strong><time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time></div>
        <p>{message.text}</p>
        {message.observedModel && runtime === 'claude' && <small className="muted">訊息回報 · {message.observedModel}</small>}
        {message.attachments.length > 0 && <div className="attachment-chips">{message.attachments.map(attachment => <span key={`${attachment.kind}:${attachment.path}`}>{attachment.name}</span>)}</div>}
      </article>
    </div>)}
    <div aria-hidden="true" style={{ height: (offsets.at(-1) ?? 0) - (offsets[end] ?? 0) }} />
  </div>{showLatest && <button className="jump-latest" onClick={() => jump.current()}>跳到最新</button>}</>;
});
