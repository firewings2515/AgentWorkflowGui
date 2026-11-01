// The runtime adapters of every GUI session behind one `RuntimeAdapter` per runtime (T017). Codex runs one
// adapter (one app-server, one Job) per GUI session (CR-7); Claude shares one adapter whose claude.exe of
// each session starts in that session's Job. Which adapter serves a session is decided by the injected
// factory; this router only keeps track of it, by GUI session and by native session ref.
//
// Each opening of a session (start or resume) has a generation (T036 r1 P1-2) and, once released, its adapter is
// retired: the next opening asks the factory again (T036 r2 P1-1). An exit or activity event from an adapter that no
// longer serves the session is the late end of an earlier opening and is not passed on, so it never releases a
// later one. This holds only for a factory that hands out a new adapter per call; one shared by several openings
// cannot be told apart, so the main process gives every opening its own (Claude included).
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
  PermissionHandle,
  ResumeSessionOptions,
  RuntimeAdapter,
  RuntimeAdapterHooks,
  RuntimeEvent,
  StartSessionOptions,
} from '../ports';
import { Redactor } from './redact';

export interface SessionRuntimesOptions {
  /**
   * The adapter that serves `sessionId`; called once per session (and again after it failed to start).
   * It may hand out the same adapter for several sessions (Claude). Started by the router before use.
   */
  createAdapter(runtime: Runtime, sessionId: SessionId, hooks: RuntimeAdapterHooks): RuntimeAdapter;
  /**
   * An approval request of an adapter made with the `hooks` given to `createAdapter` (T036 r3 P1-2). `isCurrent`
   * tells, whenever asked, whether that adapter still serves the request's session: once it does not, the request
   * belongs to an earlier opening and nothing may approve it.
   */
  onPermissionRequest?(handle: PermissionHandle, isCurrent: () => boolean): unknown;
  /** A new mount of the GUI MCP server for this session; the previous token stops working. */
  mountMcp(sessionId: SessionId): McpMount | Promise<McpMount>;
  /** The runtime's model list (R-12), outside any session. */
  listModels(runtime: Runtime): Promise<ModelOption[]>;
  /** A session's runtime came up (start or resume) in `cwd`. */
  onOpened?(sessionId: SessionId, cwd: string): void;
  /** A session's runtime was released (closeSession or exit): its Job, token and watchers can go. */
  onClosed?(sessionId: SessionId): Promise<void> | void;
  /**
   * Every event of every adapter, once, with whether the adapter it came from still serves a session (T036 r3 P1-1):
   * an earlier opening's event may only be kept as history. An exit or activity of an earlier opening never comes.
   */
  onEvent(event: RuntimeEvent, isCurrent: (sessionId: SessionId) => boolean): void;
  /** Resolves after `ms`: bounds the waits of closing (core has no timers). Without it they are unbounded. */
  sleep?(ms: number): Promise<void>;
  /** Diagnostics: fixed text and IDs only. */
  log?(message: string): void;
}

interface Entry {
  runtime: Runtime;
  adapter: Promise<RuntimeAdapter>;
  /** The adapter itself, once the factory made it. */
  instance?: RuntimeAdapter;
}

/**
 * Releases under way (`onClosed` running), by native ref, with the opening they release: everyone who asks about
 * that opening waits for the same one.
 */
type Releasing = Map<string, { generation: number; sessionId: SessionId; done: Promise<void> }>;

