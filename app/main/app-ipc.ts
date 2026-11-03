import { ipcMain } from 'electron';
import { Command, CommandResult, type EventBatch, type EventEnvelope, QueryRequest, QueryResult, RequestId, Snapshot } from '../../contracts';
import type { SnapshotRead } from '../preload/bridge-types';
import { BATCH_ACK_CHANNEL, BATCH_CHANNEL, COMMAND_CHANNEL, QUERY_CHANNEL, SNAPSHOT_CHANNEL, SNAPSHOT_READ_CHANNEL, WINDOW_REPORT_CHANNEL } from '../preload/channels';
import { type BatcherOptions, WindowBatcher } from './event-batcher';
import type { EventBus } from './event-bus';
import type { MissedRecords } from './missed-records';
import { failure, type AppFacade } from './facade';
import { handleTrusted } from './ipc';
import { isTrustedSender, type IpcSenderEvent, type TrustedSender } from './ipc-guard';
import { describeIssues } from './issues';

/** Used when a malformed command carries no usable requestId, so the reply is still a valid CommandResult. */
export const UNKNOWN_REQUEST_ID = RequestId.parse('unknown');

function requestIdOf(raw: unknown): RequestId {
  if (typeof raw !== 'object' || raw === null) return UNKNOWN_REQUEST_ID;
  const parsed = RequestId.safeParse((raw as { requestId?: unknown }).requestId);
  return parsed.success ? parsed.data : UNKNOWN_REQUEST_ID;
}

/**
 * Runs one command from the renderer. Never throws: a malformed command, a facade that throws and a facade
 * that answers with something outside the contract all come back as a failed CommandResult.
 */
export async function runCommand(facade: AppFacade, raw: unknown): Promise<CommandResult> {
  const requestId = requestIdOf(raw);
  const command = Command.safeParse(raw);
  if (!command.success) return failure(requestId, 'invalid_request', `Invalid command. ${describeIssues(command.error)}`);
  try {
    const result = CommandResult.safeParse(await facade.execute(command.data));
    if (result.success && result.data.requestId === command.data.requestId) return result.data;
    // The command ran, so a side effect may have happened even though the answer is unusable.
    return failure(requestId, 'runtime_unavailable', 'The backend answered with an invalid result', { mayHaveSideEffects: true });
  } catch {
    return failure(requestId, 'runtime_unavailable', 'The backend failed while running the command', { mayHaveSideEffects: true });
  }
}

/** What the renderer sees when no valid Snapshot can be produced; the reason stays in the main process log. */
export const SNAPSHOT_UNAVAILABLE = 'The state snapshot is not available';

/**
 * The Snapshot, checked against the contract before it leaves the main process. Electron hands a handler's
 * thrown message to the renderer, so a failure is logged here (field paths only) and rethrown as fixed text.
 */
export async function readSnapshot(facade: AppFacade, log: (message: string) => void = console.error, missed?: MissedRecords): Promise<Snapshot> {
  let raw: unknown;
  let failed = false;
  try {
    raw = await (missed === undefined ? facade.snapshot() : facade.snapshot(missed));
  } catch (error) {
    log(`[ipc] the backend failed to produce a snapshot (${error instanceof Error ? error.name : 'non-error thrown'})`);
    failed = true;
  }
  if (failed) throw new Error(SNAPSHOT_UNAVAILABLE);
  const parsed = Snapshot.safeParse(raw);
  if (!parsed.success) {
    log(`[ipc] the backend produced an invalid snapshot: ${describeIssues(parsed.error)}`);
    throw new Error(SNAPSHOT_UNAVAILABLE);
  }
  return parsed.data;
}

/** What the renderer gets when a query cannot be answered: fixed text, nothing of the request or the error. */
export const QUERY_FAILED = 'The query could not be answered';

/**
 * Runs one read-only query (C-26, C-28). Never throws: a malformed request, a facade that throws and an answer
 * outside the contract (another request's, a page of another session) all come back as a failed QueryResult.
 */
