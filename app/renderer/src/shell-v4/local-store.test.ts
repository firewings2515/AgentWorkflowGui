// @vitest-environment jsdom
// T054: localStorage helpers — reads that fail are "nothing stored", and writes are throttled and never throw.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createThrottledWriter, readJson } from './local-store';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); localStorage.clear(); });

describe('T054 local store', () => {
  it('reads JSON; missing, malformed or throwing reads are not ok', () => {
    expect(readJson('k')).toEqual({ ok: false });
    localStorage.setItem('k', '{bad'); expect(readJson('k')).toEqual({ ok: false });
    localStorage.setItem('k', '{"a":1}'); expect(readJson('k')).toEqual({ ok: true, value: { a: 1 } });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect(readJson('k')).toEqual({ ok: false });
  });

  it('writes a burst of changes once, at the end of the window, with the last value; flush writes now', () => {
    vi.useFakeTimers();
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const writer = createThrottledWriter('k', 500);
    writer.schedule('1'); writer.schedule('2');
    vi.advanceTimersByTime(499);
    writer.schedule('3');
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(write.mock.calls).toEqual([['k', '3']]);
    writer.schedule('4'); writer.flush();
    expect(write.mock.calls.at(-1)).toEqual(['k', '4']);
    vi.advanceTimersByTime(1000);
    writer.flush();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('a write that throws is swallowed', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    const writer = createThrottledWriter('k');
    writer.schedule('x');
    expect(() => writer.flush()).not.toThrow();
  });
});
