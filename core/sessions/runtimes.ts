// The runtime adapters of every GUI session behind one `RuntimeAdapter` per runtime (T017). Codex runs one
// adapter (one app-server, one Job) per GUI session (CR-7); Claude shares one adapter whose claude.exe of
// each session starts in that session's Job. Which adapter serves a session is decided by the injected
// factory; this router only keeps track of it, by GUI session and by native session ref.
//
// The GUI MCP server is mounted here and nowhere else: every start and resume asks for a new mount (the
// old token stops working) and passes it in the port's `mcp` option, so nothing stored ever carries it
// (C-07, R-03).
import type { ModelOption, ModelSelection, Runtime, SessionId } from '../../contracts';
import type {
  DispatchRequest,
  DispatchResult,
  HistoryRequest,
  HistoryResult,
  McpMount,
  ModelChangeTiming,
  NativeSessionInfo,
  ReconcileProvisionRequest,
  ReconcileProvisionResult,
  ReconcileRequest,
  ReconcileResult,
  ResumeSessionOptions,
  RuntimeAdapter,
  RuntimeEvent,
  StartSessionOptions,
} from '../ports';

export interface SessionRuntimesOptions {
  /**
   * The adapter that serves `sessionId`; called once per session (and again after it failed to start).
   * It may hand out the same adapter for several sessions (Claude). Started by the router before use.
   */
  createAdapter(runtime: Runtime, sessionId: SessionId): RuntimeAdapter;
  /** A new mount of the GUI MCP server for this session; the previous token stops working. */
  mountMcp(sessionId: SessionId): McpMount | Promise<McpMount>;
  /** The runtime's model list (R-12), outside any session. */
  listModels(runtime: Runtime): Promise<ModelOption[]>;
  /** A session's runtime came up (start or resume) in `cwd`. */
  onOpened?(sessionId: SessionId, cwd: string): void;
  /** A session's runtime was released (closeSession or exit): its Job, token and watchers can go. */
  onClosed?(sessionId: SessionId): Promise<void> | void;
  /** Every event of every adapter, once. */
  onEvent(event: RuntimeEvent): void;
}

interface Entry {
  runtime: Runtime;
  adapter: Promise<RuntimeAdapter>;
}

const notRunning = (detail: string): DispatchResult => ({
  state: 'unknown',
  reason: 'not-running',
  written: false,
  detail,
});

export class SessionRuntimes {
  private readonly entries = new Map<SessionId, Entry>();
  /** Native session ref → GUI session, for every ref seen in this process or bound at startup. */
  private readonly refs = new Map<string, SessionId>();
  /** Refs whose session is open in its adapter now. */
  private readonly open = new Set<string>();
  private readonly started = new WeakSet<RuntimeAdapter>();
  private readonly subscribed = new WeakSet<RuntimeAdapter>();
  private readonly views: Record<Runtime, RuntimeAdapter>;

  constructor(private readonly options: SessionRuntimesOptions) {
    this.views = { codex: this.view('codex'), claude: this.view('claude') };
  }

  /** One `RuntimeAdapter` per runtime, for the delivery service. */
  get adapters(): Record<Runtime, RuntimeAdapter> {
    return this.views;
  }

  /** Records which GUI session a stored native ref belongs to (after a restart). */
  bind(sessionId: SessionId, nativeSessionRef: string): void {
    this.refs.set(nativeSessionRef, sessionId);
  }

  isOpen(nativeSessionRef: string): boolean {
    return this.open.has(nativeSessionRef);
  }

  /** Open native refs and their sessions. */
  openSessions(): { sessionId: SessionId; nativeSessionRef: string }[] {
    return [...this.open].flatMap((ref) => {
      const sessionId = this.refs.get(ref);
      return sessionId === undefined ? [] : [{ sessionId, nativeSessionRef: ref }];
    });
  }

  /** The runtime host of these sessions ended: they are no longer open. */
  markExited(sessionIds: readonly SessionId[]): void {
    // The next use creates the session's adapter again, so a Codex host that died is not reused.
    for (const sessionId of sessionIds) this.entries.delete(sessionId);
    for (const ref of [...this.open]) {
      const sessionId = this.refs.get(ref);
      if (sessionId !== undefined && sessionIds.includes(sessionId)) {
        this.open.delete(ref);
        void this.options.onClosed?.(sessionId);
      }
    }
  }

  async startSession(runtime: Runtime, options: StartSessionOptions): Promise<NativeSessionInfo> {
    const adapter = await this.adapterFor(runtime, options.sessionId);
    const mcp = await this.options.mountMcp(options.sessionId);
    const info = await adapter.startSession({ ...options, mcp });
    this.opened(info);
    return info;
  }

  async resumeSession(runtime: Runtime, options: ResumeSessionOptions): Promise<NativeSessionInfo> {
    const adapter = await this.adapterFor(runtime, options.sessionId);
    const mcp = await this.options.mountMcp(options.sessionId);
    this.refs.set(options.nativeSessionRef, options.sessionId);
    const info = await adapter.resumeSession({ ...options, mcp });
    this.opened(info);
    return info;
  }

  /** Releases one session (R-14: the adapter interrupts before closing). Nothing to do when it is not open. */
  async closeSession(nativeSessionRef: string, timeoutMs?: number): Promise<{ forced: boolean }> {
    const sessionId = this.refs.get(nativeSessionRef);
    const entry = sessionId === undefined ? undefined : this.entries.get(sessionId);
    if (sessionId === undefined || entry === undefined || !this.open.has(nativeSessionRef)) return { forced: false };
    try {
      return await (await entry.adapter).closeSession(nativeSessionRef, timeoutMs);
    } finally {
      this.open.delete(nativeSessionRef);
      await this.options.onClosed?.(sessionId);
    }
  }

