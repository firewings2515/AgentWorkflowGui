// Event batches for one window (C-27, V-18, T040): the bus's envelopes are queued per window and sent as EventBatch,
// at most every `batchMs`. Only deltas merge (MERGEABLE_EVENT_TYPES): a delta is folded into the queued delta of the
// same message (or item output) when no event about the same session lies between them, and takes the later seq.
// Every other envelope is sent once, unmerged, in seq order. Batches follow each other without gaps.
//
// Flow control: the preload acknowledges each batch once the renderer's listener returned; at most `maxInFlight`
// batches go unacknowledged, and meanwhile envelopes wait (deltas keep merging). A window whose queue grows past its
// limits, or that acknowledges nothing for `stallMs`, is no longer fed: its queue is let go, `snapshot.invalidated`
// (`event-overflow`) is sent to it, and it gets batches again once it read the Snapshot (`cut`). Nothing it was not
// sent is lost to it: what it missed is in that Snapshot, which is read after (C-05), and the records of the events it
// was not sent are written down (`missed-records.ts`) so that Snapshot brings them back however old (T040 r1 P1-1).
// A batch that could not be sent is handled the same way (r1 P1-2): the window is told to read again, never handed a
// later batch that would pass the gap off as merged deltas.
//
// The records owed (T040 r2): a record whose event the window did not take in a batch right after the one before is
// kept until the window is known to hold a Snapshot that brought it back. The renderer (renderer-store.ts) takes a
// batch it was sent without applying it whenever it reads: a batch after a gap is held and then dropped under the
// Snapshot's seq, a batch arriving in the error state is dropped, a Snapshot older than an invalidation it saw is
// dropped. So from a gap (a batch not sent, the window let go, any `snapshot.invalidated`) until the window holds a
// Snapshot again, every envelope is written down, sent or not, and so is everything `cut` sends. A Snapshot read hands
// over all that is owed and the batcher keeps it: it is let go only once that read was answered (in time, before the
// renderer would give up on it), a batch sent after the answer was acknowledged, and no gap came in between. Batches
// and the answer go to the window over the same IPC channel in order, so that batch was taken after the Snapshot.
// Anything else (a read that failed or came late, a gap during the read, a renderer that reads for a reason of its
// own) leaves it owed to the next read.
//
// Electron-free: the IPC layer (app-ipc.ts) gives it the window and the timers.
import { CONTRACTS_VERSION, type AppEvent, type EventBatch, type EventEnvelope, type SessionId } from '../../contracts';
import { copyMissed, mergeMissed, type MissedRecords, type MissedSession, noteMissed } from './missed-records';

/** The window batches go to. */
export interface BatchTarget {
  /** Alive and still showing one of our pages. */
  isAvailable(): boolean;
  send(batch: EventBatch): void;
}

export interface BatcherOptions {
  target: () => BatchTarget | null;
  /** Publishes `snapshot.invalidated` (`event-overflow`) on the bus; its envelope comes back through `push`. */
  invalidate(): void;
  /** The bus's seq when the batcher starts listening: the first batch starts right after it. */
  startSeq?: number;
  /** How long the first queued envelope waits for others before the batch is sent (default 16 ms). */
  batchMs?: number;
  /** Envelopes in one batch at most (default 500). */
  maxBatch?: number;
  /** Batches sent and not acknowledged at most (default 4). */
  maxInFlight?: number;
  /** Queued envelopes at most before the window is let go (default 5000). */
  maxPending?: number;
  /** Queued bytes (estimated) at most before the window is let go (default 16 MiB). */
  maxPendingBytes?: number;
  /** No acknowledgement for this long while batches wait: the window is let go (default 30 s). */
  stallMs?: number;
  /**
   * A Snapshot read answered later than this after its cut may have been given up on by the renderer (it waits 15 s):
   * what it brought back stays owed to the next read (default 10 s).
   */
  answerWithinMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (message: string) => void;
}

/** Counters for the performance baseline and the tests. */
export interface BatcherStats {
  batches: number;
  envelopesIn: number;
  envelopesSent: number;
  merged: number;
  overflows: number;
  maxPending: number;
  maxInFlight: number;
  bytesSent: number;
}

