// The main process's backend (T017): storage, process host, GUI MCP server, both runtimes, the policy
// and the CR-2 delivery service, put together behind the facade the IPC layer serves. Electron-free, so
// the integration tests run it on a real SQLite file with fake adapters.
//
// Start order: database → snapshot read (damaged data stops here, fail closed) → orphan cleanup → MCP
// server → session service → recovery → model lists in the background. Exit order (R-14): new commands
// refused → MCP server closed → every session closed (interrupt / close stdin) and its Job ended →
// adapters closed → database closed.
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  CONTRACTS_VERSION,
  type Command,
  type CommandResult,
  type ModelOption,
  type OwnedProcess,
  type PayloadHash,
  type QueryRequest,
  type QueryResult,
  type ReadOnlyReason,
  type Runtime,
  type RuntimeStatus,
  type SessionId,
  type Snapshot,
  type StorageInfo,
  type UiPreferences,
} from '../../contracts';
import { ClaudeAdapter, claudeAgentSdk } from '../../adapters/claude';
import { CodexAdapter } from '../../adapters/codex';
import { GitAdapter } from '../../adapters/git';
import { GuiMcpServer, type McpToolHandlers } from '../../adapters/mcp-server';
import { claudeProcessSpawn, codexAppServerSpawn, type JobSpawner } from '../../adapters/process';
import { createRepositories, openDatabase, openStorage, SqliteDeliveryStore, storageHealth } from '../../adapters/storage';
import type { StorageHooks } from '../../adapters/storage/health';
import { permissionPolicy } from '../../core/policy';
import type {
  AppRepositories,
  BackupStore,
  GitPort,
  OwnedProcessRepository,
  PermissionHandle,
  PermissionPolicy,
  ProcessHost,
  RuntimeAdapter,
  RuntimeLocator,
  StorageHealth,
} from '../../core/ports';
import { StorageReadOnlyError, StorageWriteError } from '../../core/ports';
import { Redactor, SessionService } from '../../core/sessions';
import { IdleSupervisor, SUPERVISOR_DEFAULTS } from '../../core/supervisor';
import { TransferService } from '../../core/transfer';
import { WorkflowEngine } from '../../core/workflow';
import type { EventBus } from './event-bus';
import { type AppFacade, failure } from './facade';
import { type FaultPoint, faultApplies, withFaultPoint } from './fault-points';
import { hashFile, setTimer } from './file-hash';
import { GitIgnoreRules } from './git-ignore';
import { gitWorktreeFiles, isPipelineFolder, jobCommandRunner } from './pipeline-host';
import { WorkspaceWatchers, type WatchFn } from './workspace-watch';

/** What the main process needs from its process host: the port plus the spawn the adapters use (T013). */
export type BackendProcessHost = ProcessHost & JobSpawner;

/** Builds the adapter that serves one session; `onPermissionRequest` must be passed to it. */
export type AdapterFactory = (runtime: Runtime, sessionId: SessionId, hooks: { onPermissionRequest(handle: PermissionHandle): unknown }) => RuntimeAdapter;

export interface BackendOptions {
  dbPath: string;
  bus: Pick<EventBus, 'seq' | 'publish'>;
  /** The process host, recording into the backend's own OwnedProcess repository (T013). */
  createHost(processes: OwnedProcessRepository): BackendProcessHost;
  /**
   * Finds the user's own Claude Code and Codex (runtime-locator.ts, T045). A runtime is available only while its last
   * detection says so; without one (tests) Claude is always available and Codex only with an injected `createAdapter`.
   */
  runtimes?: RuntimeLocator;
  /** Replaces the real adapters (tests). */
  createAdapter?: AdapterFactory;
  /** Replaces the git adapter (tests). */
  createGit?: () => GitPort;
  /** How soon after a failed detection an unavailable runtime is looked for again before a command that needs it (default 2 s). */
  redetectMinMs?: number;
  /** Replaces the runtimes' model lists (tests). */
  listModels?: (runtime: Runtime) => Promise<ModelOption[]>;
  policy?: PermissionPolicy;
  resolveRealPath(absolutePath: string): string | null;
  /** Replaces fs.watch (tests). */
  watch?: WatchFn;
  now?: () => Date;
  uuid?: () => string;
  /** Diagnostics: fixed text, IDs and error names only. */
  log: (message: string) => void;
  closeTimeoutMs?: number;
  /**
   * The idle supervisor (T036): how often it looks (default SUPERVISOR_DEFAULTS.tickMs). How long a session goes unused
   * before its runtime is closed and how many runtimes may be open come from the user's preferences (C-30); `idleMs` and
   * `maxOpen` here override them (tests and development runs only; 0: no limit).
   */
  supervisor?: { idleMs?: number; maxOpen?: number; tickMs?: number };
  /** A development run's fault point for the crash tests (fault-points.ts, T039); never set in a packaged app. */
  faultPoint?: FaultPoint;
  /** Storage fault hooks (adapters/storage/testing, T038): tests only. */
  storageHooks?: StorageHooks;
  /** Turns of each session's history in the Snapshot (C-26); older ones are read with `session.history`. Default 50. */
  snapshotTurns?: number;
}

