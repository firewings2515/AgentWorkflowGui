// Codex runtime adapter (T003, aligned with the runtime port in T006): owns one `codex app-server` stdio
// child (D-03) and turns its threads, turns, items and approval requests into contracts types. Several
// GUI sessions may share one app-server; every thread is bound to the GUI session it belongs to.
//
// Not here on purpose: retries of any kind (CR-2), the R-08 escalation decision (policy module), the
// supervisor's idle shutdown, and killing command processes after an interrupt (CR-7).
import { randomUUID } from 'node:crypto';
import {
  ItemId,
  type Message,
  MessageId,
  type ModelOption,
  type ModelSelection,
  type NativeTask,
  NativeTaskId,
  type ObservedModel,
  PermissionDecision,
  PermissionRequest,
  PermissionRequestId,
  type SessionId,
  type SessionItem,
  type Timestamp,
  type Turn,
  TurnId,
} from '../../contracts';
import type {
  DispatchRequest,
  DispatchResult,
  HistoryEntry,
  HistoryRequest,
  HistoryResult,
  ModelChangeTiming,
  NativeSessionInfo,
  PermissionHandle,
  ReconcileMatch,
  ReconcileProvisionResult,
  ReconcileRequest,
  ReconcileResult,
  ResumeSessionOptions,
  RuntimeAdapter,
  RuntimeAdapterHooks,
  RuntimeEvent,
  StartSessionOptions,
} from '../../core/ports';
import {
  closeOpenItem,
  isoFromMs,
  isoFromSeconds,
  opt,
  type Placement,
  toAgentMessage,
  toCommandItem,
  toFileChangeItem,
  toModelOption,
  toTokenUsage,
  toToolCallItem,
  toTurn,
  toUserMessage,
} from './mapping';
import { buildPermissionRequest, decisionToWire, type PermissionKind, permissionKindOf, refusalToWire } from './permissions';
import {
  ISOLATION_CONFIG,
  type JsonValue,
  type RpcId,
  type SandboxMode,
  THREAD_POLICY,
  type WireItem,
  type WireModel,
  type WirePage,
  type WireRateLimitWindow,
  type WireThread,
  type WireThreadItemEntry,
  type WireThreadStartResponse,
  type WireTokenUsage,
  type WireTurn,
} from './protocol';
import { type AppServerProcess, type ExitInfo, RpcClosedError, RpcConnection, RpcError, RpcTimeoutError, type SpawnOptions, spawnAppServer } from './rpc';

// ---- public types ---------------------------------------------------------------------------------

/** Events this adapter emits are the port's events; kept under its T003 name for existing imports. */
export type CodexAdapterEvent = RuntimeEvent;

export interface CodexAdapterOptions extends RuntimeAdapterHooks {
  /**
   * Replaces the default spawn: the GUI starts the app-server inside the session's Job (T013,
   * adapters/process), tests plug in a fake app-server. One adapter, and so one app-server, serves one
   * GUI session (CR-7).
   */
  spawn?: () => AppServerProcess;
  /**
   * Ends the session's Job (ProcessHost.closeJob) when the app-server does not exit after its stdin
   * closed; without it only the app-server process is killed (R-14).
   */
  endJob?: () => Promise<unknown>;
  /**
   * After an interrupt, end the thread's command processes with thread/backgroundTerminals/terminate
   * (CR-7, default true). Off only for replays recorded before the call existed.
   */
  terminateCommandsOnInterrupt?: boolean;
  spawnOptions?: SpawnOptions;
  clientInfo?: { name: string; title: string; version: string };
  /**
   * Origin of user messages seen in the thread. Peer and handoff messages arrive as plain user input in
   * Codex; the layer above knows them by the clientMessageId it dispatched. Defaults to `user`.
   */
  userOrigin?: (info: { sessionId: SessionId; clientMessageId: string | null }) => Message['origin'];
  now?: () => Date;
  newId?: () => string;
  /** Command output is kept to this many trailing characters (default 64 KiB). */
  maxOutputChars?: number;
  /** Deadline for ordinary requests (default 60 s). */
  requestTimeoutMs?: number;
  /** Deadline for a dispatch before its outcome is reported unknown (default 30 s). */
  dispatchTimeoutMs?: number;
  log?: (level: 'debug' | 'warn', message: string, detail?: unknown) => void;
}

export interface CodexThreadInfo {
  threadId: string;
  sessionId?: SessionId;
  cwd: string;
  /** Codex only reports the configured model, never the one a turn actually used (R-12). */
  configuredModel: ObservedModel;
  reasoningEffort: string | null;
  parentThreadId: string | null;
  ephemeral: boolean;
  status: string;
  /** Rollout file; stored with the thread ID as the native ref (SP-01 §6). */
  rolloutPath: string | null;
}

export interface ThreadSettings {
  /** R-08 default is `workspace-write`; read-only nodes use `read-only`. Full access is never offered. */
  sandbox?: Extract<SandboxMode, 'workspace-write' | 'read-only'>;
  model?: string;
  developerInstructions?: string;
  baseInstructions?: string;
  /** Extra per-thread config (e.g. the GUI MCP server). The SP-04 isolation keys always win. */
  config?: Record<string, JsonValue>;
}

export interface StartThreadOptions extends ThreadSettings {
  sessionId: SessionId;
  cwd: string;
}

export interface ResumeThreadOptions extends ThreadSettings {
  sessionId: SessionId;
  threadId: string;
  cwd?: string;
}

export interface TurnInput {
  threadId: string;
  text: string;
  /** Codex sets the model per turn; it sticks for later turns (R-12). */
  model?: string;
  effort?: string;
  clientUserMessageId?: string;
}

export interface ServerInfo {
  userAgent: string;
  codexHome: string | null;
  platformOs: string | null;
}

/** Codex thread on our side: which GUI session it belongs to, and the native task when it is a sub-agent. */
interface ThreadBinding {
  sessionId: SessionId;
  nativeTaskId?: NativeTaskId;
  /** Model asked for by a turn/start whose turn has not been announced yet. */
  nextTurnModel?: ModelSelection;
  /** Chosen with setModel or at session start but not sent yet: the next turn/start carries it (R-12). */
  pendingModel?: ModelSelection;
  /** Bumped whenever pendingModel is set or cleared, so a reply only clears what its own request used. */
  pendingVersion?: number;
  /** The turn this thread is running, from turn/started until turn/completed. */
  activeTurnId?: string;
}

/** An item as stored in a thread's history, with the times the API gave (all optional). */
interface StoredItem {
  turnId: string;
  item: WireItem;
  startedAtMs: number | null;
  completedAtMs: number | null;
}

/** Everything `thread/*` could tell about a thread's history; `turns` is absent when only items were read. */
interface StoredHistory {
  items: StoredItem[];
  turns?: WireTurn[];
  /** False when some turns were summarised or not loaded, so their items are missing. */
  full: boolean;
}

interface TrackedItem {
  threadId: string;
  turnId: string;
  placement: Placement;
  wire: WireItem;
  startedAt: Timestamp;
  output: string;
  truncated: boolean;
  last?: SessionItem;
}

interface PermissionEntry {
  rpcId: RpcId;
  threadId: string;
  nativeTurnId: string | null;
  kind: PermissionKind;
  /** For `permissions` requests: exactly the scope shown in `request`, granted on approval. */
  grant?: JsonValue;
  request: PermissionRequest;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v !== '';
const isThenable = (v: unknown): v is PromiseLike<unknown> => (typeof v === 'object' || typeof v === 'function') && v !== null && typeof (v as { then?: unknown }).then === 'function';

/**
 * Enough structure to trust an item for reconciliation: every item has a type and an id, and a user
 * message has its content array and a clientId that is a string or null.
 */
const isWireItem = (v: unknown): v is WireItem =>
  isObject(v) &&
  isNonEmptyString(v.type) &&
  isNonEmptyString(v.id) &&
  (v.type !== 'userMessage' || (Array.isArray(v.content) && (v.clientId === null || typeof v.clientId === 'string')));

/** The stored history could not be read completely; reconciliation must stay unknown. */
class IncompleteHistoryError extends Error {
  override name = 'IncompleteHistoryError';
}

const rpcKey = (id: RpcId) => `${typeof id}:${id}`;
const WEEK_MINUTES = 7 * 24 * 60;
const MAX_HISTORY_PAGES = 10_000;

export class CodexAdapter implements RuntimeAdapter {
  readonly runtime = 'codex' as const;
  private conn: RpcConnection | undefined;
  private closing = false;
  /** The one GUI session this app-server serves (CR-7); set by its first thread. */
  private owner: SessionId | undefined;
  private info: ServerInfo | undefined;
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly threads = new Map<string, ThreadBinding>();
  private readonly turnModels = new Map<string, ModelSelection>();
  private readonly items = new Map<string, TrackedItem>();
  private readonly nativeTasks = new Map<string, NativeTask>();
  /** State implied by each child thread's latest turn (running while a turn is open), seen live or read from history. */
  private readonly childTurnStates = new Map<string, NativeTask['state']>();
  /** Children whose turn state came from live events: only these are trusted without reading the child again. */
  private readonly liveChildTurns = new Set<string>();
  private readonly permissions = new Map<string, PermissionEntry>();
  private readonly dispatched = new Set<string>();
  private stderrTail = '';