  /** Closes every adapter this router created (R-14: after the sessions themselves were closed). */
  async closeAll(timeoutMs?: number): Promise<void> {
    const adapters = new Set<RuntimeAdapter>();
    for (const entry of this.entries.values()) {
      try {
        adapters.add(await entry.adapter);
      } catch {
        // It never started; nothing to close.
      }
    }
    await Promise.allSettled([...adapters].map((a) => a.close(timeoutMs)));
  }

  /** The adapter of an open native ref, or undefined. */
  private async adapterOf(nativeSessionRef: string): Promise<RuntimeAdapter | undefined> {
    const sessionId = this.refs.get(nativeSessionRef);
    const entry = sessionId === undefined ? undefined : this.entries.get(sessionId);
    return entry === undefined ? undefined : entry.adapter;
  }

  private async requireOpen(nativeSessionRef: string): Promise<RuntimeAdapter> {
    const adapter = this.open.has(nativeSessionRef) ? await this.adapterOf(nativeSessionRef) : undefined;
    if (adapter === undefined) throw new Error(`native session ${nativeSessionRef} is not open`);
    return adapter;
  }

  /** The session's adapter, created and started on first use; a failed start is forgotten so the next call tries again. */
  private adapterFor(runtime: Runtime, sessionId: SessionId): Promise<RuntimeAdapter> {
    const existing = this.entries.get(sessionId);
    if (existing !== undefined) {
      if (existing.runtime !== runtime) return Promise.reject(new Error(`session ${sessionId} runs on ${existing.runtime}, not ${runtime}`));
      return existing.adapter;
    }
    const adapter = (async () => {
      const created = this.options.createAdapter(runtime, sessionId);
      if (!this.subscribed.has(created)) {
        this.subscribed.add(created);
        created.subscribe((event) => this.options.onEvent(event));
      }
      if (!this.started.has(created)) {
        await created.start();
        this.started.add(created);
      }
      return created;
    })();
    const entry: Entry = { runtime, adapter };
    this.entries.set(sessionId, entry);
    adapter.catch(() => {
      if (this.entries.get(sessionId) === entry) this.entries.delete(sessionId);
    });
    return adapter;
  }

  private opened(info: NativeSessionInfo): void {
    this.refs.set(info.nativeSessionRef, info.sessionId);
    this.open.add(info.nativeSessionRef);
    this.options.onOpened?.(info.sessionId, info.cwd);
  }

  /** The port view of one runtime: every call goes to the adapter of the session it names. */
  private view(runtime: Runtime): RuntimeAdapter {
    const withAdapter = async <T>(nativeSessionRef: string, run: (adapter: RuntimeAdapter) => Promise<T>): Promise<T> =>
      run(await this.requireOpen(nativeSessionRef));
    /** Read-only calls: the session's adapter, started if needed, but the session itself is not resumed. */
    const reader = async (nativeSessionRef: string): Promise<RuntimeAdapter | undefined> => {
      const sessionId = this.refs.get(nativeSessionRef);
      return sessionId === undefined ? undefined : this.adapterFor(runtime, sessionId);
    };
    return {
      runtime,
      start: () => Promise.resolve(),
      close: async (timeoutMs?: number) => {
        await this.closeAll(timeoutMs);
        return { forced: false };
      },
      startSession: (options: StartSessionOptions) => this.startSession(runtime, options),
      resumeSession: (options: ResumeSessionOptions) => this.resumeSession(runtime, options),
      closeSession: (ref: string, timeoutMs?: number) => this.closeSession(ref, timeoutMs),
      reconcileProvision: (request: ReconcileProvisionRequest): Promise<ReconcileProvisionResult> =>
        Promise.resolve({
          state: 'unknown',
          reason: 'unsupported',
          detail: `provisions are not reconciled through the ${request.preallocatedRef === undefined ? 'session' : 'pre-allocated'} router`,
        }),
      dispatchOnce: async (request: DispatchRequest): Promise<DispatchResult> => {
        const adapter = this.open.has(request.nativeSessionRef) ? await this.adapterOf(request.nativeSessionRef) : undefined;
        return adapter === undefined ? notRunning(`native session ${request.nativeSessionRef} is not open`) : adapter.dispatchOnce(request);
      },
      reconcile: async (request: ReconcileRequest): Promise<ReconcileResult> => {
        const adapter = await reader(request.nativeSessionRef);
        if (adapter === undefined)
          return {
            state: 'unknown',
            reason: 'not-running',
            matches: [],
            detail: `no session is bound to ${request.nativeSessionRef}`,
          };
        return adapter.reconcile(request);
      },
      readHistory: async (request: HistoryRequest): Promise<HistoryResult> => {
        const adapter = await reader(request.nativeSessionRef);
        if (adapter === undefined) throw new Error(`no session is bound to ${request.nativeSessionRef}`);
        return adapter.readHistory(request);
      },
      interrupt: (ref: string) => withAdapter(ref, (a) => a.interrupt(ref)),
      setModel: (ref: string, model: ModelSelection): Promise<ModelChangeTiming> => withAdapter(ref, (a) => a.setModel(ref, model)),
      stopNativeTask: (ref: string, taskRef: string) => withAdapter(ref, (a) => a.stopNativeTask(ref, taskRef)),
      listModels: () => this.options.listModels(runtime),
      subscribe: () => () => undefined,
    };
  }
}
