// A fake runtime adapter for the session service's tests: records every call (with the MCP mount it got),
// lets a test emit runtime events and approval requests, and answers dispatches as told.
import type { ModelOption, ModelSelection, ObservedModel, PermissionDecision, PermissionHold, PermissionRequest, Runtime, SessionId } from '../../../contracts';
import type {
  DispatchRequest,
  DispatchResult,
  HistoryResult,
  NativeSessionInfo,
  PermissionHandle,
  ReconcileProvisionResult,
  ReconcileRequest,
  ReconcileResult,
  ResumeSessionOptions,
  RuntimeAdapter,
  RuntimeEvent,
  StartSessionOptions,
} from '../../ports';

/**
 * `ack`: sent. `unknown`: stored by the runtime, no ack. `lost`: no ack and not stored (reconcile finds
 * nothing). `reject`: refused locally, nothing left the process.
 */
export type FakeDispatch = 'ack' | 'unknown' | 'lost' | 'reject';

export class FakeAdapter implements RuntimeAdapter {
  readonly calls: string[] = [];
  readonly started: StartSessionOptions[] = [];
  readonly resumed: ResumeSessionOptions[] = [];
  readonly dispatched: DispatchRequest[] = [];
  readonly reconciled: ReconcileRequest[] = [];
  readonly models: { ref: string; model: ModelSelection }[] = [];
  readonly stoppedTasks: { ref: string; taskRef: string }[] = [];
  readonly closedSessions: string[] = [];
  dispatchModes: FakeDispatch[] = [];
  /** `held`: answers when the test calls `release()`. */
  startModes: ('ok' | 'fail' | 'lost' | 'held')[] = [];
  /** The message a failed start rejects with (e.g. one quoting the MCP mount). */
  startError = 'could not start';
  /** What start and resume report as the observed model (Codex: the configured one). */
  openedModel: ObservedModel = { source: 'unknown' };
  /** When set, setModel waits for it; `setModelError` makes it fail. */
  setModelGate: Promise<void> | undefined;
  setModelError: Error | undefined;
  private readonly held: (() => void)[] = [];
  /** What the runtime has stored, by clientMessageId, for reconcile. */
  readonly history = new Map<string, { ref: string; text: string }>();
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private next = 0;

  constructor(
    readonly runtime: Runtime,
    private readonly onPermission: (handle: PermissionHandle) => unknown = () => undefined,
  ) {}

  /** When set, start() and resumeSession() wait for it (an initialize or a resume that hangs). */
  startGate: Promise<void> | undefined;
  resumeGate: Promise<void> | undefined;

  async start(): Promise<void> {
    this.calls.push('start');
    await this.startGate;
  }

  close(): Promise<{ forced: boolean }> {
    this.calls.push('close');
    return Promise.resolve({ forced: false });
  }

  startSession(options: StartSessionOptions): Promise<NativeSessionInfo> {
    this.calls.push('startSession');
    this.started.push(options);
    const mode = this.startModes.shift() ?? 'ok';
    if (mode === 'fail') return Promise.reject(new Error(this.startError));
    if (mode === 'lost') return Promise.reject(new Error('the create response was lost'));
    const ref = options.preallocatedRef ?? `thread-${++this.next}`;
    const info: NativeSessionInfo = { sessionId: options.sessionId, nativeSessionRef: ref, cwd: options.cwd, model: this.openedModel };
    if (mode === 'held') return new Promise((resolve) => this.held.push(() => resolve(info)));
    return Promise.resolve(info);
  }

  /** Lets the oldest held start answer. */
  release(): void {
    this.held.shift()?.();
  }

  async resumeSession(options: ResumeSessionOptions): Promise<NativeSessionInfo> {
    this.calls.push('resumeSession');
    this.resumed.push(options);
    await this.resumeGate;
    return { sessionId: options.sessionId, nativeSessionRef: options.nativeSessionRef, cwd: options.cwd, model: this.openedModel };
  }

  closeSession(ref: string): Promise<{ forced: boolean }> {
    this.calls.push('closeSession');
    this.closedSessions.push(ref);
    return Promise.resolve({ forced: false });
  }

