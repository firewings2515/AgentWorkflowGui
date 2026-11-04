// @vitest-environment jsdom
import { createRef } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureSnapshot } from '../../../contracts/fixtures/snapshot';
import { longConversation } from '../../../contracts/fixtures/long-conversation';
import { VirtualMessages } from './VirtualMessages';
import { transcriptGeometry } from './transcript-test-geometry';
import type { TranscriptPosition } from './shell-v4/pane-state';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('T041 variable-height window', () => {
  it('renders a bounded window across 2000 turns and keeps plain text', () => {
    const messages = longConversation({ turns: 2000 }).messages;
    messages[0]!.text = '<img src=x onerror=alert(1)>';
    const scroll = createRef<HTMLDivElement>();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const top = this.classList.contains('virtual-messages') ? -(scroll.current?.scrollTop ?? 0) : 0;
      return { top, bottom: top, height: 0, width: 600, left: 0, right: 600, x: 0, y: top, toJSON: () => ({}) };
    });
    const view = render(<div ref={scroll}><VirtualMessages scroll={scroll} messages={messages} sessions={fixtureSnapshot.sessions} runtime="claude" visible /></div>);
    expect(view.container.querySelectorAll('[data-message-id]').length).toBeLessThan(30);
    expect(view.container.querySelector('img')).toBeNull();
    expect(view.container.textContent).toContain('<img src=x onerror=alert(1)>');
    fireEvent.scroll(scroll.current!, { target: { scrollTop: 200000 } });
    expect(view.container.querySelectorAll('[data-message-id]').length).toBeLessThan(30);
    expect(Number(view.container.querySelector('[role="listitem"]')?.getAttribute('aria-posinset'))).toBeGreaterThan(1000);
  });
  it('preserves the same message and within-row offset when older rows are prepended', () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(100000);
    const all = longConversation({ turns: 100 }).messages;
    const scroll = createRef<HTMLDivElement>();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      // Fixed list origin, realistic relative viewport movement, measured unequal rows.
      const top = this.classList.contains('virtual-messages') ? 60 - (scroll.current?.scrollTop ?? 0) : 0;
      const height = this.dataset.messageId ? this.dataset.messageId.endsWith('-u') ? 80 : 240 : 0;
      return { top, bottom: top + height, height, width: 600, left: 0, right: 600, x: 0, y: top, toJSON: () => ({}) };
    });
    const content = (messages: typeof all) => <div ref={scroll}><VirtualMessages initialPosition={{ anchor: null, following: false }} scroll={scroll} messages={messages} sessions={fixtureSnapshot.sessions} runtime="claude" visible /></div>;
    const view = render(content(all.slice(100)));
    act(() => { scroll.current!.scrollTop = 60 + 80 + 20; fireEvent.scroll(scroll.current!); });
    view.rerender(content(all));
    const target = view.container.querySelector('[data-message-id="s-long-turn-50-a"]')!;
    const siblings = Array.from(target.parentElement!.children);
    const offset = siblings.slice(0, siblings.indexOf(target)).reduce((sum, row) => sum + (row instanceof HTMLElement && row.dataset.messageId ? row.getBoundingClientRect().height : Number.parseFloat((row as HTMLElement).style.height) || 0), 0);
    // Overscan rows are measured too; the same assistant stays 20px into view
    // even when their actual heights replace estimates after the prepend.
    expect(scroll.current!.scrollTop).toBe(60 + offset + 20);
  });
  it('opens 2000 turns at the last message, follows appends and streams, and stops after scrolling up', () => {
    const { geometry, resize } = transcriptGeometry();
    const all = longConversation({ turns: 2001 }).messages;
    const scroll = createRef<HTMLDivElement>();
    const content = (messages: typeof all) => <div data-test-scroll ref={scroll}><div className="transcript-top" /><VirtualMessages scroll={scroll} messages={messages} sessions={fixtureSnapshot.sessions} runtime="claude" visible /><div className="transcript-tail" /></div>;
    const view = render(content(all.slice(0, 4000)));
    const bottom = () => scroll.current!.scrollHeight - scroll.current!.clientHeight;
    expect(view.container.querySelector('[data-message-id="s-long-turn-1999-a"]')).not.toBeNull();
    expect(scroll.current!.scrollTop).toBe(bottom());
    // A delayed event from the initial programmatic scroll keeps following.
    fireEvent.scroll(scroll.current!);
    view.rerender(content(all));
    expect(scroll.current!.scrollTop).toBe(bottom());
    geometry.tail = 300;
    act(() => resize(view.container.querySelector('.transcript-tail')!));
    expect(scroll.current!.scrollTop).toBe(bottom());
    fireEvent.scroll(scroll.current!, { target: { scrollTop: 10000 } });
    const readingTop = scroll.current!.scrollTop;
    geometry.tail += 400;
    act(() => resize(view.container.querySelector('.transcript-tail')!));
    view.rerender(content([...all, { ...all[0]!, id: all[0]!.id + '-new' as typeof all[number]['id'] }]));
    expect(scroll.current!.scrollTop).toBe(readingTop);
    expect(view.container.querySelectorAll('[data-message-id]').length).toBeLessThan(30);
    fireEvent.click(view.getByRole('button', { name: '跳到最新' }));
    expect(scroll.current!.scrollTop).toBe(bottom());
  });
  it.each(['ArrowUp', 'PageUp', 'Home', 'wheel', 'touch', 'scrollbar'])('stops immediately for %s, keeps a 40px reading offset during streaming, and resumes only at bottom', input => {
    const { geometry, resize } = transcriptGeometry();
    let messages = longConversation({ turns: 250 }).messages;
    const scroll = createRef<HTMLDivElement>();
    const content = () => <div data-test-scroll tabIndex={0} ref={scroll}><div className="transcript-top" /><VirtualMessages scroll={scroll} messages={messages} sessions={fixtureSnapshot.sessions} runtime="claude" visible /><div className="transcript-tail" /></div>;
    const view = render(content());
    const element = scroll.current!;
    const bottom = () => element.scrollHeight - element.clientHeight;
    if (input === 'wheel') fireEvent.wheel(element, { deltaY: -1 });
    else if (input === 'touch') {
      fireEvent.touchStart(element, { touches: [{ clientY: 100 }] });
      fireEvent.touchMove(element, { touches: [{ clientY: 101 }] });
    } else if (input === 'scrollbar') {
      fireEvent(element, new MouseEvent('pointerdown', { bubbles: true, clientX: geometry.width + 2 }));
    } else fireEvent.keyDown(element, { key: input });
    // Intent pauses before the browser's first scroll animation frame.
    expect(view.getByRole('button', { name: '跳到最新' })).toBeTruthy();
    fireEvent.scroll(element); // A queued programmatic event cannot undo intent.
    expect(view.getByRole('button', { name: '跳到最新' })).toBeTruthy();
    fireEvent.scroll(element, { target: { scrollTop: bottom() - 40 } });
    const readingTop = element.scrollTop;
    messages = messages.map((message, index) => index === messages.length - 1 ? { ...message, text: message.text + '串流' } : message);
    view.rerender(content());
    geometry.tail += 20;
    act(() => resize(view.container.querySelector('.transcript-tail')!));
    fireEvent.scroll(element); // Programmatic anchor correction must not resume.
    expect(element.scrollTop).toBe(readingTop);
    expect(view.getByRole('button', { name: '跳到最新' })).toBeTruthy();
    fireEvent.scroll(element, { target: { scrollTop: bottom() - 20 } });
    expect(view.getByRole('button', { name: '跳到最新' })).toBeTruthy();
    fireEvent.scroll(element, { target: { scrollTop: bottom() } });
    expect(view.queryByRole('button', { name: '跳到最新' })).toBeNull();
    geometry.tail += 100;
    act(() => resize(view.container.querySelector('.transcript-tail')!));
    expect(element.scrollTop).toBe(bottom());
  });
  it('does not change follow mode when programmatic corrections move upward or reach bottom', () => {
    const { geometry, resize } = transcriptGeometry();
    geometry.tail = 200;
    const messages = longConversation({ turns: 100 }).messages;
    const scroll = createRef<HTMLDivElement>();
    const view = render(<div data-test-scroll ref={scroll}><div className="transcript-top" /><VirtualMessages scroll={scroll} messages={messages} sessions={fixtureSnapshot.sessions} runtime="claude" visible /><div className="transcript-tail" /></div>);
    const element = scroll.current!;
    const bottom = () => element.scrollHeight - element.clientHeight;
    const tail = view.container.querySelector('.transcript-tail')!;
    const top = element.scrollTop;
    geometry.tail -= 40;
    act(() => resize(tail));
    expect(element.scrollTop).toBe(top - 40);
    fireEvent.scroll(element);
    expect(view.queryByRole('button', { name: '跳到最新' })).toBeNull();
    // Dragging upward without a wheel/key event also pauses, with no threshold.
    fireEvent.scroll(element, { target: { scrollTop: bottom() - 40 } });
    const readingTop = element.scrollTop;
    geometry.tail -= 40;
    act(() => resize(tail));
    expect(element.scrollTop).toBe(bottom());
    fireEvent.scroll(element);
    expect(view.getByRole('button', { name: '跳到最新' })).toBeTruthy();
    geometry.tail += 100;
    act(() => resize(tail));
    expect(element.scrollTop).toBe(readingTop);
  });
  it('compensates top content resizing and restores an ID anchor after remounting or hiding', () => {
    const { geometry, resize } = transcriptGeometry();
    const messages = longConversation({ turns: 100 }).messages;
    const scroll = createRef<HTMLDivElement>();
    let saved: TranscriptPosition | undefined;
    const content = (key: string, visible = true) => <div data-test-scroll ref={scroll}><div className="transcript-top" /><VirtualMessages key={key} initialPosition={saved} onPosition={reading => { saved = reading; }} scroll={scroll} messages={messages} sessions={fixtureSnapshot.sessions} runtime="claude" visible={visible} /></div>;
    const view = render(content('a'));
    fireEvent.scroll(scroll.current!, { target: { scrollTop: 8000 } });
    const expected = structuredClone(saved);
    const top = scroll.current!.scrollTop;
    geometry.top += 180;
    act(() => resize(view.container.querySelector('.transcript-top')!));
    expect(scroll.current!.scrollTop).toBe(top + 180);
    expect(saved).toEqual(expected);
    view.rerender(content('b'));
    expect(saved).toEqual(expected);
    expect(view.container.querySelector(`[data-message-id="${expected!.anchor!.id}"]`)).not.toBeNull();
    view.rerender(content('b', false));
    scroll.current!.scrollTop = 0;
    view.rerender(content('b'));
    expect(saved).toEqual(expected);
    // A compact viewport still mounts a bounded window.
    geometry.height = 160;
    act(() => resize(scroll.current!));
    expect(view.container.querySelectorAll('[data-message-id]').length).toBeLessThan(20);
  });
  it('T051: keeps following when the browser clamps scrollTop because the content got shorter', () => {
    const { geometry } = transcriptGeometry();
    const messages = longConversation({ turns: 30 }).messages;
    const scroll = createRef<HTMLDivElement>();
    const view = render(<div data-test-scroll ref={scroll}><VirtualMessages scroll={scroll} messages={messages} sessions={fixtureSnapshot.sessions} runtime="claude" visible /></div>);
    const element = scroll.current!;
    const bottom = () => element.scrollHeight - element.clientHeight;
    expect(element.scrollTop).toBe(bottom());
    // Measured rows came out shorter than estimated: the browser moves scrollTop up to the new bottom.
    geometry.tail = -200;
    fireEvent.scroll(element, { target: { scrollTop: bottom() } });
    expect(view.queryByRole('button', { name: '跳到最新' })).toBeNull();
    // Scrolling up for real still stops following.
    fireEvent.scroll(element, { target: { scrollTop: bottom() - 300 } });
    expect(view.getByRole('button', { name: '跳到最新' })).toBeTruthy();
  });
});
