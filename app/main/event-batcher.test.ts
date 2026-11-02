// T040: event batches (C-27) and flow control. What the bus published is compared with what a renderer that applied
// every batch holds: nothing but deltas merged, nothing reordered or dropped, batches without gaps.
import { describe, expect, it } from 'vitest';
import { EventBatch, type AppEvent, type EventEnvelope, type MessageId, type SessionId } from '../../contracts';
import { fixtureSnapshot } from '../../contracts/fixtures/snapshot';
import { type BatcherOptions, sessionsOf, WindowBatcher } from './event-batcher';
import { EventBus } from './event-bus';
import { BatchLedger, deltaKeyOf, isDelta, seeded, STREAM_SESSIONS, streamEvent } from './testing/event-stream';

/** Timers on a clock the test moves. */
class Clock {
  t = 0;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private next = 1;
  set = (fn: () => void, ms: number): unknown => {
    const id = this.next++;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  };
  clear = (id: unknown): void => {
    this.timers = this.timers.filter((x) => x.id !== id);
  };
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const due = this.timers[0];
      if (due === undefined || due.at > end) break;
      this.timers.shift();
      this.t = due.at;
      due.fn();
    }
    this.t = end;
  }
}

type Speed = 'fast' | 'slow' | 'stalled';

/** A bus, a batcher and a renderer that acknowledges each batch after `ackMs` (never when stalled). */
function rig(options: { speed?: Speed; ackMs?: number; batcher?: Partial<BatcherOptions>; available?: () => boolean } = {}) {
  const clock = new Clock();
  const bus = new EventBus({ seq: 0, onRejected: (reason) => { throw new Error(reason); } });
  const ledger = new BatchLedger();
  const published: EventEnvelope[] = [];
  const speed = options.speed ?? 'fast';
  const ackMs = options.ackMs ?? (speed === 'fast' ? 1 : 40);
  let reloads = 0;
  const batcher: WindowBatcher = new WindowBatcher({
    now: () => clock.t,
    startSeq: 0,
    setTimer: clock.set,
    clearTimer: clock.clear,
    invalidate: () => void bus.publish({ type: 'snapshot.invalidated', reason: 'event-overflow', at: '2026-11-03T10:00:00.000Z' }),
    ...options.batcher,
    target: () => ({
      isAvailable: options.available ?? (() => true),
      send: (batch) => {
        // Every batch the main process sends must pass the contract.
        EventBatch.parse(batch);
        ledger.apply(batch);
        if (batch.envelopes.some((e) => e.event.type === 'snapshot.invalidated')) {
          reloads++;
          return;
        }
        if (speed !== 'stalled') clock.set(() => batcher.ack(batch.toSeq), ackMs);
      },
    }),
  });
  bus.subscribe((envelope) => {
    published.push(envelope);
    batcher.push(envelope);
  });
  return { clock, bus, ledger, published, batcher, reloads: () => reloads };
}

/** Publishes `n` stream events, one every `everyMs`, then lets the batcher send everything. */
function run(r: ReturnType<typeof rig>, n: number, everyMs: number, seed = 40): void {
  const random = seeded(seed);
  for (let i = 0; i < n; i++) {
    r.bus.publish(streamEvent(random, i));
    r.clock.advance(everyMs);
  }
  r.clock.advance(5_000);
}

const expectNothingLost = (r: ReturnType<typeof rig>) => {
  const { ledger, published } = r;
  // Every envelope that is not a delta arrives exactly once, with its seq, in publishing order.
  expect(ledger.kept.map((e) => e.seq)).toEqual(published.filter((e) => !isDelta(e.event)).map((e) => e.seq));
  expect(ledger.kept).toEqual(published.filter((e) => !isDelta(e.event)));
  // Each message's and item's text is exactly what was streamed.
  const text = new Map<string, string>();
  for (const e of published) if (isDelta(e.event)) text.set(deltaKeyOf(e.event), (text.get(deltaKeyOf(e.event)) ?? '') + e.event.delta);
  expect(ledger.text).toEqual(text);
  // No gap between batches; the last batch ends at the bus's seq.
  expect(ledger.gaps).toBe(0);
  expect(ledger.lastSeq).toBe(r.bus.seq);
};

