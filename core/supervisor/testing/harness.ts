// The idle supervisor (T036) on the session service, fake adapters and given storage: the memory ports here, the
// real SQLite repositories and delivery store in app/main/supervisor-sqlite.test.ts. Codex gets one adapter per GUI
// session (CR-7), Claude one shared adapter. A test can hold the store's reads, a close or a resume on an await,
// and `restart()` gives a new service and supervisor on the same stored state, as after a crash.
import { type AppEvent, type Command, type CommandResult, MessageId, type ModelSelection, RequestId, type Runtime, SessionId, TurnId } from '../../../contracts';
import { hashOf } from '../../delivery/testing/fixtures';
import type { FileState } from '../../locks';
import { ManualClock } from '../../locks/testing/clock';
import type {
  AppRepositories,
  DeliveryStore,
  DispatchRequest,
  DispatchResult,
  NativeSessionInfo,
  PermissionHandle,
  PermissionPolicy,
  PolicyDecision,
  ReconcileRequest,
  ReconcileResult,
  ResumeSessionOptions,
  RuntimeAdapter,
  RuntimeAdapterHooks,
  StartSessionOptions,
} from '../../ports';
import { SessionService } from '../../sessions';
import { FakeAdapter, type RuntimeDisk } from '../../sessions/testing/fake-adapter';
import { AGENT, agent, CWD } from '../../sessions/testing/harness';
import { IdleSupervisor } from '../supervisor';

export const IDLE_MS = 60_000;
/** The supervisor's close deadline; unlike the router's own waits (5 s), so a test can let only it pass. */
export const CLOSE_MS = 4000;
/**
 * A sleep where the close deadlines pass at once (the supervisor's, and the router's wait for an earlier close before
 * a new opening, 5 s), but the collection of a retired adapter (10 s) never comes.
 */
export const onlyCloseDeadline = (ms: number): Promise<void> => (ms === CLOSE_MS || ms === 5000 ? Promise.resolve() : new Promise<void>(() => undefined));
let uuids = 0;
let turns = 0;
export const AT = '2026-10-29T01:00:00.000Z';

/**
 * A fake adapter whose session close can be held (a graceful close that hangs). Thread and turn IDs are unique
 * across adapters, as the runtimes' are: every Codex session has an adapter of its own.
 */
export class HoldingAdapter extends FakeAdapter {
  closeGate: Promise<void> | undefined;
  /** The turn the last ack named. */
  lastTurn: string | undefined;

  override startSession(options: StartSessionOptions): Promise<NativeSessionInfo> {
    return super.startSession({ ...options, preallocatedRef: options.preallocatedRef ?? `thread-${options.sessionId}` });
  }

  override async dispatchOnce(request: DispatchRequest): Promise<DispatchResult> {
    const result = await super.dispatchOnce(request);
    if (result.state !== 'sent') return result;
    // Unique across adapters too: a session's next opening has an adapter of its own.
    this.lastTurn = `${request.nativeSessionRef}:turn-${String(++turns)}`;
    return { ...result, nativeRef: { ...result.nativeRef, turnRef: this.lastTurn } };
  }

  /** When set, a reconcile that finds the message also names this turn (as a runtime's stored history can). */
  reconcileTurn: string | undefined;

  override async reconcile(request: ReconcileRequest): Promise<ReconcileResult> {
    const result = await super.reconcile(request);
    if (result.state !== 'sent' || this.reconcileTurn === undefined) return result;
    return { ...result, nativeRef: { ...result.nativeRef, turnRef: this.reconcileTurn } };
  }

  /** Runs as a resume starts (e.g. the folder goes, the runtime fails to start). */
  onResume: (() => void) | undefined;

