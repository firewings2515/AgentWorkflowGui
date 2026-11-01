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
  type Runtime,
  type SessionId,
  type Snapshot,
} from '../../contracts';
import { ClaudeAdapter, claudeAgentSdk } from '../../adapters/claude';
import { CodexAdapter } from '../../adapters/codex';
import { GitAdapter } from '../../adapters/git';
import { GuiMcpServer, type McpToolHandlers } from '../../adapters/mcp-server';
import { claudeProcessSpawn, codexAppServerSpawn, type JobSpawner } from '../../adapters/process';
import { createRepositories, openDatabase, SqliteDeliveryStore } from '../../adapters/storage';
import { permissionPolicy } from '../../core/policy';
import type { AppRepositories, GitPort, OwnedProcessRepository, PermissionHandle, PermissionPolicy, ProcessHost, RuntimeAdapter } from '../../core/ports';
import { Redactor, SessionService } from '../../core/sessions';
import { IdleSupervisor, SUPERVISOR_DEFAULTS } from '../../core/supervisor';
import { TransferService } from '../../core/transfer';
import { WorkflowEngine } from '../../core/workflow';
import type { EventBus } from './event-bus';
import { type AppFacade, failure } from './facade';
import { hashFile, setTimer } from './file-hash';
import { GitIgnoreRules } from './git-ignore';
import { type PackagedContext, withUnpackedCommand } from './packaged-paths';
import { gitWorktreeFiles, isPipelineFolder, jobCommandRunner } from './pipeline-host';
import { WorkspaceWatchers, type WatchFn } from './workspace-watch';

const NOT_PACKAGED: PackagedContext = { isPackaged: false, resourcesPath: '' };

/** What the main process needs from its process host: the port plus the spawn the adapters use (T013). */
export type BackendProcessHost = ProcessHost & JobSpawner;

/** Builds the adapter that serves one session; `onPermissionRequest` must be passed to it. */
export type AdapterFactory = (runtime: Runtime, sessionId: SessionId, hooks: { onPermissionRequest(handle: PermissionHandle): unknown }) => RuntimeAdapter;