  constructor(private readonly options: CodexAdapterOptions) {}

  // ---- lifecycle ----------------------------------------------------------------------------------

  get running(): boolean {
    return this.conn?.running ?? false;
  }

  /** Last stderr output of the app-server, for diagnostics. */
  get stderr(): string {
    return this.stderrTail;
  }

  /** What the app-server said about itself in `initialize`; empty until `start` returned. */
  get serverInfo(): ServerInfo | undefined {
    return this.info;
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Spawns the app-server and runs the `initialize` handshake. */
  async start(): Promise<void> {
    if (this.conn) throw new Error('CodexAdapter.start: already started');
    const proc = (this.options.spawn ?? (() => spawnAppServer(this.options.spawnOptions)))();
    this.conn = new RpcConnection(proc, {
      onNotification: (method, params) => this.guard(method, () => this.onNotification(method, params)),
      onServerRequest: (id, method, params) => this.guard(method, () => this.onServerRequest(id, method, params)),
      onExit: (exit) => this.onExit(exit),
      onStderr: (text) => (this.stderrTail = (this.stderrTail + text).slice(-8192)),
      onProtocolNoise: (detail, line) => this.log('debug', `protocol: ${detail}`, line.slice(0, 500)),
    });
    const result = await this.request('initialize', {
      clientInfo: this.options.clientInfo ?? { name: 'agent-workflow-gui', title: 'AgentWorkflowGui', version: '0.1.0' },
      // thread/backgroundTerminals/* is experimental (CR-7, spike review-followup §1).
      capabilities: { experimentalApi: true },
    });
    this.conn.notify('initialized');
    const r = isObject(result) ? result : {};
    this.info = {
      userAgent: typeof r.userAgent === 'string' ? r.userAgent : '',
      codexHome: typeof r.codexHome === 'string' ? r.codexHome : null,
      platformOs: typeof r.platformOs === 'string' ? r.platformOs : null,
    };
  }

  /**
   * Closes stdin and waits for the process to exit; Codex ends its command processes with it (SP-08).
   * Kills the process when it does not exit within `timeoutMs`.
   */
  async close(timeoutMs = 5000): Promise<ExitInfo & { forced: boolean }> {
    const conn = this.conn;
    if (!conn) return { code: null, signal: null, forced: false };
    if (!conn.running) return { ...conn.exit!, forced: false };
    this.closing = true;
    conn.closeInput();
    const timeout = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms).unref());
    const exit = await Promise.race([conn.exited, timeout(timeoutMs, undefined)]);
    if (exit) return { ...exit, forced: false };
    if (this.options.endJob) {
      await this.options.endJob().catch((error: unknown) => this.log('warn', 'ending the session Job failed; killing the app-server', error));
      if (conn.running) conn.kill();
    } else conn.kill();
    const killed = await Promise.race([conn.exited, timeout(2000, { code: null, signal: null, error: 'did not exit after kill' })]);
    return { ...killed, forced: true };
  }

  // ---- sessions (runtime port) --------------------------------------------------------------------

  /**
   * Port entry for a new session: a Codex thread. `preallocatedRef` is ignored, Codex picks the thread ID
   * itself (CR2_DELIVERY_FIX §3). The model's effort cannot be set on the thread, so it rides on the
   * first turn/start.
   */
  async startSession(options: StartSessionOptions): Promise<NativeSessionInfo> {
    this.claim(options.sessionId);
    if (!this.conn) await this.start();
    const model = this.codexSelection(options.model);
    const info = await this.startThread({ sessionId: options.sessionId, cwd: options.cwd, ...this.settingsOf(options, model) });
    this.keepEffort(info.threadId, model);
    return { sessionId: options.sessionId, nativeSessionRef: info.threadId, cwd: info.cwd, model: info.configuredModel };
  }

  async resumeSession(options: ResumeSessionOptions): Promise<NativeSessionInfo> {
    this.claim(options.sessionId);
    // After closeSession the app-server is gone; resuming starts a new one in the session's Job.
    if (!this.conn) await this.start();
    const model = this.codexSelection(options.model);
    const info = await this.resumeThread({ sessionId: options.sessionId, threadId: options.nativeSessionRef, cwd: options.cwd, ...this.settingsOf(options, model) });
    this.keepEffort(info.threadId, model);
    return { sessionId: options.sessionId, nativeSessionRef: info.threadId, cwd: info.cwd, model: info.configuredModel };
  }

  /**
   * R-14: this adapter's app-server serves exactly this GUI session (CR-7), so closing the session closes
   * the app-server: stdin first, and when it does not exit within `timeoutMs` the session's Job ends
   * (`endJob`). Other sessions run their own app-servers and are not touched.
   */
  async closeSession(nativeSessionRef: string, timeoutMs = 5000): Promise<{ forced: boolean }> {
    const binding = this.binding(nativeSessionRef);
    if (binding.nativeTaskId !== undefined) throw new Error(`thread ${nativeSessionRef} is a native task; close its session's thread instead`);
    const { forced } = await this.close(timeoutMs);
    // Forget the exited process and what it had loaded, so resumeSession can start a fresh one.
    this.conn = undefined;
    this.closing = false;
    this.threads.clear();
    return { forced };
  }

  /** Codex picks the thread ID only in the thread/start response, so a lost create cannot be looked up (C-08). */
  reconcileProvision(): Promise<ReconcileProvisionResult> {
    return Promise.resolve({ state: 'unknown', reason: 'unsupported', detail: 'Codex has no thread ID before thread/start' });
  }

  /** Codex has no call to change a thread's model; it is sent with the next turn/start (R-12). */
  setModel(nativeSessionRef: string, model: ModelSelection): Promise<ModelChangeTiming> {
    try {
      this.setPending(this.binding(nativeSessionRef), this.codexSelection(model));
      return Promise.resolve('next-turn');
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Interrupts the thread's running turn (nothing to do when it has none), then ends the thread's command
   * processes, which turn/interrupt leaves running (SP-08, CR-7).
   */
  async interrupt(nativeSessionRef: string): Promise<void> {
    await this.interruptRunning(nativeSessionRef);
    if (this.options.terminateCommandsOnInterrupt !== false) await this.terminateCommands(nativeSessionRef);
  }

  /** `nativeTaskRef` is the child thread ID (`NativeTask.nativeRef`); only children of this session's thread qualify (R-13). */
  async stopNativeTask(nativeSessionRef: string, nativeTaskRef: string): Promise<void> {
    const parent = this.binding(nativeSessionRef);
    let child = this.threads.get(nativeTaskRef);
    if (!child) {
      // After a restart the child is only known from the parent's stored activity (R-13: seen means stoppable).
      await this.restoreChildren(parent.sessionId, nativeSessionRef, parent.nativeTaskId, (await this.readWholeHistory(nativeSessionRef, { requireFull: false })).items);
      child = this.threads.get(nativeTaskRef);
    }
    if (!child || child.nativeTaskId === undefined || child.sessionId !== parent.sessionId) {
      throw new Error(`thread ${nativeTaskRef} is not a native task of the session bound to ${nativeSessionRef}`);
    }
    await this.interruptRunning(nativeTaskRef);
  }

  // ---- threads ------------------------------------------------------------------------------------

  /**
   * `thread/start` with the R-08 policy and SP-04 isolation. Carries no work payload: creating the target
   * and delivering to it are separate operations (CR2_DELIVERY_FIX §3). If this rejects with a timeout or
   * closed connection the thread may exist anyway; the caller must not blindly start another.
   */
  async startThread(options: StartThreadOptions): Promise<CodexThreadInfo> {
    this.claim(options.sessionId);
    const response = await this.request('thread/start', { cwd: options.cwd, ...this.threadParams(options) });
    const info = this.bindFromResponse(options.sessionId, response, 'thread/start');
    this.owner = options.sessionId;
    return info;
  }

  /** `thread/resume` without loading the full history (read its history with readHistory). */
  async resumeThread(options: ResumeThreadOptions): Promise<CodexThreadInfo> {
    this.claim(options.sessionId);
    const existing = this.threads.get(options.threadId);
    if (existing && existing.sessionId !== options.sessionId) throw new Error(`thread/resume: thread ${options.threadId} is already bound to another session`);
    // Bound before the request: a running thread's events and approvals can arrive right behind the response.
    if (!existing) this.threads.set(options.threadId, { sessionId: options.sessionId });
    try {
      const response = await this.request('thread/resume', {
        threadId: options.threadId,
        ...opt('cwd', options.cwd),
        ...this.threadParams(options),
        excludeTurns: true,
      });
      const info = this.bindFromResponse(options.sessionId, response, 'thread/resume');
      this.owner = options.sessionId;
      return info;
    } catch (error) {
      if (!existing) this.threads.delete(options.threadId);
      throw error;
    }
  }

  /** Reads a stored thread without resuming it. `turns` is filled only with `includeTurns`. */
  async readThread(threadId: string, options: { sessionId?: SessionId; includeTurns?: boolean } = {}): Promise<CodexThreadInfo & { turns: Turn[] }> {
    const response = await this.request('thread/read', { threadId, includeTurns: options.includeTurns === true });
    const thread = isObject(response) ? (response.thread as WireThread | undefined) : undefined;
    if (!thread || typeof thread.id !== 'string') throw new Error('thread/read: malformed response');
    const sessionId = options.sessionId ?? this.threads.get(threadId)?.sessionId;
    const turns = sessionId === undefined ? [] : (thread.turns ?? []).map((t) => toTurn(sessionId, t, { now: this.now(), requestedModel: this.turnModels.get(t.id) }));
    return { ...this.threadInfo(thread, thread.model, sessionId), turns };
  }

  /** Threads this app-server has loaded, including native sub-agent threads (SP-03). */
  async listLoadedThreads(): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
      const res = (await this.request('thread/loaded/list', { ...opt('cursor', cursor) })) as WirePage<unknown>;
      ids.push(...(res?.data ?? []).filter((id): id is string => typeof id === 'string'));
      cursor = res?.nextCursor ?? null;
      if (cursor === null) return ids;
    }
    throw new Error('thread/loaded/list: too many pages');
  }

