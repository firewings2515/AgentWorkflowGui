// A fixed, seeded stream of events for the batching tests and the performance baseline (T040): deltas of several
// messages and item outputs in a few sessions, interleaved with every kind of event that must never be merged or
// dropped (permission requests, turn ends, escalations, handoffs, transfers, completed messages, ...).
import { MERGEABLE_EVENT_TYPES, type AppEvent, type EventBatch, type EventEnvelope, type MessageId, type SessionId } from '../../../contracts';
import { fixtureSnapshot } from '../../../contracts/fixtures/snapshot';

export const STREAM_SESSIONS = ['s-research', 's-wf-build-a', 's-wf-build-b'] as SessionId[];

/** mulberry32: the same seed gives the same stream on every machine. */
export const seeded = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const f = fixtureSnapshot;
const at = '2026-11-03T10:00:00.000Z';

/** One event of the stream; `i` makes texts and IDs distinct. */
export const streamEvent = (random: () => number, i: number): AppEvent => {
  const sessionId = STREAM_SESSIONS[Math.floor(random() * STREAM_SESSIONS.length)]!;
  const r = random();
  // Few messages per session at a time, so deltas of one message often follow each other.
  const message = `m-${sessionId}-${Math.floor(i / 400) % 3}` as MessageId;
  if (r < 0.7) return { type: 'message.delta', sessionId, turnId: f.turns[0]!.id, messageId: message, delta: `d${String(i)} ` };
  if (r < 0.85) return { type: 'item.outputDelta', sessionId, itemId: f.items[i % 2]!.id, delta: `o${String(i)}\n` };
  const k = Math.floor(random() * 10);
  switch (k) {
    case 0:
      return { type: 'permission.updated', request: { ...f.permissionRequests[0]!, sessionId } };
    case 1:
      return { type: 'turn.updated', turn: { ...f.turns[1]!, sessionId } };
    case 2:
      return { type: 'escalation.updated', escalation: f.escalations[i % f.escalations.length]! };
    case 3:
      return { type: 'handoff.updated', handoff: f.handoffs[i % f.handoffs.length]! };
    case 4:
      return { type: 'transfer.updated', proposal: f.transfers[i % f.transfers.length]! };
    case 5:
      return { type: 'message.completed', message: { ...f.messages[0]!, sessionId } };
    case 6:
      return { type: 'session.activity', sessionId, activity: 'running', at };
    case 7:
      return { type: 'item.updated', item: { ...f.items[0]!, sessionId } };
    case 8:
      return { type: 'usage.limits', at };
    default:
      return { type: 'session.updated', session: { ...f.sessions.find((s) => s.id === sessionId)! } };
  }
};

export const isDelta = (event: AppEvent): event is Extract<AppEvent, { type: (typeof MERGEABLE_EVENT_TYPES)[number] }> =>
  (MERGEABLE_EVENT_TYPES as readonly string[]).includes(event.type);

export const deltaKeyOf = (event: AppEvent): string =>
  event.type === 'message.delta' ? `m|${event.sessionId}|${event.messageId}` : event.type === 'item.outputDelta' ? `i|${event.sessionId}|${event.itemId}` : '';

/** What a renderer that applied every batch in order holds, to compare with what was published. */
export class BatchLedger {
  readonly batches: EventBatch[] = [];
  readonly kept: EventEnvelope[] = [];
  readonly text = new Map<string, string>();
  /** Batches that did not start right after the last one (the renderer would read the Snapshot again). */
  gaps = 0;
  lastSeq: number | undefined;

  apply(batch: EventBatch): void {
    this.batches.push(batch);
    if (this.lastSeq !== undefined && batch.fromSeq !== this.lastSeq + 1) this.gaps++;
    this.lastSeq = batch.toSeq;
    for (const envelope of batch.envelopes) {
      if (isDelta(envelope.event)) this.text.set(deltaKeyOf(envelope.event), (this.text.get(deltaKeyOf(envelope.event)) ?? '') + envelope.event.delta);
      else this.kept.push(envelope);
    }
  }
}
