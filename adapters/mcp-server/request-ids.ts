// Which JSON-RPC request IDs an MCP session is still answering (T016 review r2/r3). The SDK maps a
// response to its HTTP stream by request ID, so a second request with an ID still in use would receive
// the first one's answer, or take its answer away. An ID stays taken until no answer for it can be
// written any more, whatever happened to the HTTP response, and only then may a new request use it.
//
// What this relies on, checked against @modelcontextprotocol/sdk 1.32.2 (pinned; the version test in
// request-ids.test.ts fails on any other version so the next upgrade checks these again):
//   1. Every response or error response the SDK writes for a request goes through `transport.send`.
//   2. A request is handed to the SDK through `transport.onmessage`, and so is `notifications/cancelled`.
//   3. Once a request is cancelled, the SDK checks the abort before sending its answer and sends nothing;
//      a send already started before the cancel arrived is still seen as a send in progress (`send` is
//      called right after that check, with no await between).
// No timer or event-loop ordering is assumed beyond that.

/** A request that took an ID. */
export interface TakenId {
  /** The SDK has the request: from then on only the SDK finishing with it frees the ID. */
  dispatched: boolean;
  /** Sends of its answer in progress. */
  sending: number;
}

/** JSON text of a JSON-RPC ID, so 7 and "7" stay apart; undefined for anything that is not an ID. */
export const idKey = (id: unknown): string | undefined => (typeof id === 'string' || typeof id === 'number' ? JSON.stringify(id) : undefined);

const isObject = (message: unknown): message is Record<string, unknown> => message !== null && typeof message === 'object';

/** The ID of a JSON-RPC request (not a notification or a response). */
export const requestKeyOf = (message: unknown): string | undefined =>
  isObject(message) && typeof message['method'] === 'string' && 'id' in message ? idKey(message['id']) : undefined;

/** The ID of a JSON-RPC response or error response (not a request the server sends). */
export const responseKeyOf = (message: unknown): string | undefined =>
  isObject(message) && !('method' in message) && ('result' in message || 'error' in message) ? idKey(message['id']) : undefined;

/** The request ID a `notifications/cancelled` names. */
export const cancelledKeyOf = (message: unknown): string | undefined => {
  if (!isObject(message) || message['method'] !== 'notifications/cancelled' || 'id' in message) return undefined;
  const params = message['params'];
  return isObject(params) ? idKey(params['requestId']) : undefined;
};

export class RequestIds {
  readonly #ids = new Map<string, TakenId>();

  has(key: string): boolean {
    return this.#ids.has(key);
  }

  get size(): number {
    return this.#ids.size;
  }

  /** Takes `key` for a request accepted over HTTP; the caller has checked it was free. */
  take(key: string): TakenId {
    const entry: TakenId = { dispatched: false, sending: 0 };
    this.#ids.set(key, entry);
    return entry;
  }

  /** A message is about to reach the SDK. */
  received(message: unknown): void {
    const request = requestKeyOf(message);
    if (request !== undefined) {
      const entry = this.#ids.get(request);
      if (entry) entry.dispatched = true;
      return;
    }
    const cancelled = cancelledKeyOf(message);
    const entry = cancelled === undefined ? undefined : this.#ids.get(cancelled);
    // Cancelled: the SDK will send nothing more for it; a send already under way frees it when done.
    if (cancelled !== undefined && entry?.dispatched && entry.sending === 0) this.#release(cancelled, entry);
  }

  /** A message is being sent; returns what `sent` needs to free the ID after it. */
  sending(message: unknown): { key: string; entry: TakenId } | undefined {
    const key = responseKeyOf(message);
    const entry = key === undefined ? undefined : this.#ids.get(key);
    if (key === undefined || !entry) return undefined;
    entry.sending++;
    return { key, entry };
  }

  /** The answer has been written, or could not be written; either way it was the request's only answer. */
  sent(taken: { key: string; entry: TakenId }): void {
    taken.entry.sending--;
    this.#release(taken.key, taken.entry);
  }

  /**
   * The HTTP response of the request closed. Not dispatched: nothing else will free it. Dispatched: its
   * answer may still be written (e.g. the handler still runs), so it stays taken until sent or cancelled.
   */
  closed(key: string, entry: TakenId): void {
    if (!entry.dispatched) this.#release(key, entry);
  }

  /** Frees an ID only for the request that took it, never for a later one with the same ID. */
  #release(key: string, entry: TakenId): void {
    if (this.#ids.get(key) === entry) this.#ids.delete(key);
  }
}
