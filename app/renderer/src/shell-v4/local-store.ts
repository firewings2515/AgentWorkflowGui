// Small localStorage helpers for renderer-only memory (T054: seen times, split layout), written like theme.ts: a read or
// write that fails is swallowed, and the in-memory value keeps working. Nothing here goes to the backend.

export type StoredRead = { ok: true; value: unknown } | { ok: false };

/** The parsed JSON under `key`; `{ ok: false }` when it is missing, unreadable or not JSON. */
export function readJson(key: string): StoredRead {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return { ok: false };
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
}

export interface ThrottledWriter {
  /** Writes `text` after `delay` ms; later calls in that window replace it, so a burst of changes writes once. */
  schedule: (text: string) => void;
  /** Writes a pending value now (page hide, unmount). */
  flush: () => void;
}

export function createThrottledWriter(key: string, delay = 500): ThrottledWriter {
  let pending: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    if (pending === undefined) return;
    const text = pending;
    pending = undefined;
    try { localStorage.setItem(key, text); } catch { /* The in-memory value still works. */ }
  };
  return {
    schedule: text => {
      pending = text;
      timer ??= setTimeout(flush, delay);
    },
    flush,
  };
}