/** How long a new opening waits for an earlier graceful close of the same session to return (T036 r1 P1-2). */
const CLOSE_SETTLE_MS = 5000;
/** How long a retired adapter's closes are waited for before it is collected anyway (T036 r3 P2). */
const COLLECT_AFTER_MS = 10_000;

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
  private readonly closingRefs = new Map<string, { generation: number; adapter: RuntimeAdapter | undefined; run: Promise<{ forced: boolean }> }>();
  /**
   * Adapters of released openings until they are collected (T036 r3 P2): their closes returned, they are closed, and
   * their events are no longer listened to. Closed with the rest on exit if still here.
   */
  private readonly retired = new Set<RuntimeAdapter>();
  /** How to stop listening to each adapter. */
  private readonly subscriptions = new Map<RuntimeAdapter, () => void>();
  /** Attempts dispatched in this process, with the opening they went to (T036 r2 P1-2). */
  private readonly dispatchedIn = new Map<string, { ref: string; generation: number }>();
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
    // The next use creates the session's adapter again, so a Codex host that died is not reused. Only an exit of the
    // adapter that serves the session comes here (`received`), so a newer opening coming up is never this (T036 r2/r3).
    for (const sessionId of sessionIds) {
      const entry = this.entries.get(sessionId);
      if (entry !== undefined) this.retire(sessionId, entry);
    }
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
    const mark = { generation, adapter: entry.instance, run };
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
    // Its adapter is done with (T036 r2 P1-1): the next opening gets a new one, so this one's late events are told apart.
    // A session is opened again only once it is not open, so the entry here is still this opening's.
    const entry = this.entries.get(sessionId);
    if (entry !== undefined) this.retire(sessionId, entry);
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
    // Retired ones too: an earlier opening whose close did not finish may still hold its process (T036 r2 P1-1).
    for (const adapter of this.retired) adapters.add(adapter);
    await Promise.allSettled([...adapters].map((a) => a.close(timeoutMs)));
  }

  /** The session's adapter is not used for it again: from now on its events are an earlier opening's, then it is collected. */
  private retire(sessionId: SessionId, entry: Entry): void {
    if (this.entries.get(sessionId) === entry) this.entries.delete(sessionId);
    const adapter = entry.instance;
    if (adapter === undefined || this.retired.has(adapter)) return;
    this.retired.add(adapter);
    void this.collect(adapter);
  }

  /** Retired adapters not yet collected (tests, diagnostics). */
  get retiredCount(): number {
    return this.retired.size;
  }

  /**
   * Lets a retired adapter go (T036 r3 P2): once its graceful closes returned (at most COLLECT_AFTER_MS when `sleep`
   * is given), it is closed (R-14: whatever it still runs ends) and no longer listened to. One that serves another
   * session (a shared adapter) is only forgotten as retired.
   */
  private async collect(adapter: RuntimeAdapter): Promise<void> {
    const inUse = () => [...this.entries.values()].some((e) => e.instance === adapter);
    const closes = [...this.closingRefs.values()]
      .filter((c) => c.adapter === adapter)
      .map((c) =>
        c.run.then(
          () => undefined,
          () => undefined,
        ),
      );
    const bounded = (p: Promise<unknown>) => (this.options.sleep === undefined ? p : Promise.race([p, this.options.sleep(COLLECT_AFTER_MS)]));
    if (closes.length > 0) await bounded(Promise.all(closes));
    if (!inUse()) await bounded(adapter.close(CLOSE_SETTLE_MS).catch(() => undefined));
    // Looked at again after the waits: a shared adapter taken up again meanwhile keeps listening.
    if (!inUse()) {
      this.subscriptions.get(adapter)?.();
      this.subscriptions.delete(adapter);
      this.subscribed.delete(adapter);
      this.started.delete(adapter);
    }
    this.retired.delete(adapter);
  }

  /** Whether `adapter` serves the session now: the adapter of its opening, open or coming up (T036 r2/r3). */
  private serves(adapter: RuntimeAdapter, sessionId: SessionId): boolean {
    return this.entries.get(sessionId)?.instance === adapter;
  }

  /**
   * The opening `attemptId` was dispatched to in this process, or undefined (T036 r2 P1-2): only an attempt whose
   * opening is still open can have its turn seen to end. Asked once per attempt.
   */
  dispatchedTo(attemptId: string): { ref: string; generation: number } | undefined {
    const sent = this.dispatchedIn.get(attemptId);
    this.dispatchedIn.delete(attemptId);
    return sent;
  }

  /**
   * An adapter's event (T036 r2 P1-1, r3 P1-1): an exit or activity of a session that adapter no longer serves is the
   * late end of an earlier opening, logged and dropped; every other event goes on with `isCurrent`, so the layer above
   * keeps an earlier opening's events as history only and lets none of them change what is going on now.
   */
  private received(adapter: RuntimeAdapter, event: RuntimeEvent): void {
    const stale = (sessionId: SessionId) => !this.serves(adapter, sessionId);
    let passed: RuntimeEvent = event;
    if (event.type === 'runtime.exited') {
      const late = event.sessionIds.filter(stale);
      if (late.length > 0) {
        this.options.log?.(`[runtimes] a late exit of an earlier opening of ${late.join(', ')} was ignored`);
        const current = event.sessionIds.filter((id) => !stale(id));
        if (current.length === 0) return;
        passed = { ...event, sessionIds: current };
      }
    } else if (event.type === 'session.activity' && stale(event.sessionId)) {
      this.options.log?.(`[runtimes] a late activity of an earlier opening of ${event.sessionId} was ignored`);
      return;
    }
    const isCurrent = (sessionId: SessionId) => this.serves(adapter, sessionId);
    for (const out of this.redactor.events(passed)) this.options.onEvent(out, isCurrent);
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
    const entry: Entry = { runtime, adapter: Promise.resolve(undefined as never) };
    const adapter = (async () => {
      // This adapter's approval requests know whether it still serves their session (T036 r3 P1-2).
      const hooks: RuntimeAdapterHooks = {
        onPermissionRequest: (handle) => {
          const isCurrent = () => entry.instance !== undefined && this.serves(entry.instance, handle.request.sessionId);
          if (this.options.onPermissionRequest === undefined) throw new Error('no approval handler');
          return this.options.onPermissionRequest(handle, isCurrent);
        },
      };
      const created = this.options.createAdapter(runtime, sessionId, hooks);
      entry.instance = created;
      if (!this.subscribed.has(created)) {
        this.subscribed.add(created);
        // Runtime errors and output can quote the mount (e.g. a failed MCP connection): redacted here, before anything stores or shows it.
        // Deltas are held back until no token can be split across them (r2-P1-2). Each event is known by the adapter it came from (T036 r2 P1-1).
        this.subscriptions.set(
          created,
          created.subscribe((event) => this.received(created, event)),
        );
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
    entry.adapter = adapter;
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
    if (info.model.source !== 'unknown')
      this.options.onEvent({ type: 'model.observed', sessionId: info.sessionId, observed: info.model, at: info.model.observedAt }, () => true);
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
        if (adapter === undefined) return notRunning(`native session ${request.nativeSessionRef} is not open`);
        // The opening it goes to, for whether its ack's turn can still end (T036 r2 P1-2).
        const generation = this.open.get(request.nativeSessionRef);
        if (generation !== undefined) this.dispatchedIn.set(request.attempt.attemptId, { ref: request.nativeSessionRef, generation });
        return adapter.dispatchOnce(request);
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
