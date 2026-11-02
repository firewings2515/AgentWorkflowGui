// The performance baseline's delta stream (T040, V-18), for development runs only: with AWG_PERF_LOAD set and the app
// not packaged, `index.ts` publishes `rate` message deltas a second for `seconds`, after `delayMs`, to one message of
// `session` — through the bus, so they take the real way to the window (batches, flow control, the renderer store).
//
//   AWG_PERF_LOAD=session=<sessionId>;rate=100;seconds=60;delayMs=20000;chars=24
import { type AppEvent, MessageId, SessionId } from '../../contracts';

export interface PerfLoad {
  sessionId: SessionId;
  rate: number;
  seconds: number;
  delayMs: number;
  chars: number;
}

const number = (raw: string | undefined, fallback: number, min: number, max: number): number => {
  if (raw === undefined || !/^\d+$/.test(raw)) return fallback;
  const n = Number(raw);
  return n >= min && n <= max ? n : fallback;
};

/** Undefined unless AWG_PERF_LOAD names a session. */
export const perfLoadFrom = (env: Record<string, string | undefined>): PerfLoad | undefined => {
  const raw = env['AWG_PERF_LOAD'];
  if (raw === undefined) return undefined;
  const fields = new Map(raw.split(';').map((part) => part.split('=', 2) as [string, string | undefined]));
  const session = SessionId.safeParse(fields.get('session'));
  if (!session.success) return undefined;
  return {
    sessionId: session.data,
    rate: number(fields.get('rate'), 100, 1, 1000),
    seconds: number(fields.get('seconds'), 60, 1, 600),
    delayMs: number(fields.get('delayMs'), 20_000, 0, 600_000),
    chars: number(fields.get('chars'), 24, 1, 4000),
  };
};

/**
 * Publishes the stream; returns the function that stops it. Deltas go out on a fixed schedule from the start (not one
 * timer after another), so a busy event loop shows up as late deltas, not as fewer of them.
 */
export function startPerfLoad(load: PerfLoad, publish: (event: AppEvent) => void, mark: (name: string, extra?: Record<string, number>) => void): () => void {
  const messageId = MessageId.parse(`perf-${load.sessionId}`);
  const total = load.rate * load.seconds;
  const text = 'x'.repeat(Math.max(0, load.chars - 1));
  let sent = 0;
  let begin = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const step = () => {
    const due = Math.min(total, Math.floor(((Date.now() - begin) * load.rate) / 1000) + 1);
    while (sent < due) {
      publish({ type: 'message.delta', sessionId: load.sessionId, messageId, delta: `${text}\n` });
      sent++;
    }
    if (sent >= total) {
      mark('load-end', { sent, ms: Date.now() - begin });
      return;
    }
    timer = setTimeout(step, Math.max(1, Math.floor(1000 / load.rate)));
  };
  const first = setTimeout(() => {
    begin = Date.now();
    mark('load-start', { rate: load.rate, seconds: load.seconds });
    step();
  }, load.delayMs);
  return () => {
    clearTimeout(first);
    clearTimeout(timer);
  };
}
