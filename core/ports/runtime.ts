// Runtime adapter port (T005). Claude and Codex adapters implement it; core talks to runtimes only
// through it (IMPLEMENTATION_DRAFT §4). Runtime-neutral: a native session is Codex's thread or Claude's
// session, named `nativeSessionRef` here.
import type {
  AppEvent,
  ClientMessageId,
  DeliveryEvidence,
  DispatchAttempt,
  Message,
  MessageOrigin,
  ModelOption,
  ModelSelection,
  NativeRef,
  NativeTask,
  NativeTaskId,
  ObservedModel,
  PermissionDecision,
  PermissionHold,
  PermissionRequest,
  Runtime,
  SessionId,
  SessionItem,
  Turn,
  WritePolicy,
} from '../../contracts';

/** Events an adapter emits; all are AppEvent members, so the layer above can forward them as they are. */
export type RuntimeEvent = Extract<
  AppEvent,
  {
    type:
      | 'session.activity'
      | 'turn.updated'
      | 'message.delta'
      | 'message.completed'
      | 'item.updated'
      | 'item.outputDelta'
      | 'permission.updated'
      | 'nativeTask.updated'
      | 'usage.tokens'
      | 'usage.limits'
      | 'model.observed'
      | 'runtime.exited';
  }
>;

/**
 * One approval request handed to the layer above. It may be held as long as needed (R-07 lock waits,
 * R-05 escalations) and is answered once. Both methods return false once the request is no longer open
 * (answered, or withdrawn by the runtime). The adapter validates the whole resulting PermissionRequest
 * before replying to the runtime and throws without replying when it would be invalid.
 */
export interface PermissionHandle {
  readonly request: PermissionRequest;
  hold(hold: PermissionHold, extra?: { matchedRule?: string }): boolean;
  answer(decision: PermissionDecision, extra?: { matchedRule?: string }): boolean;
}

export interface RuntimeAdapterHooks {
  /**
   * Called once per approval request; must eventually answer it or let it be withdrawn. If it throws or
   * its promise rejects before answering, the adapter declines the request (fail closed).
   */
  onPermissionRequest(handle: PermissionHandle): unknown;
}

/** What core keeps about a native session after start or resume. */
export interface NativeSessionInfo {
  sessionId: SessionId;
  nativeSessionRef: string;
  cwd: string;
  /** Claude: last per-message model; Codex: the configured model only (R-12). */
  model: ObservedModel;
}

export interface SessionSettings {
  model: ModelSelection;
  /** Read-only nodes (R-04 writePolicy). Never wider than the runtime's workspace sandbox (R-08). */
  readOnly: boolean;
  /**
   * The node's write policy (C-23), when it is not plain write / read-only: `exec-only` runs commands but
   * edits no file itself, and has `readOnly: true`. Absent (settings stored before 0.6) means `readOnly`
   * decides alone. `readOnly` is always `writePolicy !== 'write'` when both are given.
   */
  writePolicy?: WritePolicy;
  instructions?: string;
}

/**
 * The GUI MCP server mounted on one session (R-03, SP-05): localhost streamable HTTP with a token that
 * identifies this session. Given at every start and resume, never persisted with the session settings.
 */
export interface McpMount {
  url: string;
  token: string;
}

export interface StartSessionOptions extends SessionSettings {
  sessionId: SessionId;
  cwd: string;
  mcp?: McpMount;
  /**
   * Native session ID chosen by the GUI before the call, when the runtime allows it (Claude `sessionId`),
   * so a lost create response can still be reconciled (CR2_DELIVERY_FIX §3). Ignored where unsupported.
   */
  preallocatedRef?: string;
}

export interface ResumeSessionOptions extends SessionSettings {
  sessionId: SessionId;
  nativeSessionRef: string;
  /** Always the original cwd (R-06). */
  cwd: string;
  mcp?: McpMount;
}

/** How a payload enters the session: a new turn when idle, or inserted into the running turn (SP-05). */
export type DispatchEntry = { kind: 'new-turn'; model?: ModelSelection } | { kind: 'insert'; expectedTurnRef?: string };

export interface DispatchRequest {
  nativeSessionRef: string;
  /** The attempt already committed as unknown by the dispatcher (CR2_DELIVERY_FIX §1 step 3). */
  attempt: Extract<DispatchAttempt, { state: 'unknown' }>;
  text: string;
  entry: DispatchEntry;
  /**
   * Who the payload comes from (C-07). Adapters mark peer and handoff payloads as not from the user (R-03:
   * Codex gets a text envelope naming the source). Absent means the user.
   */
  origin?: MessageOrigin;
  timeoutMs?: number;
}