export interface BackendOptions {
  dbPath: string;
  bus: Pick<EventBus, 'seq' | 'publish'>;
  /** The process host, recording into the backend's own OwnedProcess repository (T013). */
  createHost(processes: OwnedProcessRepository): BackendProcessHost;
  /** Where the app runs from (packaged-paths.ts); claude.exe is started from `app.asar.unpacked` when packaged. */
  packaged?: PackagedContext;
  /** The Codex executable (codex-exe.ts); Codex is unavailable without one. */
  codexExecutable?: string | undefined;
  /** Replaces the real adapters (tests). */
  createAdapter?: AdapterFactory;
  /** Replaces the git adapter (tests). */
  createGit?: () => GitPort;
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
   * The idle supervisor (T036): how long a session goes unused before its runtime is closed, how many runtimes may
   * be open at once (0: no limit), and how often it looks. Defaults: SUPERVISOR_DEFAULTS.
   */
  supervisor?: { idleMs?: number; maxOpen?: number; tickMs?: number };
}

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

  // 1-2. Storage, read once in full: a damaged record stops everything here (T015 fails closed).
  // The deliveries recovery will read are read here too (r1-P1-6): pending and unknown ones.
  let db: DatabaseSync | undefined;
  let repositories: AppRepositories;
  let store: SqliteDeliveryStore;
  const damaged = (error: unknown): DamagedBackend => {
    const reason = describe(error);
    log(`[backend] the database cannot be used (${reason}); nothing is started`);
    try {
      db?.close();
    } catch {
      // Already unusable.
    }
    return { status: 'damaged', facade: damagedFacade(reason, options.dbPath), dbPath: options.dbPath, reason, shutdown: () => Promise.resolve() };
  };
  try {
    db = openDatabase(options.dbPath);
    repositories = createRepositories(db);
    store = new SqliteDeliveryStore(db);
    await repositories.readSnapshotData();
    await store.listByState('pending');
    await store.listByState('unknown');
  } catch (error) {
    return damaged(error);
  }
  const host = options.createHost(repositories.processes);

  // 3. A crashed run's processes: only those whose PID and creation time both still match are ended.
  try {
    const live = await repositories.processes.listLive();
    const cleaned = await host.cleanupOrphans(live);
    for (const p of [...cleaned.ended, ...cleaned.gone]) await repositories.processes.markEnded(p.pid, p.startedAt, now());
    if (cleaned.ended.length > 0) log(`[backend] ended ${String(cleaned.ended.length)} process(es) left by an earlier run`);
  } catch (error) {
    log(`[backend] cleaning up earlier processes failed (${describe(error)})`);
  }

  // 4-5. MCP server, adapters, the session service. Handlers and hooks reach the service once it exists.
  const ref: { service?: SessionService; workflow?: WorkflowEngine } = {};
  const starting = { status: 'rejected', rejection: { reason: 'shutting-down', detail: 'the GUI is starting' } } as const;
  const handlers: McpToolHandlers = {
    handoff: (input, ctx) => ref.workflow?.handoff(input, ctx) ?? Promise.resolve(starting),
    create_tasks: (input, ctx) => ref.workflow?.createTasks(input, ctx) ?? Promise.resolve(starting),
    report_to_root: (input, ctx) => ref.workflow?.reportToRoot(input, ctx) ?? Promise.resolve(starting),
    // Same-folder locks (R-07): ordinary and workflow sessions alike.
    wait_for_file: (input, ctx) => ref.service?.waitForFile(input, ctx) ?? Promise.resolve(starting),
    send_message: (input, ctx) => {
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
  const createAdapter: AdapterFactory =
    options.createAdapter ??
    ((runtime, sessionId, hooks) => {
      if (runtime === 'claude') {
        return new ClaudeAdapter({
          sdk: claudeAgentSdk,
          onPermissionRequest: (handle) => hooks.onPermissionRequest(handle),
          spawnProcess: ({ sessionId: id }) => withUnpackedCommand(claudeProcessSpawn(host, id), options.packaged ?? NOT_PACKAGED),
          log: adapterLog('claude'),
        });
      }
      const command = options.codexExecutable;
      if (command === undefined) throw new Error('Codex is not available');
      return new CodexAdapter({
        spawn: codexAppServerSpawn(host, sessionId, { command }),
        endJob: () => host.closeJob(sessionId),
        onPermissionRequest: (handle) => hooks.onPermissionRequest(handle),
        log: adapterLog('codex'),
      });
    });
  const hooks = { onPermissionRequest: (handle: PermissionHandle) => (ref.service === undefined ? Promise.reject(new Error('not ready')) : ref.service.onPermissionRequest(handle)) };
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
        if (runtime === 'codex') {
          await adapter.close(2000).catch(() => undefined);
          await host.closeJob(probeId).catch(() => undefined);
        }
      }
    });

  const service = new SessionService({
    repositories,
    store,
    policy: options.policy ?? permissionPolicy,
    publish: (event) => {
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
    isRuntimeAvailable: (runtime) => runtime === 'claude' || options.codexExecutable !== undefined || options.createAdapter !== undefined,
    onSessionOpened: (sessionId) => {
      void repositories.sessions.get(sessionId).then((s) => s && watchers.start(sessionId, s.folderScope.workspaceRoot));
    },
    onSessionClosed: async (sessionId) => {
      watchers.stop(sessionId);
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
  // T036: idle runtimes closed while the app runs (never after it, D-03); the next delivery resumes them.
  const supervisor = new IdleSupervisor({
    sessions: service,
    now,
    idleMs: options.supervisor?.idleMs ?? SUPERVISOR_DEFAULTS.idleMs,
    maxOpen: options.supervisor?.maxOpen ?? SUPERVISOR_DEFAULTS.maxOpen,
    closeTimeoutMs,
    // A background command or a Codex Start-Process child would end with the session's Job (R-14).
    ownedCommands: async (sessionId) => (await host.listOwned(sessionId)).filter((p) => p.kind === 'command' && p.endedAt === undefined).length,
    log,
  });
  service.attachSupervisor(supervisor);

  // 6. Restart recovery (CR-2): unknown only reconciled, pending through the one dispatch entry. Stored data
  // it cannot read stops the start like damaged data does (r1-P1-6): no model probe, no runtime.
  try {
    const report = await service.start();
    if (report.failed.length > 0) log(`[backend] ${String(report.failed.length)} delivery(ies) could not be recovered`);
    // Each run's tasks rebuilt from its handoffs, the record of what was counted (T024).
    await workflow.recover();
    // Each confirmed transfer goes on from the step it stopped at; a cancelled one sends nothing (T023).
    await transfer.recover();
  } catch (error) {
    await service.shutdown(closeTimeoutMs).catch(() => undefined);
    await mcp.close().catch(() => undefined);
    const left: OwnedProcess[] = await host.listOwned().catch(() => []);
    for (const sessionId of new Set(left.map((p) => p.sessionId))) await host.closeJob(sessionId).catch(() => undefined);
    watchers.stopAll();
    ignored.close();
    return damaged(error);
  }

  // 7. Model lists, in the background: the window does not wait for them (R-12).
  let modelOptions: ModelOption[] = [];
  for (const runtime of ['claude', 'codex'] as const) {
    if (runtime === 'codex' && options.codexExecutable === undefined && options.createAdapter === undefined) continue;
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
  const facade: AppFacade = {
    async snapshot(): Promise<Snapshot> {
      // The seq first: anything published after it is applied again by the renderer, never skipped.
      const seq = bus.seq;
      const data = await repositories.readSnapshotData();
      return {
        schemaVersion: CONTRACTS_VERSION,
        app: { status: 'ready' },
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
        // Paging and backups (C-26, C-28) are wired in T040: every session's whole history for now.
        historyPages: [],
        storage: {},
      };
    },
    async execute(command: Command): Promise<CommandResult> {
      if (closing !== undefined) return failure(command.requestId, 'runtime_unavailable', 'The application is closing');
      try {
        return await service.execute(command);
      } catch (error) {
        log(`[backend] ${command.type} failed (${describe(error)})`);
        const storage = error instanceof Error && (error.name === 'StoredDataError' || error.name === 'InvalidRecordError');
        return failure(command.requestId, storage ? 'storage_failed' : 'internal_error', storage ? 'The stored data could not be read or written' : 'The command failed', {
          mayHaveSideEffects: true,
        });
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
      const left: OwnedProcess[] = await host.listOwned().catch(() => []);
      for (const sessionId of new Set(left.map((p) => p.sessionId))) await host.closeJob(sessionId).catch(() => undefined);
      watchers.stopAll();
      ignored.close();
      db.close();
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
