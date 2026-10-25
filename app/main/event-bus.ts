import { AppEvent, CONTRACTS_VERSION, EventEnvelope } from '../../contracts';

export interface EventBusOptions {
  /** Seq of the state already in the Snapshot; the first published envelope gets `seq + 1`. */
  seq?: number;
  /** Called with a readable reason when an event is dropped for failing validation. */
  onRejected?: (reason: string) => void;
  /** Called when a listener throws; the other listeners still receive the envelope. */
  onListenerError?: (error: unknown) => void;
}

/**
 * Turns events into versioned, strictly increasing envelopes (EventEnvelope.seq) and fans them out.
 * An event that fails validation is dropped before it takes a seq, so the sequence has no gaps.
 */
export class EventBus {
  #seq: number;
  readonly #listeners = new Set<(envelope: EventEnvelope) => void>();
  readonly #onRejected: (reason: string) => void;
  readonly #onListenerError: (error: unknown) => void;

  constructor(options: EventBusOptions = {}) {
    this.#seq = options.seq ?? 0;
    this.#onRejected = options.onRejected ?? ((reason) => console.error(`[event-bus] dropped an invalid event: ${reason}`));
    this.#onListenerError = options.onListenerError ?? ((error) => console.error('[event-bus] a listener threw', error));
  }

  /** Seq of the last published envelope; a Snapshot taken now reflects every event up to this seq. */
  get seq(): number {
    return this.#seq;
  }

  /** Validates, sequences and delivers one event. Returns the envelope, or null when the event was dropped. */
  publish(event: AppEvent): EventEnvelope | null {
    const parsedEvent = AppEvent.safeParse(event);
    if (!parsedEvent.success) {
      this.#onRejected(parsedEvent.error.message);
      return null;
    }
    const envelope = EventEnvelope.parse({ schemaVersion: CONTRACTS_VERSION, seq: this.#seq + 1, event: parsedEvent.data });
    this.#seq = envelope.seq;
    for (const listener of [...this.#listeners]) {
      try {
        listener(envelope);
      } catch (error) {
        this.#onListenerError(error);
      }
    }
    return envelope;
  }

  /** Returns the function that cancels the subscription. */
  subscribe(listener: (envelope: EventEnvelope) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}
