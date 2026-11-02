// Event batches for one window (C-27, V-18, T040): the bus's envelopes are queued per window and sent as EventBatch,
// at most every `batchMs`. Only deltas merge (MERGEABLE_EVENT_TYPES): a delta is folded into the queued delta of the
// same message (or item output) when no event about the same session lies between them, and takes the later seq.
// Every other envelope is sent once, unmerged, in seq order. Batches follow each other without gaps.
//
// Flow control: the preload acknowledges each batch once the renderer's listener returned; at most `maxInFlight`
// batches go unacknowledged, and meanwhile envelopes wait (deltas keep merging). A window whose queue grows past its
// limits, or that acknowledges nothing for `stallMs`, is no longer fed: its queue is let go, `snapshot.invalidated`
// (`event-overflow`) is sent to it, and it gets batches again once it read the Snapshot (`cut`). Nothing it was not
// sent is lost to it: what it missed is in that Snapshot, which is read after (C-05).
//
// Electron-free: the IPC layer (app-ipc.ts) gives it the window and the timers.
import { CONTRACTS_VERSION, type AppEvent, type EventBatch, type EventEnvelope, type SessionId } from '../../contracts';

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
  private timer: unknown;
  readonly stats: BatcherStats = { batches: 0, envelopesIn: 0, envelopesSent: 0, merged: 0, overflows: 0, maxPending: 0, maxInFlight: 0, bytesSent: 0 };

  constructor(private readonly options: BatcherOptions) {
    this.batchMs = options.batchMs ?? 16;
    this.maxBatch = options.maxBatch ?? 500;
    this.maxInFlightBatches = options.maxInFlight ?? 4;
    this.maxPending = options.maxPending ?? 5000;
    this.maxPendingBytes = options.maxPendingBytes ?? 16 * 1024 * 1024;
    this.stallMs = options.stallMs ?? 30_000;
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
      // Let go: only the invalidation reaches it, alone, after the gap it marks.
      if (envelope.event.type === 'snapshot.invalidated') this.sendNow([envelope], envelope.seq);
      return;
    }
    const { event } = envelope;
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
    // Batches are applied in order: one acknowledged means those before it were too.
    this.inFlight = this.inFlight.slice(index + 1);
    this.lastAckAt = this.now();
    if (this.pending.size > 0) this.drain();
  }

  /**
   * Right before the Snapshot's seq is read, in the same synchronous step: everything queued is sent now (so the next
   * batch starts after the Snapshot's seq and no merge spans it), and a let-go window is fed again from here on.
   */
  cut(): void {
    this.cancelTimer();
    if (this.overflowed) {
      this.overflowed = false;
      this.dropPending();
    } else {
      while (this.pending.size > 0) this.sendChunk(true);
    }
    // The Snapshot read now holds everything up to here; the next batch starts right after it.
    this.lastSent = this.lastSeen;
    // A reading renderer starts over: what was waited for before no longer holds it back.
    this.inFlight = [];
    this.lastAckAt = this.now();
  }

  /** Sends what is queued now, as far as the in-flight limit lets it (tests and shutdown). */
  flush(): void {
    this.drain();
  }

  dispose(): void {
    this.cancelTimer();
    this.dropPending();
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get inFlightCount(): number {
    return this.inFlight.length;
  }

  private schedule(ms: number): void {
    if (this.timer !== undefined) return;
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      this.drain();
    }, ms);
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    this.clearTimer(this.timer);
    this.timer = undefined;
  }

  private drain(): void {
    this.cancelTimer();
    while (this.pending.size > 0 && this.inFlight.length < this.maxInFlightBatches) this.sendChunk(false);
    if (this.pending.size === 0) return;
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
      if (envelopes.length >= this.maxBatch) break;
    }
    if (this.pending.size === 0) this.pendingBytes = 0;
    const first = envelopes[0];
    if (first === undefined) return;
    this.sendNow(envelopes, this.lastSent === undefined ? first.seq : this.lastSent + 1, untracked);
  }

  private sendNow(envelopes: EventEnvelope[], fromSeq: number, untracked = true): void {
    const toSeq = envelopes[envelopes.length - 1]!.seq;
    const target = this.options.target();
    if (target === null || !target.isAvailable()) {
      // Not delivered: the next batch shows the gap (never passed off as merged deltas), so the window reads again.
      this.lastSent = undefined;
      return;
    }
    const batch: EventBatch = { schemaVersion: CONTRACTS_VERSION, fromSeq, toSeq, envelopes };
    if (!wellFormed(batch)) {
      this.options.log?.('[events] a batch was out of order; the window is told to read the Snapshot again');
      this.lastSent = undefined;
      return this.overflow('malformed batch');
    }
    target.send(batch);
    this.lastSent = toSeq;
    this.stats.batches++;
    this.stats.envelopesSent += envelopes.length;
    for (const e of envelopes) this.stats.bytesSent += sizeOf(e.event);
    if (!untracked) {
      this.inFlight.push({ toSeq, sentAt: this.now() });
      this.stats.maxInFlight = Math.max(this.stats.maxInFlight, this.inFlight.length);
    }
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
    this.stats.overflows++;
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