/** Where each delta sits among the events of its session: merging must not move one past another (C-27). */
const sessionOrder = (envelopes: readonly EventEnvelope[], session: SessionId): string[] =>
  envelopes.flatMap((e) => {
    const about = sessionsOf(e.event);
    if (about !== 'all' && !about.includes(session)) return [];
    return [isDelta(e.event) ? `delta:${deltaKeyOf(e.event)}` : `event:${String(e.seq)}`];
  });
const collapse = (order: string[]) => order.filter((x, i) => !(x.startsWith('delta:') && order[i - 1] === x));

describe('B-1 property: a seeded stream of mixed events through the batcher', () => {
  it.each<[Speed, number]>([
    ['fast', 0.1],
    ['slow', 0.1],
  ])('with a %s renderer, nothing but deltas is merged, nothing is reordered or dropped, batches have no gaps', (speed, everyMs) => {
    const r = rig({ speed, batcher: { maxPending: 1_000_000, maxPendingBytes: 1e12 } });
    run(r, 20_000, everyMs);
    expectNothingLost(r);
    expect(r.batcher.stats.overflows).toBe(0);
    expect(r.batcher.stats.merged).toBeGreaterThan(0);
    // A slow renderer gets fewer, larger batches; never more than the in-flight limit unacknowledged.
    expect(r.batcher.stats.maxInFlight).toBeLessThanOrEqual(4);
    for (const session of STREAM_SESSIONS) {
      const sent = r.ledger.batches.flatMap((b) => b.envelopes);
      expect(collapse(sessionOrder(sent, session))).toEqual(collapse(sessionOrder(r.published, session)));
    }
  });

  it('merges fewer batches than envelopes and sends far fewer envelopes than were published', () => {
    const r = rig({ speed: 'slow' });
    run(r, 20_000, 0.1);
    expect(r.batcher.stats.envelopesSent).toBeLessThan(r.published.length);
    expect(r.ledger.batches.length).toBeLessThan(r.batcher.stats.envelopesSent);
  });
});

const delta = (sessionId: string, messageId: string, text: string): AppEvent => ({
  type: 'message.delta',
  sessionId: sessionId as SessionId,
  messageId: messageId as MessageId,
  delta: text,
});
const f = fixtureSnapshot;

describe('B-2 what lies between two deltas decides whether they merge', () => {
  const sent = (events: AppEvent[]) => {
    const r = rig();
    for (const e of events) r.bus.publish(e);
    r.clock.advance(100);
    return r.ledger.batches.flatMap((b) => b.envelopes.map((e) => e.event));
  };

  it('an event about the same session keeps them apart', () => {
    const events = sent([delta('s-wf-build-b', 'm1', 'a'), { type: 'permission.updated', request: f.permissionRequests[0]! }, delta('s-wf-build-b', 'm1', 'b')]);
    expect(events.map((e) => e.type)).toEqual(['message.delta', 'permission.updated', 'message.delta']);
  });

  it('a delta of another session does not', () => {
    const events = sent([delta('s1', 'm1', 'a'), delta('s2', 'm2', 'x'), delta('s1', 'm1', 'b')]);
    expect(events).toEqual([delta('s2', 'm2', 'x'), delta('s1', 'm1', 'ab')]);
  });

  it('another delta of the same session (an item output) keeps them apart', () => {
    const events = sent([delta('s1', 'm1', 'a'), { type: 'item.outputDelta', sessionId: 's1' as SessionId, itemId: f.items[0]!.id, delta: 'o' }, delta('s1', 'm1', 'b')]);
    expect(events.map((e) => (isDelta(e) ? e.delta : e.type))).toEqual(['a', 'o', 'b']);
  });

  it('an event that cannot be tied to sessions keeps every session apart', () => {
    for (const barrier of [
      { type: 'instance.updated', instance: f.instances[0]! },
      { type: 'escalation.updated', escalation: f.escalations[0]! },
      { type: 'handoff.updated', handoff: f.handoffs[0]! },
      { type: 'transfer.updated', proposal: f.transfers[0]! },
    ] as AppEvent[]) {
      expect(sent([delta('s1', 'm1', 'a'), barrier, delta('s1', 'm1', 'b')]).length).toBe(3);
    }
  });

  it('an event about no session lets them merge, and the merged delta takes the later seq', () => {
    const r = rig();
    r.bus.publish(delta('s1', 'm1', 'a'));
    r.bus.publish({ type: 'usage.limits', at: '2026-11-03T10:00:00.000Z' });
    r.bus.publish(delta('s1', 'm1', 'b'));
    r.clock.advance(100);
    const [batch] = r.ledger.batches;
    expect(batch).toMatchObject({ fromSeq: 1, toSeq: 3 });
    expect(batch?.envelopes.map((e) => [e.seq, e.event.type])).toEqual([
      [2, 'usage.limits'],
      [3, 'message.delta'],
    ]);
    expect(batch?.envelopes[1]?.event).toEqual(delta('s1', 'm1', 'ab'));
  });

  it('deltas of two turns of one message ID stay apart', () => {
    const events = sent([
      { type: 'message.delta', sessionId: 's1' as SessionId, turnId: f.turns[0]!.id, messageId: 'm1' as MessageId, delta: 'a' },
      { type: 'message.delta', sessionId: 's1' as SessionId, turnId: f.turns[1]!.id, messageId: 'm1' as MessageId, delta: 'b' },
    ]);
    expect(events.length).toBe(2);
  });
});