export async function runQuery(facade: AppFacade, raw: unknown, log: (message: string) => void = console.error): Promise<QueryResult> {
  const parsedId = RequestId.safeParse(typeof raw === 'object' && raw !== null ? (raw as { requestId?: unknown }).requestId : undefined);
  const requestId = parsedId.success ? parsedId.data : null;
  const request = QueryRequest.safeParse(raw);
  if (!request.success) return { ok: false, requestId, code: 'invalid_request', message: `Invalid query. ${describeIssues(request.error)}` };
  const internal = (): QueryResult => ({ ok: false, requestId: request.data.requestId, code: 'internal_error', message: QUERY_FAILED });
  if (facade.query === undefined) return internal();
  let answer: unknown;
  try {
    answer = await facade.query(request.data);
  } catch (error) {
    log(`[ipc] ${request.data.type} failed (${error instanceof Error ? error.name : 'non-error thrown'})`);
    return internal();
  }
  const result = QueryResult.safeParse(answer);
  if (!result.success) {
    log(`[ipc] the backend answered ${request.data.type} outside the contract: ${describeIssues(result.error)}`);
    return internal();
  }
  const r = result.data;
  // Only this request's answer, of its type, and a history page only of the session asked for.
  const mismatch =
    r.requestId !== request.data.requestId ||
    (r.ok && r.type !== request.data.type) ||
    (r.ok && r.type === 'session.history' && request.data.type === 'session.history' && r.page.sessionId !== request.data.sessionId);
  if (mismatch) {
    log(`[ipc] the backend answered ${request.data.type} with another request's result`);
    return internal();
  }
  return r;
}

/** The part of `WebContents` that event forwarding needs. */
export interface EventTarget {
  isDestroyed(): boolean;
  getURL(): string;
  send(channel: string, batch: EventBatch): void;
}

export type ForwardingOptions = Pick<
  BatcherOptions,
  'batchMs' | 'maxBatch' | 'maxInFlight' | 'maxPending' | 'maxPendingBytes' | 'stallMs' | 'log' | 'now' | 'setTimer' | 'clearTimer'
>;

/**
 * Pushes the bus's envelopes to the window as event batches (C-27), but only while it is alive and still showing one
 * of our pages. A window that falls too far behind is sent `snapshot.invalidated` (`event-overflow`) instead.
 */
export function forwardEvents(
  bus: Pick<EventBus, 'seq' | 'subscribe' | 'publish'>,
  getTarget: () => EventTarget | null,
  isTrustedUrl: (url: string) => boolean,
  options: ForwardingOptions = {},
): { batcher: WindowBatcher; stop: () => void } {
  const batcher = new WindowBatcher({
    ...options,
    startSeq: bus.seq,
    target: () => {
      const target = getTarget();
      if (target === null) return null;
      return {
        isAvailable: () => !target.isDestroyed() && isTrustedUrl(target.getURL()),
        send: (batch) => target.send(BATCH_CHANNEL, batch),
      };
    },
    invalidate: () => void bus.publish({ type: 'snapshot.invalidated', reason: 'event-overflow', at: new Date().toISOString() }),
  });
  const unsubscribe = bus.subscribe((envelope: EventEnvelope) => batcher.push(envelope));
  return {
    batcher,
    stop: () => {
      unsubscribe();
      batcher.dispose();
    },
  };
}

export interface AppIpcOptions {
  facade: AppFacade;
  bus: Pick<EventBus, 'seq' | 'subscribe' | 'publish'>;
  getTrustedSender: () => TrustedSender | null;
  getEventTarget: () => EventTarget | null;
  isTrustedUrl: (url: string) => boolean;
  forwarding?: ForwardingOptions;
  /** The window's batcher, for the performance log (dev runs). */
  onBatcher?: (batcher: WindowBatcher) => void;
  /** Each Snapshot the window read and how long it took (the performance log, dev runs). */
  onSnapshot?: (snapshot: Snapshot, ms: number) => void;
}

