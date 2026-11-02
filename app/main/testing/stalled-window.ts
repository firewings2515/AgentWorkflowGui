// T040: a window that takes event batches and never acknowledges one, so the batcher lets it go (C-27). What it was
// then not sent must be in the Snapshot it reads next: every event but the deltas is stored before it is published.
import { type AppEvent, EventBatch, type EventEnvelope } from '../../../contracts';
import { forwardEvents } from '../app-ipc';
import type { EventBus } from '../event-bus';

export function stalledWindow(bus: EventBus, maxPending = 10) {
  const from = bus.seq;
  const sent: EventBatch[] = [];
  const { batcher, stop } = forwardEvents(bus, () => ({ isDestroyed: () => false, getURL: () => 'app://renderer', send: (_channel, batch) => sent.push(EventBatch.parse(batch)) }), () => true, {
    batchMs: 1,
    maxInFlight: 1,
    maxPending,
  });
  const delivered = () => new Set(sent.flatMap((b) => b.envelopes.map((e) => e.seq)));
  return {
    batcher,
    stop,
    sent,
    /** The envelopes published since the window opened that it was never sent. */
    missed: (published: readonly EventEnvelope[]) => {
      const got = delivered();
      return published.filter((e) => e.seq > from && !got.has(e.seq));
    },
  };
}

/** Of the missed events of one type, the last one published for each record. */
export const lastOf = <T extends AppEvent['type'], R>(missed: readonly EventEnvelope[], type: T, record: (event: Extract<AppEvent, { type: T }>) => R & { id: string }) => {
  const last = new Map<string, R & { id: string }>();
  for (const e of missed) if (e.event.type === type) last.set(record(e.event as Extract<AppEvent, { type: T }>).id, record(e.event as Extract<AppEvent, { type: T }>));
  return [...last.values()];
};