describe('B-3 a renderer that falls behind', () => {
  it('is let go past the queue limit: one snapshot.invalidated (event-overflow), after a gap, then nothing until it reads again', () => {
    const r = rig({ speed: 'stalled', batcher: { maxPending: 200 } });
    run(r, 3_000, 0.1);
    expect(r.batcher.stats.overflows).toBe(1);
    const last = r.ledger.batches.at(-1)!;
    expect(last.envelopes.map((e) => e.event)).toMatchObject([{ type: 'snapshot.invalidated', reason: 'event-overflow' }]);
    expect(last.fromSeq).toBe(last.toSeq);
    // Nothing more is queued for it, however much is published.
    expect(r.batcher.pendingCount).toBe(0);
    const count = r.ledger.batches.length;
    r.bus.publish(delta('s1', 'm1', 'late'));
    r.clock.advance(1_000);
    expect(r.ledger.batches.length).toBe(count);

    // It reads the Snapshot (the cut, then the seq): batches start right after that seq again.
    r.batcher.cut();
    const seq = r.bus.seq;
    r.bus.publish({ type: 'permission.updated', request: f.permissionRequests[0]! });
    r.clock.advance(100);
    expect(r.ledger.batches.at(-1)).toMatchObject({ fromSeq: seq + 1, toSeq: seq + 1 });
  });

  it('is let go when it acknowledges nothing for stallMs while batches wait', () => {
    const r = rig({ speed: 'stalled', batcher: { stallMs: 2_000 } });
    for (let i = 0; i < 10; i++) {
      r.bus.publish({ type: 'usage.limits', at: '2026-11-03T10:00:00.000Z' });
      r.clock.advance(20);
    }
    expect(r.batcher.stats.overflows).toBe(0);
    r.clock.advance(3_000);
    expect(r.batcher.stats.overflows).toBe(1);
  });

  it('by bytes: one huge stream of one message is let go past maxPendingBytes', () => {
    const r = rig({ speed: 'stalled', batcher: { maxPendingBytes: 64 * 1024 } });
    for (let i = 0; i < 6; i++) r.bus.publish({ type: 'usage.limits', at: '2026-11-03T10:00:00.000Z' });
    r.clock.advance(100);
    for (let i = 0; i < 100; i++) r.bus.publish(delta('s1', 'm1', 'x'.repeat(1000)));
    expect(r.batcher.stats.overflows).toBe(1);
  });

  it('a slow renderer within the limits is never let go and loses nothing', () => {
    const r = rig({ speed: 'slow', ackMs: 200 });
    run(r, 5_000, 0.2);
    expect(r.batcher.stats.overflows).toBe(0);
    expectNothingLost(r);
  });
});

