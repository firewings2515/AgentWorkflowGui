// A fake `RuntimeAdapter` for the dispatcher's tests (T008). Its `history` stands in for the runtime's
// persisted sessions and outlives a GUI restart (share it between the old and the new adapter), so a
// crash after the payload reached the runtime can be reconciled later, as with the spike's receiver.
// Each call to dispatchOnce / startSession takes the next queued mode; reconcile reads `history` the way
// the real adapters do: by clientMessageId, then target and content.
import type {
  DispatchRequest,
  DispatchResult,
  NativeSessionInfo,
  ReconcileMatch,
  ReconcileProvisionResult,
  ReconcileRequest,
  ReconcileResult,
  RuntimeAdapter,
  StartSessionOptions,
} from '../../ports';
import type { Runtime } from '../../../contracts';

export interface StoredMessage {
  sessionRef: string;
  clientMessageId: string;
  text: string;
  turnRef: string;
  itemRef: string;
}

/** What the runtime has persisted; survives the GUI process. */
export class FakeHistory {
  readonly messages: StoredMessage[] = [];
  readonly sessions: string[] = [];

  /** Messages the runtime received for `sessionRef` (all sessions when omitted). */
  received(sessionRef?: string): StoredMessage[] {
    return this.messages.filter((m) => sessionRef === undefined || m.sessionRef === sessionRef);
  }
}

/**
 * `ack`: stored and acknowledged. `crash-before-send` / `crash-after-receive`: the GUI dies before the
 * payload left / after the runtime stored it; the call never settles. `timeout`: stored, no ack.
 * `reject`: refused locally, nothing stored. `throw`: the adapter throws. `ack-elsewhere`: stored, but
 * the ack names another session.
 */
export type DispatchMode = 'ack' | 'crash-before-send' | 'crash-after-receive' | 'timeout' | 'reject' | 'throw' | 'ack-elsewhere';
/**
 * `ok`: created and returned. `lost-response`: created, then the call fails. `crash`: created, never
 * settles. `fail`: nothing created. `held`: created, and the response arrives when the test calls
 * `release()` (a slow create the user may cancel meanwhile).
 */
export type StartMode = 'ok' | 'lost-response' | 'crash' | 'fail' | 'held';
/** `history`: read `history`. `read-failed` / `throw`: the read fails. `lagging`: the history is not flushed yet. */
export type ReconcileMode = 'history' | 'read-failed' | 'throw' | 'lagging';

const never = <T>() => new Promise<T>(() => undefined);

export class FakeRuntime implements RuntimeAdapter {
  readonly dispatched: DispatchRequest[] = [];
  readonly reconciled: ReconcileRequest[] = [];
  readonly started: StartSessionOptions[] = [];
  readonly dispatchModes: DispatchMode[] = [];
  readonly startModes: StartMode[] = [];
  readonly reconcileModes: ReconcileMode[] = [];
  private readonly held: (() => void)[] = [];

  constructor(
    readonly runtime: Runtime,
    readonly history: FakeHistory = new FakeHistory(),
    /** Native IDs for sessions created without a pre-allocated one (Codex picks its thread ID). */
    private readonly newSessionRef: () => string = () => `thread-${String(history.sessions.length + 1)}`,
  ) {}