/**
 * One Snapshot read of the window (the snapshot handlers; the T040 recovery tests drive it as the renderer does). The
 * cut comes first, in the same synchronous step as the seq the facade reads (C-27). What is owed comes back with this
 * read, named by its number, and stays owed until the renderer says it took this read (event-batcher.ts, r3).
 */
export function readForWindow(batcher: WindowBatcher, facade: AppFacade, onSnapshot?: (snapshot: Snapshot, ms: number) => void): Promise<SnapshotRead> {
  const { read, owed } = batcher.cut();
  const began = performance.now();
  return readSnapshot(facade, console.error, owed).then((snapshot) => {
    onSnapshot?.(snapshot, performance.now() - began);
    return { read, snapshot };
  });
}

/** A WindowReport from the renderer, checked; anything else is undefined (and ignored). */
export const windowReport = (raw: unknown): { kind: 'applied'; toSeq: number } | { kind: 'adopted'; read: number; seq: number } | undefined => {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const seq = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  if (r.kind === 'applied' && seq(r.toSeq) && Object.keys(r).length === 2) return { kind: 'applied', toSeq: r.toSeq };
  if (r.kind === 'adopted' && seq(r.read) && seq(r.seq) && Object.keys(r).length === 3) return { kind: 'adopted', read: r.read, seq: r.seq };
  return undefined;
};

/**
 * Registers the snapshot, command and query handlers and the batch acknowledgement, and starts forwarding events.
 * Returns the function that stops forwarding.
 */
export function registerAppIpc(options: AppIpcOptions): () => void {
  const { facade, bus, getTrustedSender, getEventTarget, isTrustedUrl } = options;
  const { batcher, stop } = forwardEvents(bus, getEventTarget, isTrustedUrl, options.forwarding);
  options.onBatcher?.(batcher);
  // Everything queued goes out before the Snapshot's seq is read, in the same synchronous step (facade.snapshot reads
  // the seq before its first await), so the next batch starts right after that seq (C-27).
  // The read without its number (an older preload): nothing it brings back is taken as reached, so it stays owed.
  handleTrusted(SNAPSHOT_CHANNEL, getTrustedSender, () => readForWindow(batcher, facade, options.onSnapshot).then((r) => r.snapshot));
  handleTrusted(SNAPSHOT_READ_CHANNEL, getTrustedSender, () => readForWindow(batcher, facade, options.onSnapshot));
  handleTrusted(COMMAND_CHANNEL, getTrustedSender, (raw: unknown) => runCommand(facade, raw));
  handleTrusted(QUERY_CHANNEL, getTrustedSender, (raw: unknown) => runQuery(facade, raw));
  const onAck = (event: IpcSenderEvent, toSeq: unknown) => {
    // Only our own window's acknowledgement; anything else is ignored (a send has no answer to reject).
    if (!isTrustedSender(event, getTrustedSender())) return;
    if (typeof toSeq === 'number' && Number.isSafeInteger(toSeq)) batcher.ack(toSeq);
  };
  ipcMain.on(BATCH_ACK_CHANNEL, onAck);
  // What the renderer says reached it (T040 r3): only that lets the batcher stop owing a record.
  const onReport = (event: IpcSenderEvent, raw: unknown) => {
    if (!isTrustedSender(event, getTrustedSender())) return;
    const report = windowReport(raw);
    if (report?.kind === 'applied') batcher.applied(report.toSeq);
    else if (report?.kind === 'adopted') batcher.adopted(report.read, report.seq);
  };
  ipcMain.on(WINDOW_REPORT_CHANNEL, onReport);
  return () => {
    ipcMain.removeListener(BATCH_ACK_CHANNEL, onAck);
    ipcMain.removeListener(WINDOW_REPORT_CHANNEL, onReport);
    stop();
  };
}
