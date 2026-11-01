// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { performanceSnapshot } from './performance-demo';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('records 2000-turn renderer event-to-React-commit baseline (jsdom, no layout or paint)', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  window.history.replaceState(null, '', '/#/workbench');
  const data = performanceSnapshot();
  const view = render(<App snapshot={data} />);
  await act(async () => { await Promise.resolve(); });
  const transcript = view.container.querySelector<HTMLDivElement>('.transcript')!;
  const textarea = view.container.querySelector<HTMLTextAreaElement>('.composer textarea')!;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const top = this.classList.contains('virtual-messages') ? -transcript.scrollTop : 0;
    return { top, bottom: top, height: 0, width: 600, left: 0, right: 600, x: 0, y: top, toJSON: () => ({}) };
  });
  const scroll: number[] = []; const input: number[] = []; const rowCounts: number[] = [];
  for (let n = 0; n < 45; n++) {
    const start = performance.now();
    fireEvent.scroll(transcript, { target: { scrollTop: ((n % 15) / 14) * 550000 } });
    const elapsed = performance.now() - start;
    if (n >= 5) { scroll.push(elapsed); rowCounts.push(view.container.querySelectorAll('[data-message-id]').length); }
  }
  for (let n = 0; n < 45; n++) {
    const start = performance.now();
    fireEvent.change(textarea, { target: { value: `輸入延遲測量 ${n}` } });
    const elapsed = performance.now() - start;
    expect(textarea.value).toBe(`輸入延遲測量 ${n}`);
    if (n >= 5) input.push(elapsed);
  }
  const stats = (values: number[]) => {
    const sorted = values.toSorted((a, b) => a - b);
    return { samples: values.length, medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], maxMs: sorted.at(-1) };
  };
  console.info('T041_BASELINE', JSON.stringify({ fixture: 'longConversation({ turns: 2000 })', messages: data.messages.length, environment: 'jsdom; synthetic geometry; event to React commit only; excludes layout, paint and real input scheduling', warmups: 5, scroll: stats(scroll), input: stats(input), mountedRows: { min: Math.min(...rowCounts), max: Math.max(...rowCounts) } }));
  expect(data.messages).toHaveLength(4000);
  expect(Math.max(...rowCounts)).toBeLessThan(30);
  // Rendering 4000 messages once takes several seconds when the machine is busy (T041 r3 P2-1): a measurement, not a limit.
}, 60_000);