/** The sessions an event is about; `all` when that cannot be told, so it keeps every delta on its side of it. */
export const sessionsOf = (event: AppEvent): readonly SessionId[] | 'all' => {
  switch (event.type) {
    case 'session.updated':
      return [event.session.id];
    case 'session.activity':
    case 'message.delta':
    case 'item.outputDelta':
    case 'model.observed':
      return [event.sessionId];
    case 'turn.updated':
      return [event.turn.sessionId];
    case 'message.completed':
      return [event.message.sessionId];
    case 'item.updated':
      return [event.item.sessionId];
    case 'permission.updated':
      return [event.request.sessionId];
    case 'nativeTask.updated':
      return [event.task.sessionId];
    case 'artifact.updated':
      return [event.artifact.sessionId];
    case 'usage.tokens':
      return [event.usage.sessionId];
    case 'peerMessage.updated':
      return [event.message.fromSessionId, event.message.toSessionId];
    case 'runtime.exited':
      return event.sessionIds;
    // About no session's conversation.
    case 'usage.limits':
    case 'modelOptions.updated':
    case 'preferences.updated':
    case 'agent.updated':
    case 'agent.deleted':
    case 'workflow.updated':
    case 'project.updated':
    case 'locks.updated':
    case 'runtime.status':
    case 'storage.updated':
      return [];
    // Instances, handoffs, escalations, transfers, invalidation, read-only: about whichever sessions they touch.
    default:
      return 'all';
  }
};

const deltaKey = (event: AppEvent): string | undefined => {
  if (event.type === 'message.delta') return JSON.stringify(['m', event.sessionId, event.messageId, event.turnId ?? null, event.nativeTaskId ?? null]);
  if (event.type === 'item.outputDelta') return JSON.stringify(['i', event.sessionId, event.itemId]);
  return undefined;
};

const sizeOf = (event: AppEvent): number =>
  event.type === 'message.delta' || event.type === 'item.outputDelta' ? event.delta.length * 2 + 160 : JSON.stringify(event).length * 2;

interface InFlight {
  toSeq: number;
  sentAt: number;
  /** The how-manyth batch sent. */
  index: number;
}

/** The last Snapshot read (`cut`) while it is not known that the window holds it. */
interface Reading {
  /** Everything owed, handed to that read. */
  owed: MissedRecords;
  cutAt: number;
  /** Batches sent when it was answered; a batch sent after that and acknowledged shows the window took it. */
  answeredAfter?: number;
  /** A gap since the cut, or an answer that came late: the window may not hold it. */
  spoiled: boolean;
}

export class WindowBatcher {
  private readonly batchMs: number;
  private readonly maxBatch: number;
  private readonly maxInFlightBatches: number;
  private readonly maxPending: number;
  private readonly maxPendingBytes: number;
  private readonly stallMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  /** Queued envelopes by seq, in seq order (a merge removes the earlier one and appends the later). */
  private pending = new Map<number, EventEnvelope>();
  private pendingBytes = 0;
  private readonly lastDelta = new Map<string, number>();
  private readonly lastAbout = new Map<SessionId, number>();
  private lastBarrier = 0;
  /** The last seq sent to the window; undefined when what it holds is not known (nothing sent yet, or a gap). */
  private lastSent: number | undefined;
  /** The last seq published on the bus (every envelope comes through `push`). */
  private lastSeen = 0;
  private inFlight: InFlight[] = [];
  private lastAckAt: number;
  private overflowed = false;
  /** While let go: whether `snapshot.invalidated` reached the window; `failed` sends each later envelope as a gap. */
  private told: 'awaited' | 'sent' | 'failed' = 'awaited';
  /** The records owed since the last Snapshot read (`cut`); what was owed before it went with that read. */
  private missed: MissedRecords = new Map();
  /** Whether the window is known to hold a Snapshot and every batch since. Not yet when it starts. */
  private holds = false;
  private reading: Reading | undefined;
  private sends = 0;
  private readonly answerWithinMs: number;
  private timer: unknown;
  readonly stats: BatcherStats = { batches: 0, envelopesIn: 0, envelopesSent: 0, merged: 0, overflows: 0, maxPending: 0, maxInFlight: 0, bytesSent: 0 };