/** Turns per session in the Snapshot by default: the renderer reads older history 50 turns a page (T041). */
export const SNAPSHOT_TURNS = 50;

/** Commands accepted while the data is read-only (C-29): they write nothing of the app's database. */
const READ_ONLY_COMMANDS: ReadonlySet<Command['type']> = new Set(['backup.restore', 'backup.cancelRestore', 'runtime.detect']);

/** The fixed text of a command refused while the data is read-only. */
export const STORAGE_READ_ONLY = 'The data is read-only now; nothing was changed';

export interface Backend {
  status: 'ready';
  facade: AppFacade;
  service: SessionService;
  /** The workflow engine (T024) behind `workflow.start` and the workflow MCP tools. */
  workflow: WorkflowEngine;
  /** Cross-tool transfer (T023) behind `transfer.*`. */
  transfer: TransferService;
  repositories: AppRepositories;
  mcp: GuiMcpServer;
  /** The git / worktree adapter (T030) the task pipeline (T032) runs its worktrees, merges and fast-forwards through. */
  git: GitPort;
  /** Closes idle runtimes while the app runs (T036); its timer is the backend's. */
  supervisor: IdleSupervisor;
  /** What exiting now would cut off (R-14). */
  unfinishedWork(): Promise<{ runningSessions: number; heldRequests: number; runningNativeTasks: number; commands: number }>;
  shutdown(): Promise<void>;
}

/** A runtime was asked to start while its last detection says it cannot be used (fixed text: nothing of the runtime's output). */
export class RuntimeUnavailableError extends Error {
  constructor(readonly runtime: Runtime) {
    super(`${runtime} is not available on this computer`);
    this.name = 'RuntimeUnavailableError';
  }
}

/** The database cannot be opened or holds damaged records: nothing runs, the user is told (fail closed). */
export interface DamagedBackend {
  status: 'damaged';
  facade: AppFacade;
  dbPath: string;
  /** Error name, and for StoredDataError the table and rule codes; never record content. */
  reason: string;
  shutdown(): Promise<void>;
}

/** The fixed text a renderer gets instead of a Snapshot when the stored data is damaged. */
export const STORAGE_DAMAGED = 'The stored data is damaged; nothing was loaded';

const describe = (error: unknown): string => {
  if (!(error instanceof Error)) return 'non-error thrown';
  const { table, problems } = error as Error & { table?: unknown; problems?: unknown };
  if (error.name === 'StoredDataError' && typeof table === 'string' && Array.isArray(problems)) return `${error.name}: ${table} (${problems.join(', ')})`;
  return error.name;
};

/**
 * The facade while the stored data is damaged (C-06): a Snapshot that says so, with the fixed reason code
 * and the database location and nothing else, and every command refused.
 */
export const damagedFacade = (reason: string, location: string): AppFacade => ({
  snapshot: (): Snapshot => ({
    schemaVersion: CONTRACTS_VERSION,
    app: { status: 'damaged', reason, location },
    seq: 0,
    agents: [],
    workflows: [],
    modelOptions: [],
    sessions: [],
    messages: [],
    turns: [],
    items: [],
    permissionRequests: [],
    nativeTasks: [],
    artifacts: [],
    instances: [],
    handoffs: [],
    peerMessages: [],
    escalations: [],
    transfers: [],
    projects: [],
    locks: [],
    preferences: { theme: 'dark', supervisor: { idleCloseMinutes: 15, maxOpenRuntimes: 6 } },
    historyPages: [],
    storage: {},
    runtimes: [],
  }),
  execute: (command: Command) => failure(command.requestId, 'storage_failed', STORAGE_DAMAGED),
});

const sha256 = (text: string): PayloadHash => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/** Calls `fn` once `at` has come by `now`, in setTimeout steps it can hold (about 24 days at most each). */
const scheduleAt = (now: () => string) => (at: string, fn: () => void): (() => void) => {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    const delay = Date.parse(at) - Date.parse(now());
    if (delay <= 0) return fn();
    handle = setTimeout(arm, Math.min(delay, 2 ** 31 - 1)).unref();
  };
  arm();
  return () => clearTimeout(handle);
};

