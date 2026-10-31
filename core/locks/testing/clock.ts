// A manual clock for lock tests: `now` and timers advance only when the test says so.
import type { Timestamp } from '../../../contracts';

export class ManualClock {
  private ms: number;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  private nextId = 1;

  constructor(start = '2026-10-31T00:00:00.000Z') {
    this.ms = Date.parse(start);
  }

  now = (): Timestamp => new Date(this.ms).toISOString();

  setTimer = (ms: number, fn: () => void): (() => void) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.ms + ms, fn });
    return () => this.timers.delete(id);
  };

  /** Moves time on, firing every timer that is due, in order. */
  advance(ms: number): void {
    const until = this.ms + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.timers.delete(due[0]);
      this.ms = due[1].at;
      due[1].fn();
    }
    this.ms = until;
  }

  get pending(): number {
    return this.timers.size;
  }
}
