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
import { Redactor } from './redact';

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
  /** Resolves after `ms`: bounds the waits of closing (core has no timers). Without it they are unbounded. */
  sleep?(ms: number): Promise<void>;
}

interface Entry {
  runtime: Runtime;
  adapter: Promise<RuntimeAdapter>;
}

/**
 * Releases under way (`onClosed` running), by native ref, with the opening they release: everyone who asks about
 * that opening waits for the same one.
 */
type Releasing = Map<string, { generation: number; sessionId: SessionId; done: Promise<void> }>;

/** How long a new opening waits for an earlier graceful close of the same session to return (T036 r1 P1-2). */
const CLOSE_SETTLE_MS = 5000;

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
  /**
   * Refs whose session is open in its adapter now, each with its opening's generation (T036 r1 P1-2): a close or
   * release of one opening never touches a later one of the same ref.
   */
  private readonly open = new Map<string, number>();
  private generations = 0;
  private readonly releasing: Releasing = new Map();
  /** Resumes under way, by GUI session, and graceful closes under way, by native ref and opening (T036 single-flight). */
  private readonly resuming = new Map<SessionId, Promise<NativeSessionInfo>>();
  private readonly closingRefs = new Map<string, { generation: number; run: Promise<{ forced: boolean }> }>();
  private readonly started = new WeakSet<RuntimeAdapter>();
  private readonly subscribed = new WeakSet<RuntimeAdapter>();
  private readonly views: Record<Runtime, RuntimeAdapter>;
  /** Every MCP token handed out in this process, revoked ones included; never shown anywhere (C-07). */
  readonly redactor = new Redactor();
  /** Starts and resumes still waiting for their adapter, so closing can wait for them. */
  private readonly inflight = new Set<Promise<unknown>>();
  private closing = false;

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

  /** Whether the ref is open now; with `generation`, whether that same opening still is. */
  isOpen(nativeSessionRef: string, generation?: number): boolean {
    const current = this.open.get(nativeSessionRef);
    return current !== undefined && (generation === undefined || current === generation);
  }

  /** The generation of the ref's current opening; undefined when it is not open. */
  generationOf(nativeSessionRef: string): number | undefined {
    return this.open.get(nativeSessionRef);
  }

  /** Open native refs and their sessions. */
  openSessions(): { sessionId: SessionId; nativeSessionRef: string }[] {
    return [...this.open.keys()].flatMap((ref) => {
      const sessionId = this.refs.get(ref);
      return sessionId === undefined ? [] : [{ sessionId, nativeSessionRef: ref }];
    });
  }

  /** Replaces every MCP token this process handed out (in the spellings redact.ts matches) with `[redacted]`. */
  redactText(text: string): string {
    return this.redactor.text(text);
  }

  /**
   * From now on nothing opens: a start or resume that was already running is closed as soon as it
   * returns (R-14), and new ones are refused.
   */
  beginClose(): void {
    this.closing = true;
  }

  /** Waits until every start and resume that was running has returned (and been closed again). */
  async settled(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  /** The runtime host of these sessions ended: they are no longer open. */
  markExited(sessionIds: readonly SessionId[]): void {
    // The next use creates the session's adapter again, so a Codex host that died is not reused.
    for (const sessionId of sessionIds) this.entries.delete(sessionId);
    for (const [ref, generation] of [...this.open]) {
      const sessionId = this.refs.get(ref);
      if (sessionId !== undefined && sessionIds.includes(sessionId)) void this.releaseOpen(ref, sessionId, generation);
    }
  }

  startSession(runtime: Runtime, options: StartSessionOptions): Promise<NativeSessionInfo> {
    return this.openWith(runtime, options.sessionId, (adapter, mcp) => adapter.startSession({ ...options, mcp }));
  }

  /**
   * One resume per session at a time (T036): a second caller while one runs gets that one's result, so two
   * deliveries racing to a closed session never start its runtime twice.
   */
  resumeSession(runtime: Runtime, options: ResumeSessionOptions): Promise<NativeSessionInfo> {
    const underway = this.resuming.get(options.sessionId);
    if (underway !== undefined) return underway;
    this.refs.set(options.nativeSessionRef, options.sessionId);
    const run = this.openWith(runtime, options.sessionId, (adapter, mcp) => adapter.resumeSession({ ...options, mcp }));
    this.resuming.set(options.sessionId, run);
    const done = () => {
      if (this.resuming.get(options.sessionId) === run) this.resuming.delete(options.sessionId);
    };
    void run.then(done, done);
    return run;
  }

  /**
   * Start or resume with a new mount. An adapter error is rethrown with every token redacted; a session that
   * comes up after closing began is closed again at once and never counted as open (R-14).
   */
  private openWith(runtime: Runtime, sessionId: SessionId, call: (adapter: RuntimeAdapter, mcp: McpMount) => Promise<NativeSessionInfo>): Promise<NativeSessionInfo> {
    if (this.closing) return Promise.reject(new Error('the GUI is closing'));
    const run = (async () => {
      const adapter = await this.adapterFor(runtime, sessionId);
      // Closing began while the adapter came up: nothing is opened on it (r2-P1-5).
      if (this.closing) {
        await this.release(sessionId, adapter);
        throw new Error('the GUI is closing');
      }
      // An earlier release of this session finishes first, so its `onClosed` (token, Job) never meets this opening.
      await this.settledFor(sessionId);
      if (this.closing) {
        await this.release(sessionId, adapter);
        throw new Error('the GUI is closing');
      }
      const mcp = await this.options.mountMcp(sessionId);
      this.redactor.add(mcp.token);
      let info: NativeSessionInfo;
      try {
        info = await call(adapter, mcp);
      } catch (error) {
        // The original is not attached as the cause: it would carry the token along.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(this.redactText(error instanceof Error ? error.message : String(error)));
      }
      if (this.closing) {
        await adapter.closeSession(info.nativeSessionRef).catch(() => undefined);
        await this.options.onClosed?.(sessionId);
        return info;
      }
      this.opened(info);
      return info;
    })();
    this.inflight.add(run);
    void run.then(
      () => this.inflight.delete(run),
      () => this.inflight.delete(run),
    );
    return run;
  }

  /**
   * Releases one session (R-14: the adapter interrupts before closing). Nothing to do when it is not open. One
   * close per ref at a time (T036): the task pipeline and the idle supervisor closing together close it once.
   */
  closeSession(nativeSessionRef: string, timeoutMs?: number): Promise<{ forced: boolean }> {
    const generation = this.open.get(nativeSessionRef);
    const underway = this.closingRefs.get(nativeSessionRef);
    if (underway !== undefined && (generation === undefined || underway.generation === generation)) return underway.run;
    const sessionId = this.refs.get(nativeSessionRef);
    const entry = sessionId === undefined ? undefined : this.entries.get(sessionId);
    if (sessionId === undefined || entry === undefined || generation === undefined) return Promise.resolve({ forced: false });
    const run = (async () => {
      try {
        return await (await entry.adapter).closeSession(nativeSessionRef, timeoutMs);
      } finally {
        // Released once, and only the opening this close was for (T036 r1 P1-2): `forceRelease` may have released it
        // while the adapter's close hung (T032), and the session may have been resumed since.
        await this.releaseOpen(nativeSessionRef, sessionId, generation);
      }
    })();
    const mark = { generation, run };
    this.closingRefs.set(nativeSessionRef, mark);
    const done = () => {
      if (this.closingRefs.get(nativeSessionRef) === mark) this.closingRefs.delete(nativeSessionRef);
    };
    void run.then(done, done);
    return run;
  }

  /**
   * Releases a session whose graceful close did not end in time (T032 r1 P1-5): it counts as closed, and
   * `onClosed` ends its Job, token and watchers. Resolves once that release has finished, whoever began it: a
   * graceful close that already began releasing is waited for, not skipped (r2 P1-3).
   */
  forceRelease(nativeSessionRef: string, generation: number | undefined = this.open.get(nativeSessionRef)): Promise<void> {
    const sessionId = this.refs.get(nativeSessionRef);
    if (sessionId === undefined) return Promise.resolve();
    if (generation === undefined) return this.releasing.get(nativeSessionRef)?.done ?? Promise.resolve();
    return this.releaseOpen(nativeSessionRef, sessionId, generation);
  }

  /**
   * The one release of one opening (`onClosed` once); a second caller about it gets the release under way. An opening
   * that is no longer the current one (released, and maybe opened again since) is left alone (T036 r1 P1-2).
   */
  private releaseOpen(nativeSessionRef: string, sessionId: SessionId, generation: number): Promise<void> {
    const underway = this.releasing.get(nativeSessionRef);
    if (underway !== undefined && underway.generation === generation) return underway.done;
    if (this.open.get(nativeSessionRef) !== generation) return Promise.resolve();
    this.open.delete(nativeSessionRef);
    const mark: { generation: number; sessionId: SessionId; done: Promise<void> } = {
      generation,
      sessionId,
      done: Promise.resolve()
        .then(() => this.options.onClosed?.(sessionId))
        .then(() => undefined)
        .finally(() => {
          if (this.releasing.get(nativeSessionRef) === mark) this.releasing.delete(nativeSessionRef);
        }),
    };
    this.releasing.set(nativeSessionRef, mark);
    return mark.done;
  }

  /**
   * Before a session opens again: its release under way has finished, and an earlier graceful close of it has
   * returned (at most CLOSE_SETTLE_MS when `sleep` is given), so nothing of the old opening runs on into the new one.
   */
  private async settledFor(sessionId: SessionId): Promise<void> {
    await Promise.allSettled([...this.releasing.values()].filter((r) => r.sessionId === sessionId).map((r) => r.done));
    const closes = [...this.closingRefs.entries()]
      .filter(([ref]) => this.refs.get(ref) === sessionId)
      .map(([, c]) =>
        c.run.then(
          () => undefined,
          () => undefined,
        ),
      );
    if (closes.length === 0) return;
    const all = Promise.all(closes);
    await (this.options.sleep === undefined ? all : Promise.race([all, this.options.sleep(CLOSE_SETTLE_MS)]));
  }

  /** Closes every adapter this router created (R-14: after the sessions themselves were closed). */
  async closeAll(timeoutMs = 5000): Promise<void> {
    const adapters = new Set<RuntimeAdapter>();
    for (const [sessionId, entry] of [...this.entries]) {
      // An adapter still coming up gets the deadline; past it, its session's Job is ended instead (r2-P1-5).
      const wait: Promise<RuntimeAdapter | undefined> =
        this.options.sleep === undefined ? entry.adapter : Promise.race([entry.adapter, this.options.sleep(timeoutMs).then(() => undefined)]);
      try {
        const adapter = await wait;
        if (adapter === undefined) await this.options.onClosed?.(sessionId);
        else adapters.add(adapter);
      } catch {
        // It never started; nothing to close.
      }
    }
    await Promise.allSettled([...adapters].map((a) => a.close(timeoutMs)));
  }

  /** An adapter that came up after closing began: closed again, and its session's Job ended. */
  private async release(sessionId: SessionId, adapter: RuntimeAdapter): Promise<void> {
    await adapter.close().catch(() => undefined);
    await this.options.onClosed?.(sessionId);
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
    if (this.closing) return Promise.reject(new Error('the GUI is closing'));
    const existing = this.entries.get(sessionId);
    if (existing !== undefined) {
      if (existing.runtime !== runtime) return Promise.reject(new Error(`session ${sessionId} runs on ${existing.runtime}, not ${runtime}`));
      return existing.adapter;
    }
    const adapter = (async () => {
      const created = this.options.createAdapter(runtime, sessionId);
      if (!this.subscribed.has(created)) {
        this.subscribed.add(created);
        // Runtime errors and output can quote the mount (e.g. a failed MCP connection): redacted here, before anything stores or shows it.
        // Deltas are held back until no token can be split across them (r2-P1-2).
        created.subscribe((event) => {
          for (const out of this.redactor.events(event)) this.options.onEvent(out);
        });
      }
      if (!this.started.has(created)) {
        await created.start();
        this.started.add(created);
      }
      if (this.closing) {
        await this.release(sessionId, created);
        throw new Error('the GUI is closing');
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
    this.open.set(info.nativeSessionRef, ++this.generations);
    this.options.onOpened?.(info.sessionId, info.cwd);
    // R-12: Codex reports its configured model only here (start or resume), never in an event (T021).
    if (info.model.source !== 'unknown') this.options.onEvent({ type: 'model.observed', sessionId: info.sessionId, observed: info.model, at: info.model.observedAt });
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