/**
 * `sent`: the runtime accepted this exact request. `unknown`: anything else, never retried by the adapter.
 * `written: false` means the payload never left this process; the attempt still stays unknown (CR-2).
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
  nativeSessionRef: string;
  /** Claude reads stored sessions by cwd and session ID; Codex ignores it. */
  cwd: string;
  clientMessageId: ClientMessageId;
  /** The exact text that was dispatched; matched against the stored user message. */
  text: string;
}

export interface ReconcileMatch {
  turnRef: string;
  itemRef: string;
  contentMatches: boolean;
}

/** Read-only; never resumes a session or starts a turn. Not found is not proof of non-delivery (CR-2). */
export type ReconcileResult =
  | { state: 'sent'; nativeRef: NativeRef; evidence: DeliveryEvidence }
  | {
      state: 'unknown';
      reason: 'not-found' | 'content-mismatch' | 'duplicate' | 'read-failed' | 'not-running';
      matches: ReconcileMatch[];
      detail: string;
    };

export interface ReconcileProvisionRequest {
  /** The cwd the session was created in. */
  cwd: string;
  /** The native session ID chosen before the create call (Claude); absent when the runtime has none. */
  preallocatedRef?: string;
}

/**
 * Read-only check of a create call whose response was lost (C-08, CR2_DELIVERY_FIX §3). `sent`: the
 * session exists. `unknown`: not found (not proof it was not created), unreadable, or the runtime cannot
 * tell (Codex has no ID before `thread/start`).
 */
export type ReconcileProvisionResult =
  | { state: 'sent'; nativeSessionRef: string }
  | { state: 'unknown'; reason: 'not-found' | 'read-failed' | 'unsupported'; detail: string };

/** One stored history entry, already mapped to contract types. */
export type HistoryEntry = { kind: 'turn'; turn: Turn } | { kind: 'message'; message: Message } | { kind: 'item'; item: SessionItem };

export interface HistoryRequest {
  sessionId: SessionId;
  nativeSessionRef: string;
  /** Claude reads stored sessions by cwd and session ID; Codex ignores it. */
  cwd: string;
  /**
   * A native sub-agent's own conversation instead of the session's (R-13, CR-6: Claude
   * `getSubagentMessages`, Codex child thread). Entries carry this `nativeTaskId`.
   */
  nativeTask?: { nativeTaskId: NativeTaskId; nativeRef: string };
}

/**
 * Read-only, oldest first; never resumes a session or starts a turn. `complete: false` means some of the
 * history could not be read (paging failed, summarised turns, a sub-agent without proof that it ended),
 * so callers must not treat gaps as absence nor a `running` native task as proof that it still runs (C-09).
 */
export interface HistoryResult {
  entries: HistoryEntry[];
  nativeTasks: NativeTask[];
  complete: boolean;
}

/** When a model change takes effect (R-12): Claude from the next model call, Codex from the next turn. */
export type ModelChangeTiming = 'next-model-call' | 'next-turn';

export interface RuntimeAdapter {
  readonly runtime: Runtime;
  start(): Promise<void>;
  /** Graceful stop (R-14: Claude interrupts before closing; Codex closes stdin). */
  close(timeoutMs?: number): Promise<{ forced: boolean }>;
  startSession(options: StartSessionOptions): Promise<NativeSessionInfo>;
  resumeSession(options: ResumeSessionOptions): Promise<NativeSessionInfo>;
  /**
   * Releases one session's runtime resources (R-14: interrupt first, then close) without touching other
   * sessions, e.g. when an idle session is closed (SP-05); `resumeSession` brings it back (C-07).
   */
  closeSession(nativeSessionRef: string, timeoutMs?: number): Promise<{ forced: boolean }>;
  reconcileProvision(request: ReconcileProvisionRequest): Promise<ReconcileProvisionResult>;
  /** Every payload enters a session through here exactly once (CR2_DELIVERY_FIX §1 step 4). */
  dispatchOnce(request: DispatchRequest): Promise<DispatchResult>;
  reconcile(request: ReconcileRequest): Promise<ReconcileResult>;
  /** Stored history of a session or one of its native sub-agents, for restart and read-only views. */
  readHistory(request: HistoryRequest): Promise<HistoryResult>;
  interrupt(nativeSessionRef: string): Promise<void>;
  setModel(nativeSessionRef: string, model: ModelSelection): Promise<ModelChangeTiming>;
  /** Stops one native sub-agent only (R-13). */
  stopNativeTask(nativeSessionRef: string, nativeTaskRef: string): Promise<void>;
  listModels(): Promise<ModelOption[]>;
  /** Returns the unsubscribe function. */
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
}