export async function startBackend(options: BackendOptions): Promise<Backend | DamagedBackend> {
  const { bus } = options;
  // Every MCP token handed out, revoked ones included, in every spelling the core matches: no log line
  // carries one (r1-P1-2, r2-P1-2).
  const tokens = new Redactor();
  const log = (message: string) => options.log(tokens.text(message));
  const now = () => (options.now?.() ?? new Date()).toISOString();
  const uuid = () => options.uuid?.() ?? randomUUID();
  const closeTimeoutMs = options.closeTimeoutMs ?? 5000;

  // Runtime detection (C-33, T045): what was found of each runtime at the last detection. Without a locator (tests) Claude
  // is always available and Codex only with an injected adapter factory.
  const statuses = new Map<Runtime, RuntimeStatus>();
  const isRuntimeAvailable = (runtime: Runtime): boolean =>
    options.runtimes === undefined ? runtime === 'claude' || options.createAdapter !== undefined : statuses.get(runtime)?.state === 'available';

  // 1-2. Storage, read once in full: a damaged record stops everything here (T015 fails closed).
  // The deliveries recovery will read are read here too (r1-P1-6): pending and unknown ones.
  let db: DatabaseSync | undefined;
  let closeStorage: () => void = () => db?.close();
  let repositories: AppRepositories;
  let store: SqliteDeliveryStore;
  // Backups (C-28): none for an in-memory database (tests), which has no folder of its own.
  let backups: BackupStore | undefined;
  let health: StorageHealth;
  const damaged = (error: unknown): DamagedBackend => {
    const reason = describe(error);
    log(`[backend] the database cannot be used (${reason}); nothing is started`);
    try {
      closeStorage();
    } catch {
      // Already unusable.
    }
    return { status: 'damaged', facade: damagedFacade(reason, options.dbPath), dbPath: options.dbPath, reason, shutdown: () => Promise.resolve() };
  };
  try {
    // T038: a pending restore, migrations after their backup, the day's backup and pruning, in that order; data that
    // cannot be written opens read-only (C-29).
    if (options.dbPath === ':memory:') {
      db = openDatabase(options.dbPath);
      health = storageHealth(db);
      if (options.storageHooks !== undefined) storageHealth(db).hooks = options.storageHooks;
    } else {
      const opened = await openStorage(options.dbPath, { now: now(), ...(options.storageHooks !== undefined && { hooks: options.storageHooks }) });
      db = opened.db;
      closeStorage = opened.close;
      backups = opened.backups;
      health = opened.health;
      const report = opened.report;
      if (report.restored !== undefined) log('[backend] a backup was restored at start');
      if (report.restoreFailure !== undefined) log(`[backend] the restore asked for did not happen (${report.restoreFailure.reason})`);
      for (const f of report.backupFailures) log(`[backend] backup ${f.operation} failed (${f.reason})`);
      if (report.state.status === 'read-only') log(`[backend] the data opened read-only (${report.state.reason})`);
    }
    repositories = createRepositories(db);
    store = new SqliteDeliveryStore(db);
    await repositories.readSnapshotData();
    await store.listByState('pending');
    await store.listByState('unknown');
  } catch (error) {
    return damaged(error);
  }
  const host = options.createHost(repositories.processes);

  // Read-only (C-29): the data opened so, or turned so while the app runs (a full disk); never ready again before a
  // restart. Writing commands are refused before they reach the core, so nothing is dispatched to a runtime.
  const opened = health.state();
  let readOnly: ReadOnlyReason | undefined = opened.status === 'read-only' ? opened.reason : undefined;
  // Listened to from here on, before anything else writes (the orphan cleanup below may already fill the disk): the
  // views are told, nothing more is stored or dispatched, and no idle runtime is closed any more.
  const late: { supervisor?: IdleSupervisor } = {};
  /** The supervisor's limits from the user's preferences (C-30), unless the options override them. */
  const limitsOf = (preferences: UiPreferences | undefined) => ({
    idleMs: options.supervisor?.idleMs ?? (preferences === undefined ? SUPERVISOR_DEFAULTS.idleMs : preferences.supervisor.idleCloseMinutes * 60_000),
    maxOpen: options.supervisor?.maxOpen ?? preferences?.supervisor.maxOpenRuntimes ?? SUPERVISOR_DEFAULTS.maxOpen,
  });
  health.onReadOnly((reason) => {
    if (readOnly !== undefined) return;
    readOnly = reason;
    log(`[backend] the data turned read-only (${reason})`);
    late.supervisor?.stop();
    void bus.publish({ type: 'app.readOnly', reason, location: options.dbPath, at: now() });
  });

  // 3. A crashed run's processes: only those whose PID and creation time both still match are ended.
  try {
    const live = await repositories.processes.listLive();
    const cleaned = await host.cleanupOrphans(live);
    for (const p of [...cleaned.ended, ...cleaned.gone]) await repositories.processes.markEnded(p.pid, p.startedAt, now());
    if (cleaned.ended.length > 0) log(`[backend] ended ${String(cleaned.ended.length)} process(es) left by an earlier run`);
  } catch (error) {
    log(`[backend] cleaning up earlier processes failed (${describe(error)})`);
  }

  /**
   * At the end (R-14): every Job of this run is closed, also one whose processes all exited by themselves (a
   * runtime opened only to reconcile, T039 r1-P1-1), so their records are ended; what is still recorded live then
   * is looked at once more by PID and creation time, and gone is recorded ended like at the start.
   */
  const endJobs = async (): Promise<void> => {
    const left: OwnedProcess[] = await host.listOwned().catch(() => []);
    const recorded = await repositories.processes.listLive().catch(() => [] as OwnedProcess[]);
    for (const sessionId of new Set([...left, ...recorded].map((p) => p.sessionId))) await host.closeJob(sessionId).catch(() => undefined);
    const still = await repositories.processes.listLive().catch(() => [] as OwnedProcess[]);
    if (still.length === 0) return;
    const cleaned = await host.cleanupOrphans(still).catch(() => ({ ended: [] as OwnedProcess[], gone: [] as OwnedProcess[] }));
    for (const p of [...cleaned.ended, ...cleaned.gone]) await repositories.processes.markEnded(p.pid, p.startedAt, now()).catch(() => undefined);
  };

  // 4-5. MCP server, adapters, the session service. Handlers and hooks reach the service once it exists.
  const ref: { service?: SessionService; workflow?: WorkflowEngine } = {};
  const starting = { status: 'rejected', rejection: { reason: 'shutting-down', detail: 'the GUI is starting' } } as const;
  // A tool that would store something, while the data is read-only (C-29): the agent may call again later. McpRejection
  // has no reason of its own for it; `busy` says "not now".
  const frozen = { status: 'rejected', rejection: { reason: 'busy', detail: 'the GUI cannot store anything now (its data is read-only)' } } as const;
  const handlers: McpToolHandlers = {
    handoff: (input, ctx) => (readOnly !== undefined ? Promise.resolve(frozen) : (ref.workflow?.handoff(input, ctx) ?? Promise.resolve(starting))),
    create_tasks: (input, ctx) => (readOnly !== undefined ? Promise.resolve(frozen) : (ref.workflow?.createTasks(input, ctx) ?? Promise.resolve(starting))),
    report_to_root: (input, ctx) => (readOnly !== undefined ? Promise.resolve(frozen) : (ref.workflow?.reportToRoot(input, ctx) ?? Promise.resolve(starting))),
    // Same-folder locks (R-07): ordinary and workflow sessions alike. Held in memory only, so read-only data leaves them.
    wait_for_file: (input, ctx) => ref.service?.waitForFile(input, ctx) ?? Promise.resolve(starting),
    send_message: (input, ctx) => {
      if (readOnly !== undefined) return Promise.resolve(frozen);
      if (ref.service === undefined) return Promise.resolve({ status: 'rejected', rejection: { reason: 'shutting-down', detail: 'the GUI is starting' } });
      return ref.service.sendMessage(input, ctx);
    },
  };
  const mcp = await GuiMcpServer.start({ handlers, log: (message) => log(`[mcp] ${message}`) });
  // What git ignores is no unlocked write (T033); its rules are read again when the watcher sees them change.
  const ignored = new GitIgnoreRules(undefined, undefined, log);
  const watchers = new WorkspaceWatchers(
    {
      changed: (sessionId, root, path) => {
        // Nothing here may throw into fs.watch's callback (T033 r1 P1-4).
        try {
          ignored.changed(path);
          ref.service?.workspaceChanged(sessionId, root, path);
        } catch (error) {
          log(`[watch] a change of ${sessionId} could not be handled (${describe(error)})`);
        }
      },
      failed: (sessionId, root) => ref.service?.workspaceWatchFailed(sessionId, root),
    },
    log,
    options.watch,
  );
  const adapterLog = (runtime: Runtime) => (level: 'debug' | 'warn', message: string) => {
    // The detail argument is left out: it can hold transcript text or protocol lines.
    if (level === 'warn') log(`[${runtime}] ${message}`);
  };
  // A new adapter for every opening of a session, Claude included (T036 r2 P1-1): the late end of an earlier opening
  // (its stream ending, its exit) then comes from an adapter that no longer serves the session, and is told apart.
  const makeAdapter: AdapterFactory =
    options.createAdapter ??
    ((runtime, sessionId, hooks) => {
      if (runtime === 'claude') {
        const claudeExecutable = statuses.get('claude')?.executable;
        return new ClaudeAdapter({
          sdk: claudeAgentSdk,
          // The user's own Claude Code (T045); the SDK's built-in copy only when none was detected (tests).
          ...(claudeExecutable !== undefined && { executable: claudeExecutable }),
          onPermissionRequest: (handle) => hooks.onPermissionRequest(handle),
          spawnProcess: ({ sessionId: id }) => claudeProcessSpawn(host, id),
          log: adapterLog('claude'),
        });
      }
      const command = statuses.get('codex')?.executable;
      if (command === undefined) throw new Error('Codex is not available');
      return new CodexAdapter({
        spawn: codexAppServerSpawn(host, sessionId, { command }),
        endJob: () => host.closeJob(sessionId),
        onPermissionRequest: (handle) => hooks.onPermissionRequest(handle),
        log: adapterLog('codex'),
      });
    });
  // The one door every start of a runtime goes through (create, resume, delivery recovery, transfer, workflow, model
  // probe): a runtime whose last detection is not `available` gets no adapter, so a path that was only shown (a link
  // to something that is not an .exe, an old version, a signed-out runtime) is never started (T045 review r3). The
  // callers see a failure before any runtime is called: a delivery stays pending, never claimed and never unknown.
  const { faultPoint } = options;
  if (faultPoint !== undefined) log(`[fault] armed: ${faultPoint.point} of ${faultPoint.sessionId ?? `every ${String(faultPoint.runtime)} session`}`);
  const createAdapter: AdapterFactory = (runtime, sessionId, hooks) => {
    if (options.runtimes !== undefined && !isRuntimeAvailable(runtime)) throw new RuntimeUnavailableError(runtime);
    const adapter = makeAdapter(runtime, sessionId, hooks);
    return faultPoint !== undefined && faultApplies(faultPoint, runtime, sessionId) ? withFaultPoint(adapter, sessionId, faultPoint, log) : adapter;
  };
  const hooks ={ onPermissionRequest: (handle: PermissionHandle) => (ref.service === undefined ? Promise.reject(new Error('not ready')) : ref.service.onPermissionRequest(handle)) };
  // T035: the Claude adapter the model probe ran on (its own since T036; an injected factory may still share one). The
  // exit closes it even when no Claude session ever ran, so a probe's claude.exe is ended and its temp folder removed
  // before the GUI goes.
  let claudeProbeAdapter: RuntimeAdapter | undefined;
  let probesStopped = false;
  const listModels =
    options.listModels ??
    (async (runtime: Runtime): Promise<ModelOption[]> => {
      // No probe once the exit has begun.
      if (probesStopped) throw new Error('the application is closing');
      // Listed outside any session: Codex in a Job of its own, ended right after.
      const probeId = `models-${runtime}` as SessionId;
      // Claude's probe keeps the service's hooks (an injected factory may hand it the adapter sessions share); the
      // Codex probe has an app-server of its own, where nothing can be allowed.
      const probeHooks = runtime === 'claude' ? hooks : { onPermissionRequest: (h: PermissionHandle) => h.answer({ outcome: 'decline', decidedBy: 'policy', at: now() }) };
      const adapter = createAdapter(runtime, probeId, probeHooks);
      if (runtime === 'claude') claudeProbeAdapter = adapter;
      try {
        if (runtime === 'codex') await adapter.start();
        return await adapter.listModels();
      } finally {
        if (runtime === 'codex') await adapter.close(2000).catch(() => undefined);
        // The probe's Job is done with either way (T039): Claude's listModels returns once its claude.exe has exited (or
        // was waited for), and only ending the Job records its runtime-host as ended; the exit ends only Jobs with a
        // live process left, so a probe whose process exited by itself would keep an open record until the next start.
        await host.closeJob(probeId).catch(() => undefined);
      }
    });

  let modelOptions: ModelOption[] = [];
  /** Looks for the runtime again: executable, version and sign-in. The model list is the next step. */
  const probe = async (runtime: Runtime): Promise<void> => {
    if (options.runtimes === undefined) return;
    statuses.set(runtime, await options.runtimes.detect(runtime, now()));
  };
  /** The models of an available runtime, listed again; none for an unavailable one, so no dropdown offers it. */
  const refreshModels = async (runtime: Runtime): Promise<void> => {
    const status = statuses.get(runtime);
    if (options.runtimes === undefined || status === undefined) return;
    let list: ModelOption[] = [];
    if (status.state === 'available') {
      try {
        list = await listModels(runtime);
      } catch (error) {
        // A failed listing keeps what was listed before.
        log(`[backend] listing ${runtime} models failed (${describe(error)})`);
        list = modelOptions.filter((m) => m.runtime === runtime);
      }
    }
    modelOptions = [...modelOptions.filter((m) => m.runtime !== runtime), ...list];
    const current = statuses.get(runtime) ?? status;
    const next = { ...current, modelCount: current.state === 'available' ? list.length : 0 };
    statuses.set(runtime, next);
    void bus.publish({ type: 'modelOptions.updated', runtime, options: list, at: now() });
    void bus.publish({ type: 'runtime.status', status: next });
  };
  // One detection per runtime at a time; a second ask while one runs gets that one's result.
  const detecting = new Map<Runtime, Promise<void>>();
  const track = (runtime: Runtime, work: Promise<void>): Promise<void> => {
    const tracked = work.catch((error: unknown) => log(`[backend] detecting ${runtime} failed (${describe(error)})`)).finally(() => detecting.delete(runtime));
    detecting.set(runtime, tracked);
    return tracked;
  };
  /** Read-only data (C-29): the runtime is looked for, but no model probe starts it; its status is published as is. */
  const publishStatus = (runtime: Runtime): void => {
    const status = statuses.get(runtime);
    if (status !== undefined) void bus.publish({ type: 'runtime.status', status });
  };
  const detect = (runtime: Runtime): Promise<void> =>
    detecting.get(runtime) ?? track(runtime, probe(runtime).then(() => (readOnly !== undefined ? publishStatus(runtime) : refreshModels(runtime))));
  const RUNTIMES: readonly Runtime[] = ['claude', 'codex'];
  /** Before a runtime is used: when it is not available now, it is looked for once more (not more often than redetectMinMs). */
  const lastTried = new Map<Runtime, number>();
  const redetectIfUnavailable = async (wanted: readonly Runtime[]): Promise<void> => {
    if (options.runtimes === undefined) return;
    await Promise.all(
      wanted.map(async (runtime) => {
        if (isRuntimeAvailable(runtime)) return;
        // A detection already under way answers every command that needs the runtime, whenever it began; the pause
        // between two detections only applies when none is running (T045 review r1).
        const running = detecting.get(runtime);
        if (running !== undefined) return running;
        const since = Date.now() - (lastTried.get(runtime) ?? 0);
        if (since < (options.redetectMinMs ?? 2000)) return;
        lastTried.set(runtime, Date.now());
        await detect(runtime);
      }),
    );
  };
  /** The runtimes a command is about to start or resume. */
  const runtimesOf = async (command: Command): Promise<readonly Runtime[]> => {
    switch (command.type) {
      case 'session.create':
      case 'session.setModel':
        return [command.model.runtime];
      case 'session.send': {
        // A send resumes a runtime the idle supervisor closed.
        const session = await repositories.sessions.get(command.sessionId);
        return session === undefined ? [] : [session.requestedModel.runtime];
      }
      case 'workflow.start': {
        // Only what the template uses: a Codex-only workflow does not wait for Claude to be looked for.
        const template = await repositories.workflows.get(command.workflowId);
        return template === undefined ? [] : RUNTIMES.filter((runtime) => template.nodes.some((node) => node.kind === 'agent' && node.model.runtime === runtime));
      }
      case 'transfer.confirm': {
        const proposal = await repositories.transfers.get(command.transferId);
        return proposal === undefined ? [] : [proposal.target.runtime];
      }
      default:
        return [];
    }
  };

  const service = new SessionService({
    repositories,
    store,
    policy: options.policy ?? permissionPolicy,
    publish: (event) => {
      // C-30: saved preferences are the supervisor's limits from now on; published in the order they were stored, so
      // the last one saved is the one used, however many `preferences.set` ran at once.
      if (event.type === 'preferences.updated') late.supervisor?.setLimits(limitsOf(event.preferences));
      void bus.publish(event);
      // T031: a delivery decision may end a round's branch.
      ref.workflow?.observe(event);
    },
    now,
    uuid,
    hashPayload: sha256,
    resolveRealPath: (path) => options.resolveRealPath(path),
    // The router's hooks: each opening's requests know whether that opening still serves the session (T036 r3 P1-2).
    createAdapter: (runtime, sessionId, sessionHooks) => createAdapter(runtime, sessionId, sessionHooks),
    mountMcp: (sessionId) => {
      const mount = mcp.mount(sessionId);
      tokens.add(mount.token);
      return mount;
    },
    sleep,
    // Same-folder file locks (T033, R-07): in memory only, so a restart starts with none.
    // T032: a worktree the task pipeline made (`<repo>\.awg\wt\<name>`, one it recorded) is no same-folder work:
    // inside one, git's own root is the worktree, so the repository's `info/exclude` line for `.awg` does not reach it.
    locks: {
      hashFile: (path) => hashFile(path),
      setTimer,
      isIgnored: (path) => (isPipelineFolder(path) && ref.workflow?.pipeline?.ownsPath(path) === true) || ignored.isIgnored(path),
    },
    listModels,
    isRuntimeAvailable,
    onSessionOpened: (sessionId) => {
      void repositories.sessions.get(sessionId).then((s) => s && (watchers.start(sessionId, s.folderScope.workspaceRoot), ignored.acquire(sessionId, s.folderScope.workspaceRoot)));
    },
    onSessionClosed: async (sessionId) => {
      watchers.stop(sessionId);
      ignored.release(sessionId);
      try {
        mcp.revoke(sessionId);
      } catch {
        // Closed already.
      }
      // The graceful close had its chance; whatever is left in the session's Job ends now (R-14, CR-7).
      await host.closeJob(sessionId).catch((error: unknown) => log(`[backend] ending the Job of ${sessionId} failed (${describe(error)})`));
    },
    log,
  });
  ref.service = service;
  // T024: workflow.start, the workflow tools and workflow escalations; it reaches storage through the service.
  // T032: the task pipeline's worktrees, setup and test commands and merge queue. Before a folder is removed, the
  // runtime of a session working in it is closed by the service (R-14), then its Job.
  const git = options.createGit?.() ?? new GitAdapter();
  const workflow = new WorkflowEngine({
    sessions: service,
    publish: (event) => void bus.publish(event),
    now,
    uuid,
    hashPayload: sha256,
    schedule: scheduleAt(now),
    pipeline: {
      git,
      commands: jobCommandRunner(host, { log }),
      files: gitWorktreeFiles(),
      resolveRealPath: (path) => options.resolveRealPath(path),
    },
    log,
  });
  service.attachWorkflow(workflow);
  ref.workflow = workflow;
  // T023: transfer.prepare / confirm / cancel; it reaches storage and runtimes through the service too.
  const transfer = new TransferService({ sessions: service, publish: (event) => void bus.publish(event), now, hashPayload: sha256, log });
  service.attachTransfer(transfer);
  // T036: idle runtimes closed while the app runs (never after it, D-03); the next delivery resumes them. Its limits
  // are the user's (C-30), read once here and again with each saved change.
  const limits = limitsOf(await repositories.preferences.get().catch(() => undefined));
  const supervisor = new IdleSupervisor({
    sessions: service,
    now,
    idleMs: limits.idleMs,
    maxOpen: limits.maxOpen,
    closeTimeoutMs,
    // A background command or a Codex Start-Process child would end with the session's Job (R-14).
    ownedCommands: async (sessionId) => (await host.listOwned(sessionId)).filter((p) => p.kind === 'command' && p.endedAt === undefined).length,
    log,
  });
  service.attachSupervisor(supervisor);
  late.supervisor = supervisor;

  // 5b. The runtimes found on this computer, before recovery asks whether a runtime can be used (C-33). Their model
  // lists come later, in the background.
  await Promise.all(RUNTIMES.map((runtime) => probe(runtime).catch((error: unknown) => log(`[backend] detecting ${runtime} failed (${describe(error)})`))));

  // 6. Restart recovery (CR-2): unknown only reconciled, pending through the one dispatch entry. Stored data
  // it cannot read stops the start like damaged data does (r1-P1-6): no model probe, no runtime.
  // Nothing is recovered from read-only data: recovery writes, and dispatches (C-29). A restart once the data can be
  // written again (space freed, a backup restored, a newer app) recovers it then.
  if (readOnly !== undefined) log('[backend] read-only data: deliveries, runs and transfers are not recovered now');
  else try {
    const report = await service.start();
    if (report.failed.length > 0) log(`[backend] ${String(report.failed.length)} delivery(ies) could not be recovered`);
    // Each run's tasks rebuilt from its handoffs, the record of what was counted (T024).
    await workflow.recover();
    // Each confirmed transfer goes on from the step it stopped at; a cancelled one sends nothing (T023).
    await transfer.recover();
  } catch (error) {
    await service.shutdown(closeTimeoutMs).catch(() => undefined);
    await mcp.close().catch(() => undefined);
    await endJobs();
    watchers.stopAll();
    ignored.close();
    return damaged(error);
  }

  // 7. Model lists, in the background: the window does not wait for them (R-12). None from read-only data: a probe
  // would start a runtime for nothing that can be used now.
  if (readOnly !== undefined) supervisor.stop();
  for (const runtime of readOnly === undefined ? RUNTIMES : []) {
    if (options.runtimes !== undefined) {
      void track(runtime, refreshModels(runtime));
      continue;
    }
    if (runtime === 'codex' && options.createAdapter === undefined) continue;
    void listModels(runtime)
      .then((list) => {
        modelOptions = [...modelOptions.filter((m) => m.runtime !== runtime), ...list];
        bus.publish({ type: 'modelOptions.updated', runtime, options: list, at: now() });
      })
      .catch((error: unknown) => log(`[backend] listing ${runtime} models failed (${describe(error)})`));
  }

  // After recovery: what it dispatched has made those sessions used just now.
  const idleTimer = setInterval(() => void supervisor.tick(), options.supervisor?.tickMs ?? SUPERVISOR_DEFAULTS.tickMs);
  idleTimer.unref();

  let closing: Promise<void> | undefined;
  /** What the views show of backups and restores (C-28); a catalog that cannot be read shows nothing. */
  const storageInfo = async (): Promise<StorageInfo> => {
    try {
      return (await backups?.info()) ?? {};
    } catch (error) {
      log(`[backend] the backup catalog could not be read (${describe(error)})`);
      return {};
    }
  };
  // Backup commands one at a time, each publishing the StorageInfo it left: two at once could otherwise publish their
  // reads out of order, and the views would keep the older one.
  let storageQueue: Promise<unknown> = Promise.resolve();
  const inStorageQueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = storageQueue.then(fn, fn);
    storageQueue = run.catch(() => undefined);
    return run;
  };
  const backupCommand = (command: Extract<Command, { type: 'backup.restore' | 'backup.cancelRestore' }>): Promise<CommandResult> =>
    inStorageQueue(async () => {
      if (backups === undefined) return failure(command.requestId, 'unsupported', 'This database has no backups');
      if (command.type === 'backup.restore') {
        if ((await backups.scheduleRestore(command.backupId, now())) === 'not-found') return failure(command.requestId, 'not_found', 'No such backup');
      } else await backups.cancelRestore();
      void bus.publish({ type: 'storage.updated', storage: await storageInfo(), at: now() });
      return { ok: true, requestId: command.requestId, created: [] };
    });
  const facade: AppFacade = {
    async snapshot(): Promise<Snapshot> {
      // The seq first: anything published after it is applied again by the renderer, never skipped.
      const seq = bus.seq;
      // C-26: each session's last turns (and whatever is open); older pages through `session.history`.
      const data = await repositories.readSnapshotData({ recentTurns: options.snapshotTurns ?? SNAPSHOT_TURNS });
      const storage = await storageInfo();
      return {
        schemaVersion: CONTRACTS_VERSION,
        app: readOnly === undefined ? { status: 'ready' } : { status: 'read-only', reason: readOnly, location: options.dbPath },
        seq,
        agents: data.agents,
        workflows: data.workflows,
        modelOptions,
        sessions: data.sessions,
        messages: data.conversations.messages,
        turns: data.conversations.turns,
        items: data.conversations.items,
        permissionRequests: data.conversations.permissionRequests,
        nativeTasks: data.conversations.nativeTasks,
        artifacts: data.conversations.artifacts,
        instances: data.instances,
        handoffs: data.handoffs,
        peerMessages: data.peerMessages,
        escalations: data.escalations,
        transfers: data.transfers,
        projects: data.projects,
        // File locks (R-07) live in memory only: the lock table's list now.
        locks: service.locks?.list() ?? [],
        preferences: data.preferences,
        historyPages: data.historyPages,
        storage,
        runtimes: RUNTIMES.flatMap((runtime) => statuses.get(runtime) ?? []),
      };
    },
    async execute(command: Command): Promise<CommandResult> {
      if (closing !== undefined) return failure(command.requestId, 'runtime_unavailable', 'The application is closing');
      // C-29: refused before the core sees it, so nothing is stored or dispatched.
      if (readOnly !== undefined && !READ_ONLY_COMMANDS.has(command.type)) return failure(command.requestId, 'storage_read_only', STORAGE_READ_ONLY);
      try {
        if (command.type === 'backup.restore' || command.type === 'backup.cancelRestore') return await backupCommand(command);
        if (command.type === 'runtime.detect') {
          if (options.runtimes === undefined) return failure(command.requestId, 'unsupported', 'runtime.detect is not available');
          await Promise.all((command.runtime === undefined ? RUNTIMES : [command.runtime]).map(detect));
          return { ok: true, requestId: command.requestId, created: [] };
        }
        await redetectIfUnavailable(await runtimesOf(command));
        return await service.execute(command);
      } catch (error) {
        log(`[backend] ${command.type} failed (${describe(error)})`);
        // A write refused, or rolled back for lack of space, changed nothing, and the data is read-only now (C-29).
        if (error instanceof StorageReadOnlyError || (error instanceof StorageWriteError && error.kind === 'disk-full')) {
          return failure(command.requestId, 'storage_read_only', STORAGE_READ_ONLY);
        }
        const storage = error instanceof StorageWriteError || (error instanceof Error && (error.name === 'StoredDataError' || error.name === 'InvalidRecordError'));
        return failure(command.requestId, storage ? 'storage_failed' : 'internal_error', storage ? 'The stored data could not be read or written' : 'The command failed', {
          mayHaveSideEffects: true,
        });
      }
    },
    async query(request: QueryRequest): Promise<QueryResult> {
      // Read-only queries (C-26, C-28): answered in read-only mode too.
      try {
        if (request.type === 'backup.list') return { ok: true, type: 'backup.list', requestId: request.requestId, backups: (await backups?.list()) ?? [] };
        if ((await repositories.sessions.get(request.sessionId)) === undefined) return { ok: false, requestId: request.requestId, code: 'not_found', message: 'No such session' };
        const page = await repositories.conversations.page(request.sessionId, request.before, request.limit);
        // A cursor of another session, one never handed out, or one too old to be kept (C-26).
        if (page === 'invalid-cursor') {
          return { ok: false, requestId: request.requestId, code: 'invalid_request', message: 'The history cursor is not valid for this session; read the Snapshot again' };
        }
        return { ok: true, type: 'session.history', requestId: request.requestId, page };
      } catch (error) {
        log(`[backend] ${request.type} failed (${describe(error)})`);
        const storage = error instanceof Error && (error.name === 'StoredDataError' || error.name === 'InvalidRecordError');
        return { ok: false, requestId: request.requestId, code: storage ? 'storage_failed' : 'internal_error', message: storage ? 'The stored data could not be read' : 'The query failed' };
      }
    },
  };

  const shutdown = (): Promise<void> => {
    closing ??= (async () => {
      // R-14: the core stops taking anything new at once (a permission check under way is declined), then no new
      // tool calls, then every session closed gracefully, then whatever is left in a Job.
      clearInterval(idleTimer);
      supervisor.stop();
      service.beginClose();
      probesStopped = true;
      await mcp.close().catch(() => undefined);
      // Bounded inside (each wait has its deadline); the database closes only after it returned (r1-P1-5).
      await service.shutdown(closeTimeoutMs);
      // T035: the probe's Claude adapter, which closeAll leaves out when no Claude session ran; closing it
      // again after closeAll finds nothing left. Bounded by the same deadline; before the Jobs are ended, so
      // the probe's claude.exe exits through it and its folder goes.
      await claudeProbeAdapter?.close(closeTimeoutMs).catch(() => undefined);
      await endJobs();
      watchers.stopAll();
      ignored.close();
      closeStorage();
    })();
    return closing;
  };

  return {
    status: 'ready',
    facade,
    service,
    workflow,
    transfer,
    repositories,
    mcp,
    git,
    supervisor,
    async unfinishedWork() {
      const work = await service.unfinishedWork();
      const owned = await host.listOwned().catch(() => []);
      return {
        runningSessions: work.runningSessions.length,
        heldRequests: work.heldRequests,
        runningNativeTasks: work.runningNativeTasks,
        commands: owned.filter((p) => p.kind === 'command' && p.endedAt === undefined).length,
      };
    },
    shutdown,
  };
}
