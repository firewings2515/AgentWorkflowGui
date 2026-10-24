// Runtime adapter port (T005). Claude and Codex adapters implement it; core talks to runtimes only
// through it (IMPLEMENTATION_DRAFT §4). Runtime-neutral: a native session is Codex's thread or Claude's
// session, named `nativeSessionRef` here.
import type {
  AppEvent,
  ClientMessageId,
  DeliveryEvidence,
  DispatchAttempt,
  ModelOption,
  ModelSelection,
  NativeRef,
  ObservedModel,
  PermissionDecision,
  PermissionHold,
  PermissionRequest,
  Runtime,
  SessionId,
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
  instructions?: string;
}

export interface StartSessionOptions extends SessionSettings {
  sessionId: SessionId;
  cwd: string;
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
}

/** How a payload enters the session: a new turn when idle, or inserted into the running turn (SP-05). */
export type DispatchEntry = { kind: 'new-turn'; model?: ModelSelection } | { kind: 'insert'; expectedTurnRef?: string };

export interface DispatchRequest {
  nativeSessionRef: string;
  /** The attempt already committed as unknown by the dispatcher (CR2_DELIVERY_FIX §1 step 3). */
  attempt: Extract<DispatchAttempt, { state: 'unknown' }>;
  text: string;
  entry: DispatchEntry;
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

/** When a model change takes effect (R-12): Claude from the next model call, Codex from the next turn. */
export type ModelChangeTiming = 'next-model-call' | 'next-turn';

export interface RuntimeAdapter {
  readonly runtime: Runtime;
  start(): Promise<void>;
  /** Graceful stop (R-14: Claude interrupts before closing; Codex closes stdin). */
  close(timeoutMs?: number): Promise<{ forced: boolean }>;
  startSession(options: StartSessionOptions): Promise<NativeSessionInfo>;
  resumeSession(options: ResumeSessionOptions): Promise<NativeSessionInfo>;
  /** Every payload enters a session through here exactly once (CR2_DELIVERY_FIX §1 step 4). */
  dispatchOnce(request: DispatchRequest): Promise<DispatchResult>;
  reconcile(request: ReconcileRequest): Promise<ReconcileResult>;
  interrupt(nativeSessionRef: string): Promise<void>;
  setModel(nativeSessionRef: string, model: ModelSelection): Promise<ModelChangeTiming>;
  /** Stops one native sub-agent only (R-13). */
  stopNativeTask(nativeSessionRef: string, nativeTaskRef: string): Promise<void>;
  listModels(): Promise<ModelOption[]>;
  /** Returns the unsubscribe function. */
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
}