  /** `model/list` with hidden models included (the picker hides them by default, R-12). */
  async listModels(): Promise<ModelOption[]> {
    const options: ModelOption[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
      const res = (await this.request('model/list', { includeHidden: true, ...opt('cursor', cursor) })) as WirePage<WireModel>;
      for (const m of res?.data ?? []) if (isObject(m) && typeof m.id === 'string') options.push(toModelOption(m));
      cursor = res?.nextCursor ?? null;
      if (cursor === null) return options;
    }
    throw new Error('model/list: too many pages');
  }

  // ---- turns --------------------------------------------------------------------------------------

  /** `turn/start`. Plain sends go here; payloads with a delivery record go through `dispatchOnce`. */
  async startTurn(input: TurnInput): Promise<Turn> {
    const binding = this.binding(input.threadId);
    const response = await this.sendTurnStart(binding, input, this.options.requestTimeoutMs ?? 60_000);
    const turn = isObject(response) ? (response.turn as WireTurn | undefined) : undefined;
    if (!turn || typeof turn.id !== 'string') throw new Error('turn/start: malformed response');
    return toTurn(binding.sessionId, turn, { now: this.now(), requestedModel: this.turnModels.get(turn.id) });
  }

  /** `turn/steer`: adds input to the running turn. Codex cannot change the model here (R-12). */
  async steerTurn(input: { threadId: string; expectedTurnId: string; text: string; clientUserMessageId?: string }): Promise<{ turnId: string }> {
    this.binding(input.threadId);
    const response = await this.request('turn/steer', {
      threadId: input.threadId,
      expectedTurnId: input.expectedTurnId,
      input: [{ type: 'text', text: input.text, text_elements: [] }],
      ...opt('clientUserMessageId', input.clientUserMessageId),
    });
    const turnId = isObject(response) ? response.turnId : undefined;
    if (typeof turnId !== 'string') throw new Error('turn/steer: malformed response');
    return { turnId };
  }