  constructor(private readonly options: BatcherOptions) {
    this.batchMs = options.batchMs ?? 16;
    this.maxBatch = options.maxBatch ?? 500;
    this.maxInFlightBatches = options.maxInFlight ?? 4;
    this.maxPending = options.maxPending ?? 5000;
    this.maxPendingBytes = options.maxPendingBytes ?? 16 * 1024 * 1024;
    this.stallMs = options.stallMs ?? 30_000;
    this.answerWithinMs = options.answerWithinMs ?? 10_000;
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.lastAckAt = this.now();
    if (options.startSeq !== undefined) this.lastSent = this.lastSeen = options.startSeq;
  }

  /** One envelope of the bus, in seq order. */
  push(envelope: EventEnvelope): void {
    this.lastSeen = envelope.seq;
    this.stats.envelopesIn++;
    if (this.overflowed) {
      // Let go: only the invalidation reaches it, alone, after the gap it marks. Should that not have reached it, the
      // next envelope goes alone instead: its gap tells the renderer to read again just the same. Sent or not, it is
      // owed (r2): the renderer holds it until the Snapshot comes and then drops it under the Snapshot's seq.
      if (envelope.event.type === 'snapshot.invalidated' || this.told === 'failed') {
        if (this.sendNow([envelope], envelope.seq)) this.told = 'sent';
        else if (envelope.event.type === 'snapshot.invalidated') this.told = 'failed';
      } else noteMissed(this.missed, envelope.event);
      return;
    }
    const { event } = envelope;
    // Whatever invalidated it (a restore, an event not written), the renderer reads again once it sees this.
    if (event.type === 'snapshot.invalidated') this.gap();
    const sessions = sessionsOf(event);
    const key = deltaKey(event);
    if (key !== undefined && sessions !== 'all' && sessions[0] !== undefined) {
      const session = sessions[0];
      const previous = this.lastDelta.get(key);
      const earlier = previous === undefined ? undefined : this.pending.get(previous);
      if (earlier !== undefined && previous !== undefined && this.lastAbout.get(session) === previous && this.lastBarrier < previous) {
        const before = earlier.event as Extract<AppEvent, { type: 'message.delta' | 'item.outputDelta' }>;
        const after = event as typeof before;
        this.pending.delete(previous);
        this.pendingBytes -= sizeOf(before);
        envelope = { ...envelope, event: { ...after, delta: before.delta + after.delta } };
        this.stats.merged++;
      }
      this.lastDelta.set(key, envelope.seq);
    }
    if (sessions === 'all') this.lastBarrier = envelope.seq;
    else for (const session of sessions) this.lastAbout.set(session, envelope.seq);
    this.pending.set(envelope.seq, envelope);
    this.pendingBytes += sizeOf(envelope.event);
    this.stats.maxPending = Math.max(this.stats.maxPending, this.pending.size);
    if (this.pending.size > this.maxPending || this.pendingBytes > this.maxPendingBytes) return this.overflow('queue limit');
    if (this.pending.size >= this.maxBatch) this.drain();
    else this.schedule(this.batchMs);
  }

  /** The renderer applied the batch ending at `toSeq`; an acknowledgement of a batch not waited for is ignored. */
  ack(toSeq: number): void {
    const index = this.inFlight.findIndex((b) => b.toSeq === toSeq);
    if (index < 0) return;
    const acknowledged = this.inFlight[index]!;
    // Batches are applied in order: one acknowledged means those before it were too.
    this.inFlight = this.inFlight.slice(index + 1);
    this.lastAckAt = this.now();
    // Taken after the answer to the read, with no gap since the cut: the window holds that Snapshot and every batch
    // since, so what the read brought back, and what was written down since, is no longer owed.
    const reading = this.reading;
    if (reading !== undefined && !reading.spoiled && reading.answeredAfter !== undefined && acknowledged.index > reading.answeredAfter) {
      this.reading = undefined;
      this.missed = new Map();
      this.holds = true;
    }
    if (this.pending.size > 0) this.drain();
  }

