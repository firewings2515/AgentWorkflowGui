// Codex runtime adapter (T003): owns one `codex app-server` stdio child (D-03) and turns its threads,
// turns, items and approval requests into contracts types. Several GUI sessions may share one
// app-server; every thread is bound to the GUI session it belongs to.
//
// Not here on purpose: retries of any kind (CR-2), the R-08 escalation decision (policy module), the
// supervisor's idle shutdown, and killing command processes after an interrupt (CR-7).
import { randomUUID } from 'node:crypto';
import {
  type AppEvent,
  type DispatchAttempt,
  ItemId,
  type Message,
  MessageId,
  type ModelOption,
  type ModelSelection,
  type NativeRef,
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
import type { DeliveryEvidence, MessageOrigin, PermissionDecision as Decision, PermissionHold } from './contract-types';
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

type AdapterAppEvent = Extract<
  AppEvent,
  {
    type:
      | 'turn.updated'
      | 'message.delta'
      | 'message.completed'
      | 'item.updated'
      | 'item.outputDelta'
      | 'permission.updated'
      | 'nativeTask.updated'
      | 'usage.tokens'
      | 'usage.limits';
  }
>;

/**
 * What the adapter reports. Most are AppEvent members as-is; `model.observed` (R-12 reroute) and
 * `runtime.exited` have no AppEvent of their own yet, so the layer above folds them into its state.
 */
export type CodexAdapterEvent =
  | AdapterAppEvent
  | { type: 'model.observed'; sessionId: SessionId; observed: Extract<ObservedModel, { source: 'rerouted' }> }
  | { type: 'runtime.exited'; expected: boolean; code: number | null; signal: string | null; error?: string; at: Timestamp };

/**
 * One approval request handed to the layer above. Answering may wait as long as needed (R-07 lock
 * holds, R-05 escalations); call `hold` to show why. Both return false once the request is no longer
 * open (answered, or withdrawn because the turn ended or the runtime went away).
 */
export interface PermissionHandle {
  readonly request: PermissionRequest;
  hold(hold: PermissionHold, extra?: { matchedRule?: string }): boolean;
  answer(decision: Decision, extra?: { matchedRule?: string }): boolean;
}

export interface CodexAdapterOptions {
  /**
   * Called once per approval request; must eventually answer it (or let it be withdrawn). If it throws
   * or its promise rejects before answering, the request is declined (fail closed).
   */
  onPermissionRequest(handle: PermissionHandle): unknown;
  /** Replaces the default spawn (tests plug in a fake app-server here). */
  spawn?: () => AppServerProcess;
  spawnOptions?: SpawnOptions;
  clientInfo?: { name: string; title: string; version: string };
  /**
   * Origin of user messages seen in the thread. Peer and handoff messages arrive as plain user input in
   * Codex; the layer above knows them by the clientMessageId it dispatched. Defaults to `user`.
   */
  userOrigin?: (info: { sessionId: SessionId; clientMessageId: string | null }) => MessageOrigin;
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

export type HistoryEntry = { turnId: string } & ({ kind: 'message'; message: Message } | { kind: 'item'; item: SessionItem });

export type DispatchEntry = { kind: 'new-turn'; model?: string; effort?: string } | { kind: 'insert'; expectedTurnId: string };

export interface DispatchRequest {
  threadId: string;
  /** The attempt already committed as unknown by the dispatcher (CR2_DELIVERY_FIX §1 step 3). */
  attempt: Extract<DispatchAttempt, { state: 'unknown' }>;
  text: string;
  entry: DispatchEntry;
  timeoutMs?: number;
}

/**
 * `sent`: the runtime accepted this exact request. `unknown`: anything else. `written: false` means the
 * payload never left this process; even then the attempt stays unknown, nothing is resent (CR-2).
 */
export type DispatchResult =
  | { state: 'sent'; nativeRef: NativeRef; evidence: DeliveryEvidence }
  | {
      state: 'unknown';
      reason: 'timeout' | 'disconnected' | 'rejected' | 'not-running' | 'already-dispatched' | 'malformed-response';
      written: boolean;
      detail: string;
    };

export interface ReconcileRequest {
  threadId: string;
  clientMessageId: string;
  /** The exact text that was dispatched; matched against the stored user message. */
  text: string;
}

export interface ReconcileMatch {
  turnId: string;
  itemId: string;
  contentMatches: boolean;
}

export type ReconcileResult =
  | { state: 'sent'; nativeRef: NativeRef; evidence: DeliveryEvidence }
  | { state: 'unknown'; reason: 'not-found' | 'content-mismatch' | 'duplicate' | 'read-failed' | 'not-running'; matches: ReconcileMatch[]; detail: string };

/** Codex thread on our side: which GUI session it belongs to, and the native task when it is a sub-agent. */
interface ThreadBinding {
  sessionId: SessionId;
  nativeTaskId?: NativeTaskId;
  /** Model asked for by a turn/start whose turn has not been announced yet. */
  nextTurnModel?: ModelSelection;
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

export class CodexAdapter {
  private conn: RpcConnection | undefined;
  private closing = false;
  private readonly listeners = new Set<(event: CodexAdapterEvent) => void>();
  private readonly threads = new Map<string, ThreadBinding>();
  private readonly turnModels = new Map<string, ModelSelection>();
  private readonly items = new Map<string, TrackedItem>();
  private readonly nativeTasks = new Map<string, NativeTask>();
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

  subscribe(listener: (event: CodexAdapterEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Spawns the app-server and runs the `initialize` handshake. */
  async start(): Promise<{ userAgent: string; codexHome: string | null; platformOs: string | null }> {
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
      capabilities: null,
    });
    this.conn.notify('initialized');
    const r = isObject(result) ? result : {};
    return {
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
    conn.kill();
    const killed = await Promise.race([conn.exited, timeout(2000, { code: null, signal: null, error: 'did not exit after kill' })]);
    return { ...killed, forced: true };
  }

  // ---- threads ------------------------------------------------------------------------------------

  /**
   * `thread/start` with the R-08 policy and SP-04 isolation. Carries no work payload: creating the target
   * and delivering to it are separate operations (CR2_DELIVERY_FIX §3). If this rejects with a timeout or
   * closed connection the thread may exist anyway; the caller must not blindly start another.
   */
  async startThread(options: StartThreadOptions): Promise<CodexThreadInfo> {
    const response = await this.request('thread/start', { cwd: options.cwd, ...this.threadParams(options) });
    return this.bindFromResponse(options.sessionId, response, 'thread/start');
  }

  /** `thread/resume` without loading the full history (page it with listTurns / listItems). */
  async resumeThread(options: ResumeThreadOptions): Promise<CodexThreadInfo> {
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
      return this.bindFromResponse(options.sessionId, response, 'thread/resume');
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

  /** One page of `thread/turns/list` (default: newest first). */
  async listTurns(
    threadId: string,
    options: { sessionId?: SessionId; cursor?: string; limit?: number; sortDirection?: 'asc' | 'desc' } = {},
  ): Promise<{ turns: Turn[]; nextCursor: string | null }> {
    const sessionId = this.sessionFor(threadId, options.sessionId);
    const page = (await this.request('thread/turns/list', {
      threadId,
      ...opt('cursor', options.cursor),
      ...opt('limit', options.limit),
      ...opt('sortDirection', options.sortDirection),
    })) as WirePage<WireTurn>;
    const turns = (page?.data ?? []).map((t) => toTurn(sessionId, t, { now: this.now(), requestedModel: this.turnModels.get(t.id) }));
    return { turns, nextCursor: page?.nextCursor ?? null };
  }

  /** One page of `thread/items/list` mapped to messages and session items; other item kinds are skipped. */
  async listItems(
    threadId: string,
    options: { sessionId?: SessionId; turnId?: string; cursor?: string; limit?: number; sortDirection?: 'asc' | 'desc' } = {},
  ): Promise<{ entries: HistoryEntry[]; nextCursor: string | null }> {
    const sessionId = this.sessionFor(threadId, options.sessionId);
    const page = await this.itemsPage(threadId, options);
    const binding = this.threads.get(threadId);
    const entries: HistoryEntry[] = [];
    for (const e of page.data) {
      const placement = this.placementFor(binding ?? { sessionId }, e.turnId);
      // Stored items are finished; history may lack timestamps, so fall back to the read time.
      const startedAt = typeof e.startedAtMs === 'number' ? isoFromMs(e.startedAtMs) : this.now();
      const times = { startedAt, endedAt: typeof e.completedAtMs === 'number' ? isoFromMs(e.completedAtMs) : startedAt };
      const message = this.messageOf(placement, e.item, times.endedAt);
      if (message) entries.push({ turnId: e.turnId, kind: 'message', message });
      const item = this.sessionItemOf(placement, e.item, times, { output: e.item.type === 'commandExecution' ? (e.item.aggregatedOutput ?? '') : '', truncated: false });
      if (item) entries.push({ turnId: e.turnId, kind: 'item', item });
    }
    return { entries, nextCursor: page.nextCursor };
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
    const binding = this.threads.get(req.threadId);
    if (!binding) throw new Error(`dispatchOnce: thread ${req.threadId} is not bound to a session`);
    for (const k of keys) this.dispatched.add(k);

    const timeoutMs = req.timeoutMs ?? this.options.dispatchTimeoutMs ?? 30_000;
    const method = req.entry.kind === 'new-turn' ? 'turn/start' : 'turn/steer';
    try {
      const response =
        req.entry.kind === 'new-turn'
          ? await this.sendTurnStart(
              binding,
              { threadId: req.threadId, text: req.text, clientUserMessageId: attempt.clientMessageId, ...opt('model', req.entry.model), ...opt('effort', req.entry.effort) },
              timeoutMs,
            )
          : await this.request(
              'turn/steer',
              {
                threadId: req.threadId,
                expectedTurnId: req.entry.expectedTurnId,
                input: [{ type: 'text', text: req.text, text_elements: [] }],
                clientUserMessageId: attempt.clientMessageId,
              },
              timeoutMs,
            );
      const turnId = req.entry.kind === 'new-turn' ? (isObject(response) && isObject(response.turn) ? response.turn.id : undefined) : isObject(response) ? response.turnId : undefined;
      if (typeof turnId !== 'string' || turnId === '') {
        return { state: 'unknown', reason: 'malformed-response', written: true, detail: `${method} answered without a turn id` };
      }
      return {
        state: 'sent',
        nativeRef: { sessionRef: req.threadId, turnRef: turnId },
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
    let entries: { turnId: string; item: WireItem }[];
    try {
      entries = await this.readWholeHistory(req.threadId);
    } catch (error) {
      return { state: 'unknown', reason: 'read-failed', matches: [], detail: error instanceof Error ? error.message : String(error) };
    }
    const matches: ReconcileMatch[] = entries
      .filter((e): e is { turnId: string; item: Extract<WireItem, { type: 'userMessage' }> } => e.item.type === 'userMessage' && e.item.clientId === req.clientMessageId)
      .map((e) => ({ turnId: e.turnId, itemId: e.item.id, contentMatches: sameText(e.item.content, req.text) }));
    if (matches.length === 0) {
      return { state: 'unknown', reason: 'not-found', matches, detail: `no user message with clientId ${req.clientMessageId} in ${entries.length} stored items` };
    }
    if (matches.length > 1) return { state: 'unknown', reason: 'duplicate', matches, detail: `${matches.length} user messages carry clientId ${req.clientMessageId}` };
    const [match] = matches as [ReconcileMatch];
    if (!match.contentMatches) return { state: 'unknown', reason: 'content-mismatch', matches, detail: 'the stored message with this clientId has different content' };
    return {
      state: 'sent',
      nativeRef: { sessionRef: req.threadId, turnRef: match.turnId, itemRef: match.itemId },
      evidence: { kind: 'reconciled', at: this.now(), detail: `stored userMessage ${match.itemId} in turn ${match.turnId} has clientId ${req.clientMessageId} and the same text` },
    };
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
    const requested: ModelSelection | undefined = input.model ? { runtime: 'codex', model: input.model, ...opt('effort', input.effort) } : undefined;
    // turn/started can arrive before the response (seen in SP-06), so remember the model for it.
    if (requested) binding.nextTurnModel = requested;
    const response = await this.request(
      'turn/start',
      {
        threadId: input.threadId,
        input: [{ type: 'text', text: input.text, text_elements: [] }],
        ...opt('clientUserMessageId', input.clientUserMessageId),
        ...opt('model', input.model),
        ...opt('effort', input.effort),
      },
      timeoutMs,
    ).finally(() => {
      if (binding.nextTurnModel === requested) delete binding.nextTurnModel;
    });
    if (requested && isObject(response) && isObject(response.turn) && typeof response.turn.id === 'string') this.turnModels.set(response.turn.id, requested);
    return response;
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

  /**
   * Every stored item of the thread. Pages `thread/items/list` to the end; if that API fails, falls back
   * to `thread/read` with full turns (the path SP CR-2 proved). Both are read-only. Throws when the
   * history cannot be shown to be complete.
   */
  private async readWholeHistory(threadId: string): Promise<{ turnId: string; item: WireItem }[]> {
    try {
      const all: { turnId: string; item: WireItem }[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
        const res = await this.itemsPage(threadId, { ...opt('cursor', cursor), limit: 200, sortDirection: 'asc' });
        all.push(...res.data);
        if (res.nextCursor === null) return all;
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
    const all: { turnId: string; item: WireItem }[] = [];
    for (const [i, turn] of thread.turns.entries()) {
      // Only `full` turns carry every item; `summary` / `notLoaded` would hide messages.
      if (!isObject(turn) || !isNonEmptyString(turn.id) || turn.itemsView !== 'full' || !Array.isArray(turn.items)) {
        throw new IncompleteHistoryError(`thread/read: turn ${i} is not fully loaded`);
      }
      for (const item of turn.items) {
        if (!isWireItem(item)) throw new IncompleteHistoryError(`thread/read: turn ${turn.id} has a malformed item`);
        all.push({ turnId: turn.id, item });
      }
    }
    return all;
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
    const mapped = toTurn(binding.sessionId, turn, { now, requestedModel: this.turnModels.get(turn.id) });
    if (method === 'turn/completed') {
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
    // A sub-agent's turns are not turns of the GUI session (Turn has no native task); they drive its
    // NativeTask state instead. Its items still belong to the session.
    if (binding.nativeTaskId === undefined) this.emit({ type: 'turn.updated', turn: mapped });
    else this.onChildTurn(threadId!, turn, method === 'turn/completed', mapped.endedAt ?? now);
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
    const max = this.options.maxOutputChars ?? 64 * 1024;
    if (output.length > max) {
      tracked.output = output.slice(-max);
      tracked.truncated = true;
    } else {
      tracked.output = output;
    }
  }

  /** Token usage of the session's own thread; a sub-agent's totals would overwrite the session's. */
  private onTokenUsage(threadId: string | undefined, params: Record<string, unknown>): void {
    const binding = threadId === undefined ? undefined : this.threads.get(threadId);
    const usage = params.tokenUsage as WireTokenUsage | undefined;
    if (!binding || binding.nativeTaskId !== undefined || !isObject(usage) || !isObject(usage.last) || !isObject(usage.total)) return;
    const turnId = typeof params.turnId === 'string' ? params.turnId : undefined;
    this.emit({ type: 'usage.tokens', usage: toTokenUsage({ sessionId: binding.sessionId, turnId }, usage, this.now()) });
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
    this.emit({
      type: 'model.observed',
      sessionId: binding.sessionId,
      observed: { source: 'rerouted', from: fromModel, to: toModel, reason: typeof reason === 'string' ? reason : 'unknown', observedAt: this.now() },
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
    const state = item.kind === 'completed' ? 'completed' : item.kind === 'interrupted' ? 'stopped' : 'running';
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
    const task = this.nativeTasks.get(child);
    if (!task) return;
    const state = !ended ? 'running' : turn.status === 'interrupted' ? 'stopped' : turn.status === 'completed' ? 'completed' : 'failed';
    this.updateNativeTask(task, state, `turn ${turn.status}`, at, false);
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
    const decision: Decision = { outcome: 'decline', decidedBy: 'policy', reason: 'permission handler failed', at: this.now() };
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
      expected: this.closing,
      code: exit.code,
      signal: exit.signal,
      ...opt('error', exit.error),
      at: this.now(),
    });
  }

  // ---- helpers ------------------------------------------------------------------------------------

  private binding(threadId: string): ThreadBinding {
    const binding = this.threads.get(threadId);
    if (!binding) throw new Error(`thread ${threadId} is not bound to a session; start or resume it first`);
    return binding;
  }

  private sessionFor(threadId: string, explicit: SessionId | undefined): SessionId {
    const sessionId = explicit ?? this.threads.get(threadId)?.sessionId;
    if (sessionId === undefined) throw new Error(`thread ${threadId} is not bound to a session; pass sessionId`);
    return sessionId;
  }

  /** Session items of a sub-agent carry its native task and no session turn (R-13). */
  private placementFor(binding: Pick<ThreadBinding, 'sessionId' | 'nativeTaskId'>, turnId: string | undefined): Placement {
    return binding.nativeTaskId === undefined ? { sessionId: binding.sessionId, turnId } : { sessionId: binding.sessionId, nativeTaskId: binding.nativeTaskId };
  }

  private now(): Timestamp {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private emit(event: CodexAdapterEvent): void {
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

/** The dispatched payload is one text input; the stored message must be exactly that text. */
const sameText = (content: unknown, text: string): boolean =>
  Array.isArray(content) &&
  content.length === 1 &&
  isObject(content[0]) &&
  content[0].type === 'text' &&
  content[0].text === text;