  reconcileProvision(): Promise<ReconcileProvisionResult> {
    return Promise.resolve({ state: 'unknown', reason: 'unsupported', detail: 'fake' });
  }

  dispatchOnce(request: DispatchRequest): Promise<DispatchResult> {
    this.calls.push('dispatchOnce');
    this.dispatched.push(request);
    const mode = this.dispatchModes.shift() ?? 'ack';
    if (mode === 'lost') return Promise.resolve({ state: 'unknown', reason: 'disconnected', written: true, detail: 'connection lost' });
    if (mode === 'reject') return Promise.resolve({ state: 'unknown', reason: 'rejected', written: false, detail: 'refused' });
    this.history.set(request.attempt.clientMessageId, { ref: request.nativeSessionRef, text: request.text });
    if (mode === 'unknown') return Promise.resolve({ state: 'unknown', reason: 'timeout', written: true, detail: 'no ack' });
    return Promise.resolve({
      state: 'sent',
      nativeRef: { sessionRef: request.nativeSessionRef, turnRef: `turn-${this.dispatched.length}` },
      evidence: { kind: 'live-ack', at: '2026-10-29T00:00:00.000Z', detail: 'fake ack' },
    });
  }

  reconcile(request: ReconcileRequest): Promise<ReconcileResult> {
    this.reconciled.push(request);
    const stored = this.history.get(request.clientMessageId);
    if (stored === undefined || stored.ref !== request.nativeSessionRef || stored.text !== request.text) {
      return Promise.resolve({ state: 'unknown', reason: 'not-found', matches: [], detail: 'not in the fake history' });
    }
    return Promise.resolve({
      state: 'sent',
      nativeRef: { sessionRef: request.nativeSessionRef },
      evidence: { kind: 'reconciled', at: '2026-10-29T00:00:00.000Z', detail: 'fake history' },
    });
  }

  readHistory(): Promise<HistoryResult> {
    return Promise.resolve({ entries: [], nativeTasks: [], complete: true });
  }

  interrupt(): Promise<void> {
    this.calls.push('interrupt');
    return Promise.resolve();
  }

  async setModel(ref: string, model: ModelSelection): Promise<'next-turn'> {
    await this.setModelGate;
    if (this.setModelError) throw this.setModelError;
    this.models.push({ ref, model });
    return 'next-turn';
  }

  stopNativeTask(ref: string, taskRef: string): Promise<void> {
    this.stoppedTasks.push({ ref, taskRef });
    return Promise.resolve();
  }

  listModels(): Promise<ModelOption[]> {
    return Promise.resolve([{ runtime: this.runtime, model: `${this.runtime}-model`, displayName: 'Model', efforts: [], isDefault: true, hidden: false }]);
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** Raises an approval request and returns its handle, which records how it was answered. */
  ask(request: PermissionRequest): FakeHandle {
    const handle = new FakeHandle(request);
    void Promise.resolve(this.onPermission(handle));
    return handle;
  }
}

export class FakeHandle implements PermissionHandle {
  decision: PermissionDecision | undefined;
  holdState: PermissionHold | undefined;
  matchedRule: string | undefined;
  open = true;

  constructor(public request: PermissionRequest) {}

  hold(hold: PermissionHold, extra?: { matchedRule?: string }): boolean {
    if (!this.open) return false;
    this.holdState = hold;
    this.matchedRule = extra?.matchedRule;
    this.request = { ...this.request, state: 'held', hold };
    return true;
  }

  answer(decision: PermissionDecision): boolean {
    if (!this.open) return false;
    this.open = false;
    this.decision = decision;
    return true;
  }

  withdraw(): void {
    this.open = false;
  }
}

/** Builds an approval request of a session. */
export const permissionRequest = (sessionId: SessionId, extra: Partial<PermissionRequest> = {}): PermissionRequest => ({
  id: 'perm-1' as PermissionRequest['id'],
  sessionId,
  kind: 'command',
  summary: 'Bash: npm test',
  command: 'npm test',
  paths: [],
  state: 'pending',
  createdAt: '2026-10-29T00:00:00.000Z',
  ...extra,
});