  /**
   * Right before the Snapshot's seq is read, in the same synchronous step: everything queued is sent now (so the next
   * batch starts after the Snapshot's seq and no merge spans it), and a let-go window is fed again from here on.
   * Returns every record owed, for that Snapshot to bring back; they stay owed until the window is known to hold it
   * (`answered`, then an acknowledgement).
   */
  cut(): MissedRecords {
    this.cancelTimer();
    if (this.overflowed) {
      this.overflowed = false;
      this.dropPending();
    } else {
      while (this.pending.size > 0 && !this.overflowed) this.sendChunk(true);
      // A send that failed meanwhile let the window go: what was left is in the missed records.
      if (this.overflowed) {
        this.overflowed = false;
        this.dropPending();
      }
    }
    // The Snapshot read now holds everything up to here; the next batch starts right after it.
    this.lastSent = this.lastSeen;
    // A reading renderer starts over: what was waited for before no longer holds it back.
    this.inFlight = [];
    this.lastAckAt = this.now();
    // What an earlier read was handed and the window is not known to hold goes with this one too (r2): the renderer
    // drops a Snapshot older than an invalidation it saw, and one it gave up waiting for.
    const owed = this.reading === undefined ? new Map<SessionId, MissedSession>() : copyMissed(this.reading.owed);
    mergeMissed(owed, this.missed);
    this.missed = new Map();
    // Until the window is known to hold this one, everything it is sent is written down as well.
    this.holds = false;
    this.reading = { owed, cutAt: this.now(), spoiled: false };
    return owed;
  }

  /**
   * The read `cut` returned `owed` to was answered: once a batch sent from now on is acknowledged, the window holds it.
   * A read that failed is never answered, so what it was to bring back stays owed to the next one.
   */
  answered(owed: MissedRecords): void {
    const reading = this.reading;
    if (reading?.owed !== owed) return;
    if (this.now() - reading.cutAt > this.answerWithinMs) reading.spoiled = true;
    else reading.answeredAfter = this.sends;
  }

  /** Sends what is queued now, as far as the in-flight limit lets it (tests and shutdown). */
  flush(): void {
    this.drain();
  }