  /**
   * `turn/interrupt`. The turn ends as interrupted within ~0.2 s, but Codex leaves the command processes
   * running (SP-08); ending them is CR-7 and not done here.
   */
  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request('turn/interrupt', { threadId, turnId });
  }

  // ---- delivery (CR-2) ----------------------------------------------------------------------------

  /**
   * Sends one committed attempt exactly once: a new turn with `clientUserMessageId`, or an insert into
   * the running turn with `turn/steer`. Returns `sent` only for the runtime's response to this request.
   * Never retries; a second call with the same attempt is refused without touching the runtime.
   */
  async dispatchOnce(req: DispatchRequest): Promise<DispatchResult> {
    const { attempt } = req;
    if (attempt.state !== 'unknown' || attempt.resolution?.decision === 'retry') {
      throw new Error('dispatchOnce: the attempt must be the live attempt committed as unknown');
    }
    const keys = [`attempt:${attempt.attemptId}`, `client:${attempt.clientMessageId}`];
    if (keys.some((k) => this.dispatched.has(k))) {
      return { state: 'unknown', reason: 'already-dispatched', written: false, detail: 'this attempt was already handed to the runtime by this adapter' };
    }
    if (!this.running) return { state: 'unknown', reason: 'not-running', written: false, detail: 'app-server is not running' };
    const threadId = req.nativeSessionRef;
    const binding = this.threads.get(threadId);
    if (!binding) throw new Error(`dispatchOnce: thread ${threadId} is not bound to a session`);
    // Everything that can still be refused locally is settled before the attempt counts as handed over.
    const entry = req.entry;
    const model = entry.kind === 'new-turn' && entry.model ? this.codexSelection(entry.model) : undefined;
    const expectedTurnId = entry.kind === 'insert' ? (entry.expectedTurnRef ?? binding.activeTurnId) : undefined;
    if (entry.kind === 'insert' && expectedTurnId === undefined) {
      return { state: 'unknown', reason: 'rejected', written: false, detail: 'no running turn is known to insert into; nothing was sent' };
    }
    for (const k of keys) this.dispatched.add(k);

    const timeoutMs = req.timeoutMs ?? this.options.dispatchTimeoutMs ?? 30_000;
    const method = entry.kind === 'new-turn' ? 'turn/start' : 'turn/steer';
    try {
      const response =
        entry.kind === 'new-turn'
          ? await this.sendTurnStart(
              binding,
              { threadId, text: req.text, clientUserMessageId: attempt.clientMessageId, ...opt('model', model?.model), ...opt('effort', model?.effort) },
              timeoutMs,
            )
          : await this.request(
              'turn/steer',
              {
                threadId,
                expectedTurnId,
                input: [{ type: 'text', text: req.text, text_elements: [] }],
                clientUserMessageId: attempt.clientMessageId,
              },
              timeoutMs,
            );
      const turnId = entry.kind === 'new-turn' ? (isObject(response) && isObject(response.turn) ? response.turn.id : undefined) : isObject(response) ? response.turnId : undefined;
      if (typeof turnId !== 'string' || turnId === '') {
        return { state: 'unknown', reason: 'malformed-response', written: true, detail: `${method} answered without a turn id` };
      }
      return {
        state: 'sent',
        nativeRef: { sessionRef: threadId, turnRef: turnId },
        evidence: { kind: 'live-ack', at: this.now(), detail: `${method} accepted clientUserMessageId ${attempt.clientMessageId} as turn ${turnId}` },
      };
    } catch (error) {
      if (error instanceof RpcTimeoutError) return { state: 'unknown', reason: 'timeout', written: true, detail: error.message };
      if (error instanceof RpcClosedError) return { state: 'unknown', reason: error.written ? 'disconnected' : 'not-running', written: error.written, detail: error.message };
      // An explicit error most likely means nothing was accepted, but it is not proof (CR-2): stays unknown.
      if (error instanceof RpcError) return { state: 'unknown', reason: 'rejected', written: true, detail: error.message };
      throw error;
    }
  }

  /**
   * Read-only reconciliation of an unknown attempt (CR2_DELIVERY_FIX §2): pages the whole stored history
   * of the thread for a user message with this clientMessageId and the same text. Never resumes the
   * thread or starts a turn. Not finding it is not proof of non-delivery; two hits are a suspected
   * duplicate.
   */
  async reconcile(req: ReconcileRequest): Promise<ReconcileResult> {
    if (!this.running) return { state: 'unknown', reason: 'not-running', matches: [], detail: 'app-server is not running' };
    const threadId = req.nativeSessionRef;
    let stored: StoredHistory;
    try {
      stored = await this.readWholeHistory(threadId, { requireFull: true });
    } catch (error) {
      return { state: 'unknown', reason: 'read-failed', matches: [], detail: error instanceof Error ? error.message : String(error) };
    }
    const matches: ReconcileMatch[] = stored.items
      .filter((e): e is StoredItem & { item: Extract<WireItem, { type: 'userMessage' }> } => e.item.type === 'userMessage' && e.item.clientId === req.clientMessageId)
      .map((e) => ({ turnRef: e.turnId, itemRef: e.item.id, contentMatches: sameText(e.item.content, req.text) }));
    if (matches.length === 0) {
      return { state: 'unknown', reason: 'not-found', matches, detail: `no user message with clientId ${req.clientMessageId} in ${stored.items.length} stored items` };
    }
    if (matches.length > 1) return { state: 'unknown', reason: 'duplicate', matches, detail: `${matches.length} user messages carry clientId ${req.clientMessageId}` };
    const [match] = matches as [ReconcileMatch];
    if (!match.contentMatches) return { state: 'unknown', reason: 'content-mismatch', matches, detail: 'the stored message with this clientId has different content' };
    return {
      state: 'sent',
      nativeRef: { sessionRef: threadId, turnRef: match.turnRef, itemRef: match.itemRef },
      evidence: { kind: 'reconciled', at: this.now(), detail: `stored userMessage ${match.itemRef} in turn ${match.turnRef} has clientId ${req.clientMessageId} and the same text` },
    };
  }

  // ---- history (read-only) ------------------------------------------------------------------------

  /**
   * The stored history of a session thread, or of one native sub-agent's thread, mapped to contracts
   * types and ordered oldest first: each turn, then its messages and items. Reads only (`thread/turns/list`,
   * `thread/items/list`, falling back to `thread/read`); never resumes a thread or starts a turn.
   * `complete` is false when part of the history could not be read or a native task's state is a guess.
   */
  async readHistory(req: HistoryRequest): Promise<HistoryResult> {
    const threadId = req.nativeTask?.nativeRef ?? req.nativeSessionRef;
    const nativeTaskId = req.nativeTask?.nativeTaskId;
    const stored = await this.readWholeHistory(threadId, { requireFull: false });
    let complete = stored.full;
    let turns = stored.turns;
    if (turns === undefined) {
      try {
        turns = await this.readAllTurns(threadId);
      } catch (error) {
        if (!(error instanceof RpcError) && !(error instanceof IncompleteHistoryError)) throw error;
        this.log('warn', 'thread/turns/list failed; history has no turn entries', error.message);
        complete = false;
      }
    }
    const turnState = new Map<string, Turn>();
    const entries: HistoryEntry[] = [];
    const itemsByTurn = new Map<string, StoredItem[]>();
    for (const e of stored.items) itemsByTurn.set(e.turnId, [...(itemsByTurn.get(e.turnId) ?? []), e]);
    const emitTurnItems = (turnId: string) => {
      for (const e of itemsByTurn.get(turnId) ?? []) entries.push(...this.storedEntries(req.sessionId, nativeTaskId, e, turnState.get(turnId)));
      itemsByTurn.delete(turnId);
    };
    for (const wire of turns ?? []) {
      const turn = toTurn(req.sessionId, wire, { now: this.now(), requestedModel: this.turnModels.get(wire.id), nativeTaskId });
      turnState.set(wire.id, turn);
      entries.push({ kind: 'turn', turn });
      emitTurnItems(wire.id);
    }
    // Items of turns the turn list did not show (or all items when it could not be read), in stored order.
    if (turns !== undefined && itemsByTurn.size > 0) complete = false;
    for (const turnId of [...itemsByTurn.keys()]) emitTurnItems(turnId);

    const found = await this.restoreChildren(req.sessionId, threadId, nativeTaskId, stored.items);
    return { entries, nativeTasks: found.tasks, complete: complete && found.exact };
  }

  /** Messages and session items of one stored item; open items end with their turn (SP-08). */
  private storedEntries(sessionId: SessionId, nativeTaskId: NativeTaskId | undefined, e: StoredItem, turn: Turn | undefined): HistoryEntry[] {
    const placement: Placement = nativeTaskId === undefined ? { sessionId, turnId: e.turnId } : { sessionId, nativeTaskId };
    // Stored items are finished; history may lack timestamps, so fall back to the turn or the read time.
    const startedAt = typeof e.startedAtMs === 'number' ? isoFromMs(e.startedAtMs) : (turn?.startedAt ?? this.now());
    const endedAt = typeof e.completedAtMs === 'number' ? isoFromMs(e.completedAtMs) : startedAt;
    const out: HistoryEntry[] = [];
    const message = this.messageOf(placement, e.item, endedAt);
    if (message) out.push({ kind: 'message', message });
    const output = e.item.type === 'commandExecution' ? clipOutput(e.item.aggregatedOutput ?? '', this.maxOutputChars()) : { output: '', truncated: false };
    let item = this.sessionItemOf(placement, e.item, { startedAt, endedAt }, output);
    const closeAs = item && turn && turn.state !== 'running' ? closeOpenItem(item, turn.state) : undefined;
    // A wire item still in progress was mapped as open with an end time; close it with its turn instead.
    if (closeAs) item = this.sessionItemOf(placement, e.item, { startedAt, endedAt: turn?.endedAt ?? endedAt }, output, closeAs);
    if (item) out.push({ kind: 'item', item });
    return out;
  }

  /**
   * Native tasks the thread's stored activity mentions (R-13). As live (T003 review r2), the child's own
   * turns decide a task's state; the parent's `completed` / `interrupted` activity counts only when the
   * child was read and has no turn at all. `exact` is false when the state is not established, and
   * `fromTurn` names the tasks whose state comes from a child turn.
   */
  private async nativeTasksIn(
    sessionId: SessionId,
    parentThreadId: string,
    parentTaskId: NativeTaskId | undefined,
    items: StoredItem[],
  ): Promise<{ tasks: NativeTask[]; exact: boolean; fromTurn: Set<string> }> {
    const seen = new Map<string, { label: string; kind: string; startedAt: Timestamp; last: Timestamp }>();
    for (const e of items) {
      const wire = e.item;
      if (wire.type !== 'subAgentActivity' || !isNonEmptyString(wire.agentThreadId)) continue;
      const at = typeof e.completedAtMs === 'number' ? isoFromMs(e.completedAtMs) : typeof e.startedAtMs === 'number' ? isoFromMs(e.startedAtMs) : this.now();
      const previous = seen.get(wire.agentThreadId);
      seen.set(wire.agentThreadId, {
        label: previous?.label ?? (isNonEmptyString(wire.agentPath) ? wire.agentPath : wire.agentThreadId),
        kind: wire.kind,
        startedAt: previous?.startedAt ?? at,
        last: at,
      });
    }
    const tasks: NativeTask[] = [];
    const fromTurn = new Set<string>();
    let exact = true;
    for (const [child, activity] of seen) {
      const resolved = await this.childState(child, activity.kind, activity.last);
      if (!resolved.exact) exact = false;
      if (resolved.fromTurn) fromTurn.add(child);
      tasks.push({
        id: NativeTaskId.parse(child),
        sessionId,
        runtime: 'codex',
        parentRef: parentThreadId,
        nativeRef: child,
        ...opt('parentTaskId', parentTaskId),
        label: activity.label,
        state: resolved.state,
        background: false,
        lastActivity: resolved.lastActivity ?? activity.kind,
        startedAt: activity.startedAt,
        ...(resolved.state !== 'running' && { endedAt: resolved.endedAt ?? activity.last }),
      });
    }
    return { tasks, exact, fromTurn };
  }

  /**
   * A child's state from the best evidence there is: a turn seen live, else its newest stored turn (a
   * turn still in progress means running, whatever the parent said). The parent's end report is used
   * only when the child was read and has no turn at all; a child that cannot be read stays running and
   * unconfirmed rather than being given an end it was not shown to have.
   */
  private async childState(
    child: string,
    parentKind: string,
    parentAt: Timestamp,
  ): Promise<{ state: NativeTask['state']; lastActivity?: string | undefined; endedAt?: Timestamp | undefined; exact: boolean; fromTurn: boolean }> {
    const live = this.liveChildTurns.has(child) ? this.childTurnStates.get(child) : undefined;
    if (live !== undefined) {
      const task = this.nativeTasks.get(child);
      return { state: live, lastActivity: task?.lastActivity, endedAt: task?.endedAt, exact: true, fromTurn: true };
    }
    const parentEnded = parentKind === 'completed' || parentKind === 'interrupted';
    const last = await this.lastTurn(child);
    if (last.kind === 'unreadable') return { state: 'running', exact: false, fromTurn: false };
    if (last.kind === 'turn') {
      const { status, completedAt } = last.turn;
      if (status === 'inProgress') return { state: 'running', lastActivity: 'turn inProgress', exact: !parentEnded, fromTurn: true };
      const state = status === 'completed' ? 'completed' : status === 'interrupted' ? 'stopped' : 'failed';
      return { state, lastActivity: `turn ${status}`, endedAt: typeof completedAt === 'number' ? isoFromSeconds(completedAt) : parentAt, exact: true, fromTurn: true };
    }
    if (parentEnded) return { state: parentKind === 'completed' ? 'completed' : 'stopped', endedAt: parentAt, exact: true, fromTurn: false };
    return { state: 'running', exact: false, fromTurn: false };
  }

  /** A stored child thread's newest turn: read and found, read and empty, or not readable at all. */
  private async lastTurn(child: string): Promise<{ kind: 'turn'; turn: WireTurn } | { kind: 'none' } | { kind: 'unreadable' }> {
    let page: unknown;
    try {
      page = await this.request('thread/turns/list', { threadId: child, limit: 1, sortDirection: 'desc' });
    } catch (error) {
      if (!(error instanceof RpcError)) throw error;
      return { kind: 'unreadable' };
    }
    if (!isObject(page) || !Array.isArray(page.data)) return { kind: 'unreadable' };
    if (page.data.length === 0) return { kind: 'none' };
    const turn: unknown = page.data[0];
    const known = ['completed', 'interrupted', 'failed', 'inProgress'];
    return isObject(turn) && isNonEmptyString(turn.id) && typeof turn.status === 'string' && known.includes(turn.status) ? { kind: 'turn', turn: turn as unknown as WireTurn } : { kind: 'unreadable' };
  }

  /**
   * Takes over the native tasks that `items` (stored activity of `threadId`) show, for a thread bound to
   * `sessionId`: binds their threads to the session (so they can be stopped, R-13) and records their state
   * the way live events would have, so later events follow the T003 rules (a child turn ends or resumes a
   * task; a late spawn report cannot revive it). A thread or child bound elsewhere is left alone, and
   * what the adapter saw of a child's own turns live is kept. Otherwise a child turn read now replaces
   * older knowledge in both maps together, so the task and its turn state never disagree.
   */
  private async restoreChildren(sessionId: SessionId, threadId: string, parentTaskId: NativeTaskId | undefined, items: StoredItem[]) {
    this.adoptChildren(sessionId, threadId, items);
    const found = await this.nativeTasksIn(sessionId, threadId, parentTaskId, items);
    if (this.threads.get(threadId)?.sessionId === sessionId) {
      for (const task of found.tasks) {
        if (this.threads.get(task.nativeRef)?.sessionId !== sessionId || this.liveChildTurns.has(task.nativeRef)) continue;
        if (found.fromTurn.has(task.nativeRef)) {
          this.nativeTasks.set(task.nativeRef, task);
          this.childTurnStates.set(task.nativeRef, task.state);
        } else if (!this.nativeTasks.has(task.nativeRef)) {
          this.nativeTasks.set(task.nativeRef, task);
        }
      }
    }
    return found;
  }

  /** Binds the child threads that `items` name to the session; only for a thread already bound to it. */
  private adoptChildren(sessionId: SessionId, threadId: string, items: StoredItem[]): void {
    if (this.threads.get(threadId)?.sessionId !== sessionId) return;
    for (const { item } of items) {
      if (item.type !== 'subAgentActivity' || !isNonEmptyString(item.agentThreadId) || this.threads.has(item.agentThreadId)) continue;
      this.threads.set(item.agentThreadId, { sessionId, nativeTaskId: NativeTaskId.parse(item.agentThreadId) });
    }
  }

  // ---- permission requests ------------------------------------------------------------------------

  /** Requests that are still waiting for an answer (pending or held). */
  openPermissions(): PermissionRequest[] {
    return [...this.permissions.values()].map((p) => p.request);
  }

  // ---- internals: requests ------------------------------------------------------------------------

  private request(method: string, params: unknown, timeoutMs = this.options.requestTimeoutMs ?? 60_000): Promise<unknown> {
    if (!this.conn) return Promise.reject(new Error(`${method}: CodexAdapter not started`));
    return this.conn.request(method, params, { timeoutMs });
  }

  private threadParams(s: ThreadSettings) {
    return {
      ...opt('model', s.model),
      ...THREAD_POLICY,
      sandbox: s.sandbox ?? 'workspace-write',
      config: { ...s.config, ...ISOLATION_CONFIG },
      ...opt('developerInstructions', s.developerInstructions),
      ...opt('baseInstructions', s.baseInstructions),
    };
  }

  private bindFromResponse(sessionId: SessionId, response: unknown, method: string): CodexThreadInfo {
    const r = isObject(response) ? (response as Partial<WireThreadStartResponse>) : {};
    const thread = r.thread;
    if (!thread || typeof thread.id !== 'string') throw new Error(`${method}: malformed response`);
    const existing = this.threads.get(thread.id);
    if (existing && existing.sessionId !== sessionId) throw new Error(`${method}: thread ${thread.id} is already bound to another session`);
    this.threads.set(thread.id, existing ?? { sessionId });
    return this.threadInfo(thread, r.model ?? thread.model, sessionId, r.reasoningEffort);
  }

  private threadInfo(thread: WireThread, model: string | null | undefined, sessionId: SessionId | undefined, effort?: string | null): CodexThreadInfo {
    return {
      threadId: thread.id,
      ...opt('sessionId', sessionId),
      cwd: thread.cwd,
      configuredModel: model ? { source: 'configured', model, observedAt: this.now() } : { source: 'unknown' },
      reasoningEffort: effort ?? thread.reasoningEffort ?? null,
      parentThreadId: thread.parentThreadId ?? null,
      ephemeral: thread.ephemeral === true,
      status: isObject(thread.status) && typeof thread.status.type === 'string' ? thread.status.type : 'unknown',
      rolloutPath: thread.path ?? null,
    };
  }

  private async sendTurnStart(binding: ThreadBinding, input: TurnInput, timeoutMs: number): Promise<unknown> {
    // A model chosen earlier (setModel, session start) rides on the first turn that names none itself.
    const requested: ModelSelection | undefined = input.model
      ? { runtime: 'codex', model: input.model, ...opt('effort', input.effort) }
      : input.effort === undefined
        ? binding.pendingModel
        : undefined;
    const effort = input.effort ?? requested?.effort;
    const pendingVersion = binding.pendingVersion;
    // turn/started can arrive before the response (seen in SP-06), so remember the model for it.
    if (requested) binding.nextTurnModel = requested;
    const response = await this.request(
      'turn/start',
      {
        threadId: input.threadId,
        input: [{ type: 'text', text: input.text, text_elements: [] }],
        ...opt('clientUserMessageId', input.clientUserMessageId),
        ...opt('model', requested?.model),
        ...opt('effort', effort),
      },
      timeoutMs,
    ).finally(() => {
      if (binding.nextTurnModel === requested) delete binding.nextTurnModel;
    });
    if (requested && isObject(response) && isObject(response.turn) && typeof response.turn.id === 'string') {
      this.turnModels.set(response.turn.id, requested);
      // Only what this request knew about is spent; a setModel made while it was in flight stays for the next turn.
      if (binding.pendingVersion === pendingVersion) this.setPending(binding, undefined);
    }
    return response;
  }

  private setPending(binding: ThreadBinding, model: ModelSelection | undefined): void {
    if (model) binding.pendingModel = model;
    else delete binding.pendingModel;
    binding.pendingVersion = (binding.pendingVersion ?? 0) + 1;
  }

  private codexSelection(model: ModelSelection): ModelSelection {
    if (model.runtime !== 'codex') throw new Error(`the Codex adapter cannot use a ${model.runtime} model (${model.model})`);
    return model;
  }

  private settingsOf(options: { readOnly: boolean; instructions?: string | undefined }, model: ModelSelection): ThreadSettings {
    return {
      sandbox: options.readOnly ? 'read-only' : 'workspace-write',
      model: model.model,
      ...opt('developerInstructions', options.instructions === '' ? undefined : options.instructions),
    };
  }

  /** The thread is created or resumed with the model; its effort can only go with a turn, so it waits for the next one. */
  private keepEffort(threadId: string, model: ModelSelection): void {
    const binding = this.binding(threadId);
    this.setPending(binding, model.effort !== undefined ? model : undefined);
  }

  private async interruptRunning(threadId: string): Promise<void> {
    const binding = this.binding(threadId);
    const turnId = binding.activeTurnId ?? (await this.findRunningTurn(threadId));
    if (turnId !== undefined) await this.interruptTurn(threadId, turnId);
  }

  /**
   * Ends the thread's background terminals one by one with its own thread ID and the terminal's process
   * ID: a wrong thread ID cannot end another session's process, even with the same command and cwd (CR-7
   * live checks). A detached `Start-Process` child is not listed; the session's Job ends it on close.
   * Failures are logged, not thrown: the turn is already interrupted and closing the session still ends
   * everything.
   */
  private async terminateCommands(threadId: string): Promise<void> {
    const processIds: string[] = [];
    try {
      const seen = new Set<string>();
      let cursor: string | null = null;
      do {
        const page = (await this.request('thread/backgroundTerminals/list', { threadId, limit: 100, cursor })) as WirePage<{ processId?: unknown }> | undefined;
        for (const t of page?.data ?? []) if (isNonEmptyString(t.processId)) processIds.push(t.processId);
        cursor = page?.nextCursor ?? null;
        if (cursor !== null && seen.has(cursor)) break;
        if (cursor !== null) seen.add(cursor);
      } while (cursor !== null);
    } catch (error) {
      this.log('warn', `listing the background terminals of ${threadId} failed`, error);
      return;
    }
    for (const processId of processIds) {
      try {
        const result = await this.request('thread/backgroundTerminals/terminate', { threadId, processId });
        if (!isObject(result) || result.terminated !== true) this.log('debug', `terminal ${processId} of ${threadId} was not terminated`, result);
      } catch (error) {
        this.log('warn', `terminating terminal ${processId} of ${threadId} failed`, error);
      }
    }
  }

  /** For a turn we did not see start (e.g. it began before this adapter resumed the thread). */
  private async findRunningTurn(threadId: string): Promise<string | undefined> {
    const page = (await this.request('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc' })) as WirePage<WireTurn> | undefined;
    const newest = page?.data?.[0];
    return newest?.status === 'inProgress' && isNonEmptyString(newest.id) ? newest.id : undefined;
  }

  private maxOutputChars(): number {
    return this.options.maxOutputChars ?? 64 * 1024;
  }

  private async itemsPage(threadId: string, o: { turnId?: string; cursor?: string; limit?: number; sortDirection?: 'asc' | 'desc' }): Promise<WirePage<WireThreadItemEntry>> {
    const page = await this.request('thread/items/list', {
      threadId,
      ...opt('turnId', o.turnId),
      ...opt('cursor', o.cursor),
      ...opt('limit', o.limit),
      ...opt('sortDirection', o.sortDirection),
    });
    // Strict on purpose: a page we cannot fully read means the history is incomplete (CR-2 §2), so a
    // malformed entry or a missing / non-string cursor fails the read instead of being skipped.
    if (!isObject(page) || !Array.isArray(page.data)) throw new IncompleteHistoryError('thread/items/list: response has no data array');
    const bad = page.data.findIndex((e) => !isObject(e) || !isNonEmptyString(e.turnId) || !isWireItem(e.item));
    if (bad >= 0) throw new IncompleteHistoryError(`thread/items/list: entry ${bad} is malformed`);
    const { nextCursor } = page;
    if (nextCursor !== null && !isNonEmptyString(nextCursor)) throw new IncompleteHistoryError('thread/items/list: nextCursor is missing or not a string');
    return { data: page.data as WireThreadItemEntry[], nextCursor };
  }

  /** Every turn of the thread, oldest first, with the same strictness as the item pages. */
  private async readAllTurns(threadId: string): Promise<WireTurn[]> {
    const all: WireTurn[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
      const res = await this.request('thread/turns/list', { threadId, ...opt('cursor', cursor), limit: 200, sortDirection: 'asc' });
      if (!isObject(res) || !Array.isArray(res.data)) throw new IncompleteHistoryError('thread/turns/list: response has no data array');
      const bad = res.data.findIndex((t) => !isObject(t) || !isNonEmptyString(t.id) || typeof t.status !== 'string');
      if (bad >= 0) throw new IncompleteHistoryError(`thread/turns/list: entry ${bad} is malformed`);
      all.push(...(res.data as WireTurn[]));
      const { nextCursor } = res;
      if (nextCursor === null) return all;
      if (!isNonEmptyString(nextCursor)) throw new IncompleteHistoryError('thread/turns/list: nextCursor is missing or not a string');
      cursor = nextCursor;
    }
    throw new IncompleteHistoryError('thread/turns/list: history did not end');
  }

  /**
   * Every stored item of the thread. Pages `thread/items/list` to the end; if that API fails, falls back
   * to `thread/read` with full turns (the path SP CR-2 proved). Both are read-only. With `requireFull`
   * (reconciliation) it throws unless the history is shown to be complete; without it, turns that are
   * only summarised are reported through `full: false` and their items are missing.
   */
  private async readWholeHistory(threadId: string, o: { requireFull: boolean }): Promise<StoredHistory> {
    try {
      const items: StoredItem[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
        const res = await this.itemsPage(threadId, { ...opt('cursor', cursor), limit: 200, sortDirection: 'asc' });
        for (const e of res.data) {
          items.push({
            turnId: e.turnId,
            item: e.item,
            startedAtMs: typeof e.startedAtMs === 'number' ? e.startedAtMs : null,
            completedAtMs: typeof e.completedAtMs === 'number' ? e.completedAtMs : null,
          });
        }
        if (res.nextCursor === null) return { items, full: true };
        cursor = res.nextCursor;
      }
      throw new IncompleteHistoryError('thread/items/list: history did not end');
    } catch (error) {
      if (!(error instanceof RpcError)) throw error;
      this.log('warn', 'thread/items/list failed; reading full turns instead', error.message);
    }
    const res = await this.request('thread/read', { threadId, includeTurns: true });
    const thread = isObject(res) && isObject(res.thread) ? res.thread : undefined;
    if (!thread || !Array.isArray(thread.turns)) throw new IncompleteHistoryError('thread/read: response has no turns');
    const items: StoredItem[] = [];
    const turns: WireTurn[] = [];
    let full = true;
    for (const [i, turn] of thread.turns.entries()) {
      if (!isObject(turn) || !isNonEmptyString(turn.id)) throw new IncompleteHistoryError(`thread/read: turn ${i} is malformed`);
      turns.push(turn as unknown as WireTurn);
      // Only `full` turns carry every item; `summary` / `notLoaded` would hide messages.
      if (turn.itemsView !== 'full' || !Array.isArray(turn.items)) {
        if (o.requireFull) throw new IncompleteHistoryError(`thread/read: turn ${i} is not fully loaded`);
        full = false;
        continue;
      }
      for (const item of turn.items) {
        if (!isWireItem(item)) throw new IncompleteHistoryError(`thread/read: turn ${turn.id} has a malformed item`);
        items.push({ turnId: turn.id, item, startedAtMs: null, completedAtMs: null });
      }
    }
    return { items, turns, full };
  }

  // ---- internals: events --------------------------------------------------------------------------

  private onNotification(method: string, params: unknown): void {
    if (!isObject(params)) return;
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
    switch (method) {
      case 'turn/started':
      case 'turn/completed':
        return this.onTurn(method, threadId, params.turn as WireTurn | undefined);
      case 'item/started':
      case 'item/completed':
        return this.onItem(method, params);
      case 'item/agentMessage/delta':
        return this.onAgentDelta(params);
      case 'item/commandExecution/outputDelta':
        return this.onOutputDelta(params);
      case 'thread/tokenUsage/updated':
        return this.onTokenUsage(threadId, params);
      case 'account/rateLimits/updated':
        return this.onRateLimits(params.rateLimits);
      case 'model/rerouted':
        return this.onReroute(threadId, params);
      case 'serverRequest/resolved':
        if (typeof params.requestId === 'number' || typeof params.requestId === 'string') this.withdraw(this.permissions.get(rpcKey(params.requestId)));
        return;
      default:
        return;
    }
  }

  private onTurn(method: string, threadId: string | undefined, turn: WireTurn | undefined): void {
    const binding = threadId === undefined ? undefined : this.threads.get(threadId);
    if (!binding || !turn || typeof turn.id !== 'string') return;
    if (method === 'turn/started' && binding.nextTurnModel && !this.turnModels.has(turn.id)) {
      this.turnModels.set(turn.id, binding.nextTurnModel);
      delete binding.nextTurnModel;
    }
    const now = this.now();
    const mapped = toTurn(binding.sessionId, turn, { now, requestedModel: this.turnModels.get(turn.id), nativeTaskId: binding.nativeTaskId });
    if (method === 'turn/started') binding.activeTurnId = turn.id;
    if (method === 'turn/completed') {
      if (binding.activeTurnId === turn.id) delete binding.activeTurnId;
      const endedAt = mapped.endedAt ?? now;
      for (const [id, tracked] of this.items) {
        if (tracked.threadId !== threadId || tracked.turnId !== turn.id) continue;
        const closeAs = tracked.last && closeOpenItem(tracked.last, mapped.state);
        if (closeAs) this.emitItem(tracked, { endedAt, override: closeAs });
        this.items.delete(id);
      }
      for (const entry of [...this.permissions.values()]) {
        if (entry.threadId === threadId && entry.nativeTurnId === turn.id) this.withdraw(entry);
      }
      this.turnModels.delete(turn.id);
    }
    // A sub-agent's turns carry its nativeTaskId, so they are not the session's own turns (R-13); they
    // also decide its NativeTask state.
    this.emit({ type: 'turn.updated', turn: mapped });
    if (binding.nativeTaskId !== undefined) this.onChildTurn(threadId!, turn, method === 'turn/completed', mapped.endedAt ?? now);
  }

  private onItem(method: string, params: Record<string, unknown>): void {
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
    const turnId = typeof params.turnId === 'string' ? params.turnId : undefined;
    const item = params.item as WireItem | undefined;
    const binding = threadId === undefined ? undefined : this.threads.get(threadId);
    if (!binding || turnId === undefined || !isObject(item) || typeof item.id !== 'string' || typeof item.type !== 'string') return;
    const placement = this.placementFor(binding, turnId);
    const started = method === 'item/started';
    const atMs = started ? params.startedAtMs : params.completedAtMs;
    const at = typeof atMs === 'number' ? isoFromMs(atMs) : this.now();

    if (item.type === 'subAgentActivity') return this.onSubAgent(threadId!, binding, item, at);
    if (!started) {
      const message = this.messageOf(placement, item, at);
      if (message) return this.emit({ type: 'message.completed', message });
    }
    let tracked = this.items.get(item.id);
    if (!tracked) {
      if (!['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch'].includes(item.type)) return;
      tracked = { threadId: threadId!, turnId, placement, wire: item, startedAt: at, output: '', truncated: false };
      this.items.set(item.id, tracked);
    }
    tracked.wire = item;
    if (started) return this.emitItem(tracked, {});
    if (item.type === 'commandExecution' && typeof item.aggregatedOutput === 'string') this.setOutput(tracked, item.aggregatedOutput);
    this.emitItem(tracked, { endedAt: at });
    this.items.delete(item.id);
  }

  private emitItem(tracked: TrackedItem, o: { endedAt?: Timestamp; override?: SessionItem['state'] }): void {
    const item = this.sessionItemOf(tracked.placement, tracked.wire, { startedAt: tracked.startedAt, endedAt: o.endedAt }, tracked, o.override);
    if (!item) return;
    tracked.last = item;
    this.emit({ type: 'item.updated', item });
  }

  private sessionItemOf(
    p: Placement,
    item: WireItem,
    times: { startedAt: Timestamp; endedAt?: Timestamp | undefined },
    output: { output: string; truncated: boolean },
    override?: SessionItem['state'],
  ): SessionItem | undefined {
    switch (item.type) {
      case 'commandExecution':
        return toCommandItem(p, item, times, output, override as Extract<SessionItem, { kind: 'command' }>['state'] | undefined);
      case 'fileChange':
        return toFileChangeItem(p, item, times, override as Extract<SessionItem, { kind: 'fileChange' }>['state'] | undefined);
      default:
        return toToolCallItem(p, item, times, override as Extract<SessionItem, { kind: 'toolCall' }>['state'] | undefined);
    }
  }

  private messageOf(p: Placement, item: WireItem, at: Timestamp): Message | undefined {
    if (item.type === 'agentMessage') return toAgentMessage(p, item, at);
    if (item.type === 'userMessage') {
      const origin = this.options.userOrigin?.({ sessionId: p.sessionId, clientMessageId: item.clientId ?? null }) ?? { kind: 'user' };
      return toUserMessage(p, item, origin, at);
    }
    return undefined;
  }

  private onAgentDelta(params: Record<string, unknown>): void {
    const binding = typeof params.threadId === 'string' ? this.threads.get(params.threadId) : undefined;
    if (!binding || typeof params.itemId !== 'string' || typeof params.delta !== 'string' || typeof params.turnId !== 'string') return;
    const p = this.placementFor(binding, params.turnId);
    this.emit({
      type: 'message.delta',
      sessionId: p.sessionId,
      ...opt('turnId', p.turnId === undefined ? undefined : TurnId.parse(p.turnId)),
      ...opt('nativeTaskId', p.nativeTaskId),
      messageId: MessageId.parse(params.itemId),
      delta: params.delta,
    });
  }

  private onOutputDelta(params: Record<string, unknown>): void {
    const tracked = typeof params.itemId === 'string' ? this.items.get(params.itemId) : undefined;
    if (!tracked || typeof params.delta !== 'string') return;
    this.setOutput(tracked, tracked.output + params.delta);
    this.emit({ type: 'item.outputDelta', sessionId: tracked.placement.sessionId, itemId: ItemId.parse(tracked.wire.id), delta: params.delta });
  }

  private setOutput(tracked: TrackedItem, output: string): void {
    const clipped = clipOutput(output, this.maxOutputChars());
    tracked.output = clipped.output;
    if (clipped.truncated) tracked.truncated = true;
  }

  /** Usage of a thread; a sub-agent's carries its nativeTaskId so it never replaces the session's own totals (R-13). */
  private onTokenUsage(threadId: string | undefined, params: Record<string, unknown>): void {
    const binding = threadId === undefined ? undefined : this.threads.get(threadId);
    const usage = params.tokenUsage as WireTokenUsage | undefined;
    if (!binding || !isObject(usage) || !isObject(usage.last) || !isObject(usage.total)) return;
    const turnId = typeof params.turnId === 'string' ? params.turnId : undefined;
    this.emit({ type: 'usage.tokens', usage: toTokenUsage({ sessionId: binding.sessionId, turnId, nativeTaskId: binding.nativeTaskId }, usage, this.now()) });
  }

  /** Only the weekly window maps to a contracts field (`codexWeekly`). */
  private onRateLimits(snapshot: unknown): void {
    if (!isObject(snapshot)) return;
    const weekly = [snapshot.primary, snapshot.secondary].find(
      (w): w is WireRateLimitWindow => isObject(w) && w.windowDurationMins === WEEK_MINUTES && typeof w.usedPercent === 'number',
    );
    if (!weekly) return;
    this.emit({
      type: 'usage.limits',
      codexWeekly: { percentUsed: Math.min(100, Math.max(0, weekly.usedPercent)), ...opt('resetsAt', weekly.resetsAt === null ? undefined : isoFromSeconds(weekly.resetsAt)) },
      at: this.now(),
    });
  }

  private onReroute(threadId: string | undefined, params: Record<string, unknown>): void {
    const binding = threadId === undefined ? undefined : this.threads.get(threadId);
    if (!binding || binding.nativeTaskId !== undefined) return;
    const { fromModel, toModel, reason } = params;
    if (typeof fromModel !== 'string' || typeof toModel !== 'string' || fromModel === '' || toModel === '') return;
    const at = this.now();
    this.emit({
      type: 'model.observed',
      sessionId: binding.sessionId,
      observed: { source: 'rerouted', from: fromModel, to: toModel, reason: typeof reason === 'string' ? reason : 'unknown', observedAt: at },
      at,
    });
  }

  /**
   * `subAgentActivity` on a bound thread announces a child thread (R-13). The child is bound to the same
   * session so its items, messages and approval requests carry the native task.
   */
  private onSubAgent(parentThreadId: string, parent: ThreadBinding, item: Extract<WireItem, { type: 'subAgentActivity' }>, at: Timestamp): void {
    const child = item.agentThreadId;
    if (typeof child !== 'string' || child === '') return;
    const id = NativeTaskId.parse(child);
    if (!this.threads.has(child)) this.threads.set(child, { sessionId: parent.sessionId, nativeTaskId: id });
    const previous = this.nativeTasks.get(child);
    const reported = item.kind === 'completed' ? 'completed' : item.kind === 'interrupted' ? 'stopped' : 'running';
    const childTurn = this.childTurnStates.get(child);
    // The parent's activity items lag behind the child's own turns: a spawn call may finish (`started`
    // again on item/completed) after the child turn already ended. So the child's turns decide: only a
    // child turn/started makes a known task running again, and the parent's end report is used only
    // when no child turn was ever seen.
    let state: NativeTask['state'];
    if (!previous) state = childTurn ?? reported;
    else if (reported === 'running' || childTurn !== undefined) return;
    else state = reported;
    this.updateNativeTask(
      previous ?? {
        id,
        sessionId: parent.sessionId,
        runtime: 'codex',
        parentRef: parentThreadId,
        nativeRef: child,
        ...opt('parentTaskId', parent.nativeTaskId),
        label: typeof item.agentPath === 'string' && item.agentPath !== '' ? item.agentPath : child,
        state,
        background: false,
        startedAt: at,
      },
      state,
      item.kind,
      at,
      previous === undefined,
    );
  }

  /**
   * The sub-agent's own turns are what actually ran (SP-03): a child turn that ends interrupted, failed
   * or completed ends the task even when no `subAgentActivity` follows, and a new child turn resumes it.
   */
  private onChildTurn(child: string, turn: WireTurn, ended: boolean, at: Timestamp): void {
    const state = !ended ? 'running' : turn.status === 'interrupted' ? 'stopped' : turn.status === 'completed' ? 'completed' : 'failed';
    // Remembered so a late spawn activity on the parent cannot contradict it.
    this.childTurnStates.set(child, state);
    this.liveChildTurns.add(child);
    const task = this.nativeTasks.get(child);
    if (task) this.updateNativeTask(task, state, `turn ${turn.status}`, at, false);
  }

  private updateNativeTask(base: NativeTask, state: NativeTask['state'], lastActivity: string, at: Timestamp, isNew: boolean): void {
    // Only state changes are reported; activity alone (turn started, interacted) would be noise.
    if (!isNew && base.state === state) return;
    const task: NativeTask = { ...base, state, lastActivity };
    if (state === 'running') delete task.endedAt;
    else task.endedAt = at;
    this.nativeTasks.set(task.nativeRef, task);
    this.emit({ type: 'nativeTask.updated', task });
  }

  // ---- internals: server requests -----------------------------------------------------------------

  private onServerRequest(id: RpcId, method: string, params: unknown): void {
    const kind = permissionKindOf(method);
    if (!kind) {
      // Dynamic tools, user-input questions, auth refresh, legacy approvals: not offered by this client.
      this.log('warn', `unsupported server request ${method}; answering with an error`);
      this.conn?.respondError(id, -32601, `${method} is not supported by AgentWorkflowGui`);
      return;
    }
    let entry: PermissionEntry;
    try {
      const built = this.registerPermission(id, kind, params);
      if (typeof built === 'string') {
        this.log('warn', `${method} refused: ${built}`);
        this.conn?.respond(id, refusalToWire(kind));
        return;
      }
      entry = built;
    } catch (error) {
      // Nothing reached the upper layer; still answer so the turn does not hang (fail closed).
      this.log('warn', `${method} could not be handled; declining`, error);
      if (!this.permissions.has(rpcKey(id))) this.conn?.respond(id, refusalToWire(kind));
      else this.failClosed(this.permissions.get(rpcKey(id))!, error);
      return;
    }
    const handle = this.handleFor(entry);
    try {
      const pending = this.options.onPermissionRequest(handle);
      if (isThenable(pending)) void Promise.resolve(pending).catch((error: unknown) => this.failClosed(entry, error));
    } catch (error) {
      this.failClosed(entry, error);
    }
  }

  /** Builds and registers an open request, or returns why it has to be refused. */
  private registerPermission(id: RpcId, kind: PermissionKind, params: unknown): PermissionEntry | string {
    const p = isObject(params) ? params : {};
    const threadId = typeof p.threadId === 'string' ? p.threadId : '';
    const binding = this.threads.get(threadId);
    if (!binding) return `thread ${threadId} is not bound to a session`;
    if (p.turnId !== undefined && p.turnId !== null && !isNonEmptyString(p.turnId)) return 'turnId is not a non-empty string';
    const nativeTurnId = isNonEmptyString(p.turnId) ? p.turnId : null;
    const knownPaths = kind === 'fileChange' && typeof p.itemId === 'string' ? this.fileChangePaths(p.itemId) : undefined;
    const built = buildPermissionRequest(kind, params, {
      id: PermissionRequestId.parse(this.options.newId?.() ?? randomUUID()),
      placement: this.placementFor(binding, nativeTurnId ?? undefined),
      createdAt: this.now(),
      knownPaths,
    });
    if (typeof built === 'string') return `cannot be represented (${built})`;
    const entry: PermissionEntry = { rpcId: id, threadId, nativeTurnId, kind, ...opt('grant', built.grant), request: built.request };
    this.permissions.set(rpcKey(id), entry);
    this.emit({ type: 'permission.updated', request: built.request });
    return entry;
  }

  /** A broken handler must not leave the turn hanging: decline whatever is still open. */
  private failClosed(entry: PermissionEntry, error: unknown): void {
    if (this.permissions.get(rpcKey(entry.rpcId)) !== entry) return;
    this.log('warn', 'permission handler failed; declining', error);
    const decision: PermissionDecision = { outcome: 'decline', decidedBy: 'policy', reason: 'permission handler failed', at: this.now() };
    try {
      this.handleFor(entry).answer(decision);
    } catch {
      // The answer itself could not be built; still release the runtime.
      if (this.conn?.respond(entry.rpcId, refusalToWire(entry.kind))) this.permissions.delete(rpcKey(entry.rpcId));
      this.withdraw(entry);
    }
  }

  private fileChangePaths(itemId: string): string[] | undefined {
    const tracked = this.items.get(itemId);
    if (tracked?.wire.type !== 'fileChange') return undefined;
    return tracked.wire.changes.flatMap((c) => [c.path, ...(c.kind.type === 'update' && c.kind.move_path ? [c.kind.move_path] : [])]);
  }

  private handleFor(entry: PermissionEntry): PermissionHandle {
    const key = rpcKey(entry.rpcId);
    const isOpen = () => this.permissions.get(key) === entry;
    return {
      get request() {
        return entry.request;
      },
      // Both validate the whole resulting request before anything is emitted or sent, so an invalid
      // answer (e.g. approve-for-session on an elicitation) throws and changes nothing.
      hold: (hold, extra) => {
        if (!isOpen()) return false;
        entry.request = PermissionRequest.parse({ ...entry.request, state: 'held', hold, ...opt('matchedRule', extra?.matchedRule) });
        this.emit({ type: 'permission.updated', request: entry.request });
        return true;
      },
      answer: (decision, extra) => {
        if (!isOpen()) return false;
        const parsed = PermissionDecision.parse(decision);
        const answered = PermissionRequest.parse({ ...withoutHold(entry.request), state: 'answered', decision: parsed, ...opt('matchedRule', extra?.matchedRule) });
        if (!this.conn?.respond(entry.rpcId, decisionToWire(entry.kind, parsed, entry.grant))) {
          this.withdraw(entry);
          return false;
        }
        this.permissions.delete(key);
        entry.request = answered;
        this.emit({ type: 'permission.updated', request: entry.request });
        return true;
      },
    };
  }

  /** The runtime no longer waits for this request (resolved elsewhere, turn over, or process gone). */
  private withdraw(entry: PermissionEntry | undefined): void {
    if (!entry || this.permissions.get(rpcKey(entry.rpcId)) !== entry) return;
    this.permissions.delete(rpcKey(entry.rpcId));
    entry.request = { ...withoutHold(entry.request), state: 'withdrawn' };
    this.emit({ type: 'permission.updated', request: entry.request });
  }

  private onExit(exit: ExitInfo): void {
    for (const entry of [...this.permissions.values()]) this.withdraw(entry);
    this.emit({
      type: 'runtime.exited',
      runtime: 'codex',
      sessionIds: [...new Set([...this.threads.values()].map((b) => b.sessionId))],
      expected: this.closing,
      code: exit.code,
      signal: exit.signal,
      ...opt('error', exit.error),
      at: this.now(),
    });
  }

  // ---- helpers ------------------------------------------------------------------------------------

  /**
   * One adapter, one app-server, one GUI session (CR-7): closing the session closes the app-server and
   * its Job, so a second session here would be ended with it.
   */
  private claim(sessionId: SessionId): void {
    if (this.owner !== undefined && this.owner !== sessionId) {
      throw new Error(`this Codex app-server serves session ${this.owner}; session ${sessionId} needs its own adapter (CR-7)`);
    }
  }

  private binding(threadId: string): ThreadBinding {
    const binding = this.threads.get(threadId);
    if (!binding) throw new Error(`thread ${threadId} is not bound to a session; start or resume it first`);
    return binding;
  }

  /** Session items of a sub-agent carry its native task and no session turn (R-13). */
  private placementFor(binding: Pick<ThreadBinding, 'sessionId' | 'nativeTaskId'>, turnId: string | undefined): Placement {
    return binding.nativeTaskId === undefined ? { sessionId: binding.sessionId, turnId } : { sessionId: binding.sessionId, nativeTaskId: binding.nativeTaskId };
  }

  private now(): Timestamp {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.log('warn', `event listener threw on ${event.type}`, error);
      }
    }
  }

  /** A malformed message must not take the whole connection down. */
  private guard(method: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.log('warn', `failed to handle ${method}`, error);
    }
  }

  private log(level: 'debug' | 'warn', message: string, detail?: unknown): void {
    this.options.log?.(level, message, detail);
  }
}

/** `hold` is set exactly while held, so it goes when the request is answered or withdrawn. */
const withoutHold = (request: PermissionRequest): PermissionRequest => {
  const copy = { ...request };
  delete copy.hold;
  return copy;
};

/** Keeps the trailing `max` characters of command output. */
const clipOutput = (output: string, max: number): { output: string; truncated: boolean } =>
  output.length > max ? { output: output.slice(-max), truncated: true } : { output, truncated: false };

/** The dispatched payload is one text input; the stored message must be exactly that text. */
const sameText = (content: unknown, text: string): boolean =>
  Array.isArray(content) &&
  content.length === 1 &&
  isObject(content[0]) &&
  content[0].type === 'text' &&
  content[0].text === text;