describe('B-4 acknowledgements of an earlier generation', () => {
  it('an acknowledgement that arrives after a reset releases nothing it was not for', () => {
    const r = rig({ speed: 'stalled', batcher: { maxInFlight: 2 } });
    const acks: number[] = [];
    for (let i = 0; i < 4; i++) {
      r.bus.publish({ type: 'usage.limits', at: '2026-11-03T10:00:00.000Z' });
      r.clock.advance(20);
      acks.push(r.ledger.lastSeq!);
    }
    expect(r.batcher.inFlightCount).toBe(2);
    expect(r.batcher.pendingCount).toBe(2);
    r.batcher.cut();
    expect(r.batcher.inFlightCount).toBe(0);
    r.bus.publish({ type: 'usage.limits', at: '2026-11-03T10:00:00.000Z' });
    r.clock.advance(20);
    // The old ones' acknowledgements now: ignored, the new batch is still waited for.
    for (const seq of acks) r.batcher.ack(seq);
    r.batcher.ack(-1);
    expect(r.batcher.inFlightCount).toBe(1);
  });
});

describe('B-5 the window between the cut and the Snapshot read', () => {
  it('an event published after the cut comes in the next batch, from the Snapshot seq + 1', () => {
    const r = rig();
    r.bus.publish(delta('s1', 'm1', 'a'));
    r.batcher.cut();
    // The Snapshot's seq is read here; its data are read after an await, while this is published.
    const snapshotSeq = r.bus.seq;
    r.bus.publish(delta('s1', 'm1', 'b'));
    r.clock.advance(100);
    expect(r.ledger.batches.map((b) => [b.fromSeq, b.toSeq])).toEqual([
      [1, 1],
      [snapshotSeq + 1, snapshotSeq + 1],
    ]);
    // Nothing was merged across the cut.
    expect(r.ledger.batches[1]?.envelopes[0]?.event).toEqual(delta('s1', 'm1', 'b'));
  });

  it('a cut sends what waits even past the in-flight limit, so nothing before the Snapshot seq is left queued', () => {
    const r = rig({ speed: 'stalled', batcher: { maxInFlight: 1 } });
    for (let i = 0; i < 5; i++) {
      r.bus.publish({ type: 'usage.limits', at: '2026-11-03T10:00:00.000Z' });
      r.clock.advance(20);
    }
    expect(r.batcher.pendingCount).toBeGreaterThan(0);
    r.batcher.cut();
    expect(r.batcher.pendingCount).toBe(0);
    expect(r.ledger.lastSeq).toBe(r.bus.seq);
  });
});

describe('B-6 a window that is gone or reloaded', () => {
  it('what could not be delivered leaves a gap the renderer sees, never passed off as merged deltas', () => {
    let available = true;
    const r = rig({ available: () => available });
    r.bus.publish(delta('s1', 'm1', 'a'));
    r.clock.advance(100);
    available = false;
    r.bus.publish({ type: 'permission.updated', request: f.permissionRequests[0]! });
    r.clock.advance(100);
    available = true;
    r.bus.publish({ type: 'usage.limits', at: '2026-11-03T10:00:00.000Z' });
    r.clock.advance(100);
    expect(r.ledger.batches.map((b) => [b.fromSeq, b.toSeq])).toEqual([
      [1, 1],
      [3, 3],
    ]);
    expect(r.ledger.gaps).toBe(1);
  });

  it('a reloaded page that never acknowledges the old batches is fed again once it reads the Snapshot', () => {
    const r = rig({ speed: 'stalled', batcher: { maxInFlight: 1 } });
    r.bus.publish(delta('s1', 'm1', 'a'));
    r.clock.advance(100);
    r.bus.publish(delta('s1', 'm1', 'b'));
    r.clock.advance(100);
    expect(r.batcher.inFlightCount).toBe(1);
    r.batcher.cut();
    r.bus.publish(delta('s1', 'm1', 'c'));
    r.clock.advance(100);
    expect(r.ledger.batches.at(-1)?.envelopes[0]?.event).toEqual(delta('s1', 'm1', 'c'));
  });
});
