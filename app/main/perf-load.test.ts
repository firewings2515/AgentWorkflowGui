// T040: the development-only delta stream of the performance baseline.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppEvent } from '../../contracts';
import { perfLoadFrom, startPerfLoad } from './perf-load';

afterEach(() => {
  vi.useRealTimers();
});

describe('perfLoadFrom', () => {
  it('reads the fields, with defaults and bounds', () => {
    expect(perfLoadFrom({})).toBeUndefined();
    expect(perfLoadFrom({ AWG_PERF_LOAD: 'rate=100' })).toBeUndefined();
    expect(perfLoadFrom({ AWG_PERF_LOAD: 'session=s-1;rate=50;seconds=2;delayMs=0;chars=10' })).toEqual({ sessionId: 's-1', rate: 50, seconds: 2, delayMs: 0, chars: 10 });
    expect(perfLoadFrom({ AWG_PERF_LOAD: 'session=s-1;rate=99999;seconds=-1' })).toEqual({ sessionId: 's-1', rate: 100, seconds: 60, delayMs: 20_000, chars: 24 });
  });
});

describe('startPerfLoad', () => {
  it('publishes rate × seconds valid deltas on schedule, marks its start and end, and stops when asked', () => {
    vi.useFakeTimers();
    const events: AppEvent[] = [];
    const marks: string[] = [];
    const stop = startPerfLoad({ sessionId: 's-1' as never, rate: 100, seconds: 2, delayMs: 1000, chars: 8 }, (e) => events.push(AppEvent.parse(e)), (name) => marks.push(name));
    vi.advanceTimersByTime(999);
    expect(events).toHaveLength(0);
    vi.advanceTimersByTime(1001);
    expect(events.length).toBeGreaterThanOrEqual(95);
    expect(events.length).toBeLessThanOrEqual(105);
    vi.advanceTimersByTime(2000);
    expect(events).toHaveLength(200);
    expect(events[0]).toMatchObject({ type: 'message.delta', sessionId: 's-1', messageId: 'perf-s-1', delta: 'xxxxxxx\n' });
    expect(marks).toEqual(['load-start', 'load-end']);
    stop();

    const later: AppEvent[] = [];
    const cancel = startPerfLoad({ sessionId: 's-1' as never, rate: 10, seconds: 5, delayMs: 100, chars: 2 }, (e) => later.push(e), () => undefined);
    cancel();
    vi.advanceTimersByTime(10_000);
    expect(later).toHaveLength(0);
  });
});