  start(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<{ forced: boolean }> {
    return Promise.resolve({ forced: false });
  }

  closeSession(): Promise<{ forced: boolean }> {
    return Promise.resolve({ forced: false });
  }

  reconcileProvision(): Promise<ReconcileProvisionResult> {
    return Promise.resolve({ state: 'unknown', reason: 'unsupported', detail: 'fake runtime' });
  }

  startSession(options: StartSessionOptions): Promise<NativeSessionInfo> {
    this.started.push(options);
    const mode = this.startModes.shift() ?? 'ok';
    if (mode === 'fail') return Promise.reject(new Error('thread/start failed'));
    const ref = options.preallocatedRef ?? this.newSessionRef();
    this.history.sessions.push(ref);
    if (mode === 'crash') return never();
    if (mode === 'lost-response') return Promise.reject(new Error('the create response was lost'));
    const info: NativeSessionInfo = { sessionId: options.sessionId, nativeSessionRef: ref, cwd: options.cwd, model: { source: 'unknown' } };
    if (mode === 'held') return new Promise((resolve) => this.held.push(() => resolve(info)));
    return Promise.resolve(info);
  }

  /** Lets the oldest `held` call answer. */
  release(): void {
    this.held.shift()?.();
  }

  resumeSession(): Promise<NativeSessionInfo> {
    return Promise.reject(new Error('not used by the delivery service'));
  }

  dispatchOnce(request: DispatchRequest): Promise<DispatchResult> {
    this.dispatched.push(request);
    const mode = this.dispatchModes.shift() ?? 'ack';
    if (mode === 'crash-before-send') return never();
    if (mode === 'throw') return Promise.reject(new Error('dispatchOnce: thread is not bound to a session'));
    if (mode === 'reject') return Promise.resolve({ state: 'unknown', reason: 'rejected', written: false, detail: 'no running turn to insert into' });
    const stored = this.store(request);
    if (mode === 'crash-after-receive') return never();
    if (mode === 'timeout') return Promise.resolve({ state: 'unknown', reason: 'timeout', written: true, detail: 'no ack within the timeout' });
    return Promise.resolve({
      state: 'sent',
      nativeRef: { sessionRef: mode === 'ack-elsewhere' ? 'thread-elsewhere' : stored.sessionRef, turnRef: stored.turnRef, itemRef: stored.itemRef },
      evidence: { kind: 'live-ack', at: '2026-10-26T01:00:30.000Z', detail: `accepted ${request.attempt.clientMessageId}` },
    });
  }

  reconcile(request: ReconcileRequest): Promise<ReconcileResult> {
    this.reconciled.push(request);
    const mode = this.reconcileModes.shift() ?? 'history';
    if (mode === 'throw') return Promise.reject(new Error('history read threw'));
    if (mode === 'read-failed') return Promise.resolve({ state: 'unknown', reason: 'read-failed', matches: [], detail: 'paging failed' });
    const stored = mode === 'lagging' ? [] : this.history.messages.filter((m) => m.clientMessageId === request.clientMessageId);
    const matches: ReconcileMatch[] = stored.map((m) => ({
      turnRef: m.turnRef,
      itemRef: m.itemRef,
      contentMatches: m.sessionRef === request.nativeSessionRef && m.text === request.text,
    }));
    const [match] = matches;
    if (match === undefined) return Promise.resolve({ state: 'unknown', reason: 'not-found', matches, detail: 'no stored message with this id' });
    if (matches.length > 1) return Promise.resolve({ state: 'unknown', reason: 'duplicate', matches, detail: `${matches.length} stored messages carry this id` });
    if (!match.contentMatches) return Promise.resolve({ state: 'unknown', reason: 'content-mismatch', matches, detail: 'another session or other content' });
    return Promise.resolve({
      state: 'sent',
      nativeRef: { sessionRef: request.nativeSessionRef, turnRef: match.turnRef, itemRef: match.itemRef },
      evidence: { kind: 'reconciled', at: '2026-10-26T01:01:00.000Z', detail: `stored ${match.itemRef} has the same id and text` },
    });
  }

  readHistory(): Promise<never> {
    return Promise.reject(new Error('not used by the delivery service'));
  }

  interrupt(): Promise<void> {
    return Promise.resolve();
  }

  setModel(): Promise<'next-turn'> {
    return Promise.resolve('next-turn');
  }

  stopNativeTask(): Promise<void> {
    return Promise.resolve();
  }

  listModels(): Promise<never[]> {
    return Promise.resolve([]);
  }

  subscribe(): () => void {
    return () => undefined;
  }

  private store(request: DispatchRequest): StoredMessage {
    const n = this.history.messages.length + 1;
    const message = { sessionRef: request.nativeSessionRef, clientMessageId: request.attempt.clientMessageId, text: request.text, turnRef: `turn-${n}`, itemRef: `item-${n}` };
    this.history.messages.push(message);
    return message;
  }
}
