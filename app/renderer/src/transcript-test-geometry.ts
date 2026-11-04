import { vi } from 'vitest';

/** Synthetic layout, including spacers; no claim of browser layout coverage. */
export function transcriptGeometry() {
  const geometry = { top: 60, tail: 0, height: 500, width: 600 };
  const observers = new Set<{ callback: () => void; targets: Set<Element> }>();
  vi.stubGlobal('ResizeObserver', class {
    targets = new Set<Element>();
    constructor(public callback: () => void) { observers.add(this); }
    observe(target: Element) { this.targets.add(target); }
    unobserve(target: Element) { this.targets.delete(target); }
    disconnect() { observers.delete(this); }
  });
  const rowHeight = (row: HTMLElement) => row.dataset.messageId ? row.dataset.messageId.endsWith('-u') ? 80 : 240 : Number.parseFloat(row.style.height) || 0;
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.matches('.transcript, .v4-transcript, [data-test-scroll]') ? geometry.height : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(geometry.width);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    const list = this.querySelector('.virtual-messages');
    return geometry.top + geometry.tail + Array.from(list?.children ?? []).reduce((sum, row) => sum + rowHeight(row as HTMLElement), 0);
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const container = this.closest<HTMLElement>('.transcript, .v4-transcript, [data-test-scroll]');
    const top = this.classList.contains('virtual-messages') ? geometry.top - (container?.scrollTop ?? 0) : 0;
    const height = this.dataset.messageId ? rowHeight(this) : 0;
    return { top, bottom: top + height, height, width: geometry.width, left: 0, right: geometry.width, x: 0, y: top, toJSON: () => ({}) };
  });
  return { geometry, resize: (target: Element) => {
    [...observers].filter(observer => observer.targets.has(target)).forEach(observer => observer.callback());
  } };
}