  override resumeSession(options: ResumeSessionOptions): Promise<NativeSessionInfo> {
    try {
      this.onResume?.();
    } catch (error) {
      this.resumed.push(options);
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return super.resumeSession(options);
  }

  override async closeSession(ref: string): Promise<{ forced: boolean }> {
    const result = await super.closeSession(ref);
    await this.closeGate;
    return result;
  }
}

/** A promise the test resolves itself. */
export const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

export interface SupWorld {
  repositories: AppRepositories;
  store: DeliveryStore;
  /** Each Codex session's latest adapter. */
  codex: Map<string, HoldingAdapter>;
  /** Every adapter made for each session, oldest first (one per opening; not the shared Claude one). */
  all: Map<string, HoldingAdapter[]>;
  claude: HoldingAdapter;
  service: SessionService;
  supervisor: IdleSupervisor;
  clock: ManualClock;
  events: AppEvent[];
  /** Sessions whose runtime was released (`onSessionClosed`: Job ended, token revoked). */
  closed: SessionId[];
  logs: string[];
  /** Live command processes per session's Job (ProcessHost.listOwned, kind `command`). */
  owned: Map<SessionId, number>;
  /** Folders that are gone: they resolve to nothing. */
  gone: Set<string>;
  /** Lock-table file states (folded path → state). */
  files: Map<string, FileState>;
  decide: (sessionId: SessionId) => PolicyDecision;
  /** When set, the store's state listings wait for it (a check that stops on an await). */
  storeGate: Promise<void> | undefined;
  /** When set, the next `recordSent` commits and then waits for it before it returns (once). */
  holdNextRecordSent: Promise<void> | undefined;
  /** When set, the next `sessions.get` waits for it before it reads (once). */
  holdNextSessionGet: Promise<void> | undefined;
  /** When set, every conversation write waits for what it returns before it writes (T039: two writers of one turn). */
  beforeConversationWrite: ((method: string, args: unknown[]) => Promise<void> | undefined) | undefined;
  /** Every MCP mount handed out, by session. */
  mounts: SessionId[];
  /** Called with every new adapter before it is used (e.g. to hold the resume of a session's next opening). */
  onNewAdapter: ((adapter: HoldingAdapter) => void) | undefined;
  /** The exit and close deadlines (SessionServiceOptions.sleep); by default they never pass. */
  sleeper: (ms: number) => Promise<void>;
  /** When set, what the runtimes stored (T046): every adapter resumes only what is on it. Kept across a restart. */
  disk: RuntimeDisk | undefined;
  run(command: Command): Promise<CommandResult>;
  restart(): SupWorld;
}

export interface SupWorldOptions {
  maxOpen?: number;
  locks?: boolean;
  /** A new Claude adapter per opening, as the main process gives, instead of one shared adapter. */
  claudePerSession?: boolean;
  /** Replaces the fake for a runtime when it returns an adapter (core cannot import the real ones). */
  createAdapter?: (runtime: Runtime, sessionId: SessionId, hooks: RuntimeAdapterHooks, world: SupWorld) => RuntimeAdapter | undefined;
  /**
   * The storage of the next start: a new connection to the same database, read back from its file (T039 r1-P1-2).
   * Without it a restart keeps the same objects.
   */
  reopen?: () => { repositories: AppRepositories; store: DeliveryStore };
}

const build = (rawRepositories: AppRepositories, rawStore: DeliveryStore, o: SupWorldOptions, previous?: SupWorld): SupWorld => {
  const world = {
    mounts: [] as SessionId[],
    holdNextRecordSent: undefined as Promise<void> | undefined,
    holdNextSessionGet: undefined as Promise<void> | undefined,
    codex: new Map<string, HoldingAdapter>(),
    all: new Map<string, HoldingAdapter[]>(),
    clock: previous?.clock ?? new ManualClock(AT),
    events: [] as AppEvent[],
    closed: [] as SessionId[],
    logs: [] as string[],
    owned: previous?.owned ?? new Map<SessionId, number>(),
    gone: previous?.gone ?? new Set<string>(),
    files: previous?.files ?? new Map<string, FileState>(),
    decide: previous?.decide ?? ((): PolicyDecision => ({ action: 'approve' })),
    storeGate: undefined as Promise<void> | undefined,
    sleeper: (): Promise<void> => new Promise<void>(() => undefined),
    disk: previous?.disk,
  } as unknown as SupWorld;
  // The store with its state listings held while `storeGate` is set, and one `recordSent` held after its commit.
  world.store = new Proxy(rawStore, {
    get: (target, key): unknown => {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      const call = (args: unknown[]) => (value as (...a: unknown[]) => unknown).apply(target, args);
      if (key === 'listByState')
        return async (...args: unknown[]) => {
          await world.storeGate;
          return call(args);
        };
      if (key === 'recordSent')
        return async (...args: unknown[]) => {
          const held = world.holdNextRecordSent;
          world.holdNextRecordSent = undefined;
          const written = await call(args);
          await held;
          return written;
        };
      return (...args: unknown[]) => call(args);
    },
  });
  // The repositories with one `sessions.get` held before it reads.
  const sessions = new Proxy(rawRepositories.sessions, {
    get: (target, key): unknown => {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      if (key !== 'get') return (value as (...a: unknown[]) => unknown).bind(target);
      return async (...args: unknown[]) => {
        const held = world.holdNextSessionGet;
        world.holdNextSessionGet = undefined;
        await held;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  // ... and every conversation write held while `beforeConversationWrite` says so.
  const conversations = new Proxy(rawRepositories.conversations, {
    get: (target, key): unknown => {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      if (typeof key !== 'string' || !key.startsWith('upsert')) return (value as (...a: unknown[]) => unknown).bind(target);
      return async (...args: unknown[]) => {
        await world.beforeConversationWrite?.(key, args);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  const repositories = new Proxy(rawRepositories, {
    get: (target, key): unknown => (key === 'sessions' ? sessions : key === 'conversations' ? conversations : Reflect.get(target, key)),
  });
  world.repositories = repositories;
  const policy: PermissionPolicy = { evaluate: (request) => world.decide(request.sessionId) };
  const onPermission = (handle: PermissionHandle) => world.service.onPermissionRequest(handle);
  world.claude = new HoldingAdapter('claude', onPermission);
  world.claude.diskOf = () => world.disk;
  let mounts = 0;
  const { clock } = world;
  // E:\work is a junction to E:\real; a folder in `gone`, or anything elsewhere, does not resolve.
  const realPath = (path: string) => {
    if ([...world.gone].some((g) => path.toLowerCase().startsWith(g.toLowerCase()))) return null;
    return path.startsWith('E:\\work') ? path.replace('E:\\work', 'E:\\real') : path.startsWith('E:\\real') ? path : null;
  };
  world.service = new SessionService({
    repositories,
    store: world.store,
    policy,
    publish: (event) => world.events.push(event),
    now: () => clock.now(),
    // One counter for every world, restarts included: an ID is never handed out twice.
    uuid: () => `00000000-0000-4000-8036-${(++uuids).toString(16).padStart(12, '0')}`,
    hashPayload: hashOf,
    resolveRealPath: realPath,
    // Codex: a new adapter per opening (the router asks again after each release). Claude: one shared adapter, or
    // with `claudePerSession` a new one per opening as the main process gives (T036 r2 P1-1).
    createAdapter: (runtime: Runtime, sessionId: SessionId, hooks: RuntimeAdapterHooks) => {
      // A real adapter given by the test (app/main: the Claude adapter on a fake SDK), with the router's hooks.
      const given = o.createAdapter?.(runtime, sessionId, hooks, world);
      if (given !== undefined) return given;
      if (runtime === 'claude' && o.claudePerSession !== true) return world.claude;
      // Its requests go through the router's hooks, which know the opening they belong to (T036 r3 P1-2).
      const adapter = new HoldingAdapter(runtime, (handle) => hooks.onPermissionRequest(handle));
      adapter.diskOf = () => world.disk;
      if (runtime === 'claude') world.claude = adapter;
      else world.codex.set(sessionId, adapter);
      world.all.set(sessionId, [...(world.all.get(sessionId) ?? []), adapter]);
      world.onNewAdapter?.(adapter);
      return adapter;
    },
    mountMcp: (sessionId) => {
      world.mounts.push(sessionId);
      return { url: 'http://127.0.0.1:4000/mcp', token: `token-${sessionId}-${String(++mounts)}` };
    },
    listModels: (runtime) => world.claude.listModels().then((m) => m.map((x) => ({ ...x, runtime }))),
    onSessionClosed: (sessionId) => {
      world.closed.push(sessionId);
    },
    log: (message) => world.logs.push(message),
    sleep: (ms) => world.sleeper(ms),
    ...(o.locks === true && { locks: { hashFile: (path: string) => world.files.get(path.toLowerCase()) ?? 'missing', setTimer: clock.setTimer } }),
  });
  world.supervisor = new IdleSupervisor({
    sessions: world.service,
    now: () => clock.now(),
    idleMs: IDLE_MS,
    maxOpen: o.maxOpen ?? 0,
    closeTimeoutMs: CLOSE_MS,
    ownedCommands: (sessionId) => Promise.resolve(world.owned.get(sessionId) ?? 0),
    log: (message) => world.logs.push(message),
  });
  world.service.attachSupervisor(world.supervisor);
  world.run = (command) => world.service.execute(command);
  world.restart = () => {
    const next = o.reopen?.();
    return build(next?.repositories ?? rawRepositories, next?.store ?? rawStore, o, world);
  };
  return world;
};

export const supWorldOn = async (repositories: AppRepositories, store: DeliveryStore, o: SupWorldOptions = {}): Promise<SupWorld> => {
  const w = build(repositories, store, o);
  await w.repositories.agents.save(agent(), null);
  return w;
};

/** Waits for the background work a call started (provisioning, event writes, queued closes). */
export const settle = async () => {
  for (let i = 0; i < 400; i++) await Promise.resolve();
};

let requests = 0;
export const rid = () => RequestId.parse(`sup-r-${String(++requests)}`);

/** The session's latest adapter. */
export const adapterOf = (w: SupWorld, runtime: Runtime, sessionId: SessionId): HoldingAdapter =>
  w.all.get(sessionId)?.at(-1) ?? (runtime === 'claude' ? w.claude : w.codex.get(sessionId)!);
/** Every adapter that served the session, oldest first. */
export const adaptersOf = (w: SupWorld, runtime: Runtime, sessionId: SessionId): HoldingAdapter[] => w.all.get(sessionId) ?? [adapterOf(w, runtime, sessionId)];
/** Every resume of the session, across its adapters. */
export const resumedOf = (w: SupWorld, runtime: Runtime, sessionId: SessionId) => adaptersOf(w, runtime, sessionId).flatMap((a) => a.resumed);
/** The texts dispatched to the session, across its adapters, in order. */
export const textsOf = (w: SupWorld, runtime: Runtime, sessionId: SessionId) => adaptersOf(w, runtime, sessionId).flatMap((a) => a.dispatched.map((d) => d.text));
/** Every graceful close of the session, across its adapters. */
export const closesOf = (w: SupWorld, runtime: Runtime, sessionId: SessionId) => adaptersOf(w, runtime, sessionId).flatMap((a) => a.closedSessions);

/** A session created and provisioned in CWD. */
export const created = async (w: SupWorld, runtime: Runtime = 'codex', id = 'session-a', cwd = CWD): Promise<SessionId> => {
  const sessionId = SessionId.parse(id);
  const model: ModelSelection = { runtime, model: runtime === 'codex' ? 'gpt-6-luna' : 'haiku' };
  const result = await w.run({ type: 'session.create', requestId: rid(), sessionId, kind: 'ordinary', agentId: AGENT, model, cwd });
  if (!result.ok) throw new Error(`create failed: ${result.message}`);
  await settle();
  return sessionId;
};

let messages = 0;
/** The user's message, sent with the session's current revision. */
export const send = async (w: SupWorld, sessionId: SessionId, text = 'hello'): Promise<CommandResult> => {
  const s = await w.repositories.sessions.get(sessionId);
  return w.run({
    type: 'session.send',
    requestId: rid(),
    sessionId,
    messageId: MessageId.parse(`sup-m-${String(++messages)}`),
    expectedRevision: s?.revision ?? 0,
    text,
    attachments: [],
  });
};

/** The turn the adapter's last ack named, ended by the runtime (Codex `turn/completed`, Claude `result`). */
export const endLastTurn = async (w: SupWorld, runtime: Runtime, sessionId: SessionId) => {
  const adapter = adapterOf(w, runtime, sessionId);
  const id = TurnId.parse(adapter.lastTurn ?? 'no-turn');
  adapter.emit({ type: 'turn.updated', turn: { id, sessionId, state: 'running', startedAt: w.clock.now() } });
  adapter.emit({ type: 'turn.updated', turn: { id, sessionId, state: 'completed', startedAt: w.clock.now(), endedAt: w.clock.now() } });
  await settle();
};

/** A message sent and its turn ended: the session is idle again, used just now. */
export const exchange = async (w: SupWorld, runtime: Runtime, sessionId: SessionId, text = 'hello') => {
  const result = await send(w, sessionId, text);
  if (!result.ok) throw new Error(`send failed: ${result.message}`);
  await endLastTurn(w, runtime, sessionId);
};

/** Time passes and the supervisor looks. */
export const idleFor = async (w: SupWorld, ms: number) => {
  w.clock.advance(ms);
  await w.supervisor.tick();
  await settle();
};

export const activityOf = async (w: SupWorld, sessionId: SessionId) => (await w.repositories.sessions.get(sessionId))?.activity;
export const isOpen = (w: SupWorld, sessionId: SessionId) => w.service.openSessions().some((s) => s.sessionId === sessionId);