  dispose(): void {
    this.cancelTimer();
    this.dropPending();
    this.missed = new Map();
    this.reading = undefined;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Delta keys kept for merging (tests: none once nothing is queued). */
  get mergeKeys(): number {
    return this.lastDelta.size + this.lastAbout.size;
  }

  get inFlightCount(): number {
    return this.inFlight.length;
  }

  private schedule(ms: number): void {
    if (this.timer !== undefined) return;
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      try {
        this.drain();
      } catch (error) {
        // Never out of the timer: the window is told to read again instead.
        this.options.log?.(`[events] sending batches failed (${error instanceof Error ? error.name : 'non-error thrown'}); the window is told to read the Snapshot again`);
        this.overflow('send failed');
      }
    }, ms);
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    this.clearTimer(this.timer);
    this.timer = undefined;
  }

  private drain(): void {
    this.cancelTimer();
    while (this.pending.size > 0 && this.inFlight.length < this.maxInFlightBatches && !this.overflowed) this.sendChunk(false);
    if (this.pending.size === 0 || this.overflowed) return;
    // Held back by the renderer: looked at again shortly; a renderer that answers nothing for long is let go.
    const oldest = this.inFlight[0];
    if (oldest !== undefined && this.now() - Math.max(oldest.sentAt, this.lastAckAt) >= this.stallMs) return this.overflow('no acknowledgement');
    this.schedule(Math.max(this.batchMs, 50));
  }

  private sendChunk(untracked: boolean): void {
    const envelopes: EventEnvelope[] = [];
    for (const [seq, envelope] of this.pending) {
      envelopes.push(envelope);
      this.pending.delete(seq);
      this.pendingBytes -= sizeOf(envelope.event);
      // Out of the queue, a delta can no longer be merged into (r1 P2: the keys would otherwise pile up).
      const key = deltaKey(envelope.event);
      if (key !== undefined && this.lastDelta.get(key) === seq) this.lastDelta.delete(key);
      if (envelopes.length >= this.maxBatch) break;
    }
    if (this.pending.size === 0) {
      this.pendingBytes = 0;
      this.lastDelta.clear();
      this.lastAbout.clear();
    }
    const first = envelopes[0];
    if (first === undefined) return;
    this.sendNow(envelopes, this.lastSent === undefined ? first.seq : this.lastSent + 1, !untracked);
  }

  /**
   * Whether the batch reached the window. One that did not leaves a gap the renderer sees, and its records are owed.
   * Untracked batches (sent by `cut`, or while let go) and every batch while the window is not known to hold a Snapshot
   * are owed even when sent: the renderer may drop them under the Snapshot's seq (r2).
   */
  private sendNow(envelopes: EventEnvelope[], fromSeq: number, tracked = false): boolean {
    const toSeq = envelopes[envelopes.length - 1]!.seq;
    const notSent = () => {
      // The next batch shows the gap (never passed off as merged deltas), so the window reads again.
      this.lastSent = undefined;
      this.gap();
      for (const e of envelopes) noteMissed(this.missed, e.event);
    };
    const batch: EventBatch = { schemaVersion: CONTRACTS_VERSION, fromSeq, toSeq, envelopes };
    if (!wellFormed(batch)) {
      this.options.log?.('[events] a batch was out of order; the window is told to read the Snapshot again');
      notSent();
      this.overflow('malformed batch');
      return false;
    }
    try {
      const target = this.options.target();
      if (target === null || !target.isAvailable()) {
        notSent();
        return false;
      }
      target.send(batch);
    } catch (error) {
      // Taken out of the queue and not delivered: told to read again, so the gap is never hidden (r1 P1-2).
      this.options.log?.(`[events] a batch could not be sent (${error instanceof Error ? error.name : 'non-error thrown'}); the window is told to read the Snapshot again`);
      notSent();
      this.overflow('send failed');
      return false;
    }
    this.lastSent = toSeq;
    this.sends++;
    this.stats.batches++;
    this.stats.envelopesSent += envelopes.length;
    for (const e of envelopes) this.stats.bytesSent += sizeOf(e.event);
    if (!tracked || !this.holds) for (const e of envelopes) noteMissed(this.missed, e.event);
    if (tracked) {
      this.inFlight.push({ toSeq, sentAt: this.now(), index: this.sends });
      this.stats.maxInFlight = Math.max(this.stats.maxInFlight, this.inFlight.length);
    }
    return true;
  }

  /** The window will read again, or might: it is no longer known to hold a Snapshot, nor the read under way. */
  private gap(): void {
    this.holds = false;
    if (this.reading !== undefined) this.reading.spoiled = true;
  }

  private dropPending(): void {
    this.pending = new Map();
    this.pendingBytes = 0;
    this.lastDelta.clear();
    this.lastAbout.clear();
  }

  private overflow(why: string): void {
    if (this.overflowed) return;
    this.options.log?.(`[events] the window fell behind (${why}); it is told to read the Snapshot again`);
    this.cancelTimer();
    this.overflowed = true;
    this.told = 'awaited';
    this.gap();
    this.stats.overflows++;
    // What is let go is owed to the next Snapshot.
    for (const e of this.pending.values()) noteMissed(this.missed, e.event);
    this.dropPending();
    this.inFlight = [];
    this.options.invalidate();
  }
}

/** The C-27 shape checks that do not need the schema (it costs too much per batch on the main thread). */
const wellFormed = (batch: EventBatch): boolean => {
  const { envelopes, fromSeq, toSeq } = batch;
  if (envelopes.length === 0 || fromSeq < 1 || fromSeq > toSeq || envelopes[0]!.seq < fromSeq || envelopes.at(-1)!.seq !== toSeq) return false;
  for (let i = 1; i < envelopes.length; i++) if (envelopes[i]!.seq <= envelopes[i - 1]!.seq) return false;
  return true;
};
