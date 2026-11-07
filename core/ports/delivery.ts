// Delivery store port (T005): the durable side of CR-2 (R-04 steps 3-7, CR2_DELIVERY_FIX §1-5).
// The storage adapter (T007) implements it on SQLite; the dispatcher (T008) uses it. Each method is one
// transaction; a method that cannot be sure its commit succeeded throws `CommitUncertainError`, and the
// caller must then not call the runtime.
import type {
  AttemptId,
  ClientMessageId,
  DeliveryEvidence,
  DeliveryRecord,
  DeliveryTarget,
  DispatchAttempt,
  HandoffId,
  InstanceId,
  MessageOrigin,
  NativeRef,
  NodeId,
  OperationId,
  OperationOutcome,
  PeerMessageId,
  PayloadHash,
  Revision,
  Runtime,
  SessionId,
  TaskId,
  Timestamp,
} from '../../contracts';
import type { DispatchEntry, SessionSettings } from './runtime';

/**
 * What is being delivered. `provision` creates a target session; it is its own operation with its own
 * three-state record, and payload deliveries to that target wait until it is sent (CR2_DELIVERY_FIX §3).
 * `system-notice` (C-31, T032 G-11 B): the GUI itself tells a session something it must know to go on, e.g.
 * root that the user approved its task list and which task IDs were created. It is never the user's words and
 * never a peer's: its origin is `system`, and it is delivered and reconciled like any payload.
 */
export type DeliveryKind = 'handoff' | 'peer-message' | 'transfer' | 'user-message' | 'system-notice' | 'provision';
export type PayloadKind = Exclude<DeliveryKind, 'provision'>;

/** Everything a restarted GUI needs to dispatch or reconcile a payload without other state. */
export interface PayloadContext {
  runtime: Runtime;
  /** The target session's original cwd: resume and Claude reconciliation need it (R-06, CR2 §4). */
  cwd: string;
  entry: DispatchEntry;
  /**
   * The target session's settings at acceptance, so a restarted GUI can resume it before dispatching
   * (`ResumeSessionOptions`) without any other store. Stored as is, so never the MCP mount (C-07).
   */
  session: SessionSettings & { mcp?: never };
  /**
   * Who the payload comes from (C-01), so a restarted GUI dispatches a pending peer or handoff payload with
   * its original origin (R-03: never as the user). Absent means the user; only `user-message` may omit it, and
   * a `system-notice` carries `{ kind: 'system' }`.
   */
  origin?: MessageOrigin;
}

/**
 * What a handoff is besides its payload (R-04 step 3, C-12): stored in the acceptance transaction, so the
 * handoff, its receive count and its delivery record can never disagree. `HandoffRepository` reads it back
 * as a `Handoff`.
 */
export interface HandoffMeta {
  handoffId: HandoffId;
  instanceId: InstanceId;
  taskId: TaskId;
  fromNodeId: NodeId;
  toNodeId: NodeId;
  fromSessionId: SessionId;
  ruleId: string;
  /**
   * Whether this handoff is rework (R-05, T064): it raises the task's rework count, the most times the task
   * came back to any one node in this instance. One loop counts once: plan → implement → review → implement →
   * review is one rework (the second implement; the second review adds nothing). Handoffs stored before T064
   * marked every return. Decided by the caller at acceptance, stored with the handoff
   * and shown as `Handoff.rework`; the same acceptance advances the task's rework count key, so the limit,
   * a restart (`WorkflowTask.reworkCount` is rebuilt from the handoffs) and the progress view agree.
   */
  rework: boolean;
  /** Fan-out round and the upstream set expected in it (CR-4); batch 4 always uses round 0 and no set. */
  round: number;
  expectedUpstream?: readonly NodeId[];
}

/** What a `send_message` is besides its payload (C-09): read back by `PeerMessageRepository`. */
export interface PeerMeta {
  peerMessageId: PeerMessageId;
  fromSessionId: SessionId;
  toSessionId: SessionId;
  /** Both sides in one workflow instance (start-time consent covers it, R-11). */
  instanceId?: InstanceId;
}

/**
 * One receive count checked and advanced in the acceptance transaction, once per operationId (R-04 step 3).
 * A handoff counts the target node's receipts of the task and, when it is rework (`HandoffMeta.rework`), the
 * task's rework (R-05); `limit` absent means count only.
 */
export interface ReceiveCount {
  key: string;
  limit?: number;
}

/** Everything needed to create the target session again after a restart. */
export interface ProvisionSpec extends SessionSettings {
  runtime: Runtime;
  sessionId: SessionId;
  cwd: string;
  /** Claude: the session UUID chosen before the call, so a lost create response can be reconciled. */
  preallocatedRef?: string;
  /**
   * Stored as is, so it must never carry the session's MCP token (C-07): spreading `StartSessionOptions`
   * into a spec does not compile. The mount is added when the spec is turned back into a start call.
   */
  mcp?: never;
}

interface StoredBase {
  operationId: OperationId;
  /** Native identity of the tool call that asked for it, to recognise a resend (CR2 §4). */
  sourceCallRef?: string;
  /** The GUI session that asked for it (C-08): a later `retryOf` is accepted only from the same session. */
  sender?: SessionId;
  payloadHash: PayloadHash;
  proposalRevision: Revision;
  target: DeliveryTarget;
  delivery: DeliveryRecord;
  acceptedAt: Timestamp;
  /** How the operation ended apart from delivery (C-05 of 0.4), set once by `recordOutcome`. */
  outcome?: OperationOutcome;
}

/** Kind-specific facts of a payload; `handoff` is set exactly for handoffs, `peer` for peer messages. */
interface PayloadMeta {
  handoff?: HandoffMeta;
  peer?: PeerMeta;
}

export type StoredDelivery =
  | (StoredBase & PayloadMeta & { kind: PayloadKind; payload: string; context: PayloadContext })
  /** For a provision, `delivery` tracks the create call; a sent attempt's nativeRef is the new session. */
  | (StoredBase & { kind: 'provision'; spec: ProvisionSpec });

interface AcceptBase {
  operationId: OperationId;
  sourceCallRef?: string;
  sender?: SessionId;
  payloadHash: PayloadHash;
  proposalRevision: Revision;
  target: DeliveryTarget;
  at: Timestamp;
  /**
   * Receive counting for handoffs (R-04, R-05): every count is checked first and all are advanced together
   * in the same transaction, once per operationId; when any is at its limit nothing is written.
   */
  counts?: readonly ReceiveCount[];
}

export type AcceptInput =
  /**
   * `handoff` is required for kind `handoff` and `peer` for `peer-message` (the store answers `invalid`
   * without them); a resend must repeat them unchanged, or it is a conflict.
   */
  | (AcceptBase & PayloadMeta & { kind: PayloadKind; payload: string; context: PayloadContext })
  | (AcceptBase & { kind: 'provision'; spec: ProvisionSpec });

/**
 * `sourceCallRef` is unique per runtime call (C-08): another operationId accepted with a `sourceCallRef`
 * already stored is a `conflict` with the operation that has it.
 */
export type AcceptResult =
  /** `counts`: each key's count after this acceptance, in the order given. */
  | { status: 'accepted'; record: StoredDelivery; counts?: { key: string; count: number }[] }
  /** Same operationId with the same payload, target and revision: nothing changes, nothing is counted. */
  | { status: 'duplicate'; record: StoredDelivery }
  /** Same operationId with a different payload, target, revision or kind: rejected (R-04 step 3). */
  | { status: 'conflict'; existing: StoredDelivery }
  /** The first count (in the order given) that is at its limit; nothing was written. */
  | { status: 'limit-exceeded'; key: string; count: number; limit: number }
  /** A handoff without its `handoff` facts, or a peer message without `peer` (a caller bug, never stored). */
  | { status: 'invalid'; detail: string };

export interface ClaimInput {
  operationId: OperationId;
  /** Re-checked inside the transaction (R-04 step 5). */
  expectedProposalRevision: Revision;
  /**
   * The bound native session, re-checked inside the transaction. Required for payloads (a payload whose
   * target is not bound yet gets `target-not-ready`); omitted for a provision, which creates the target.
   */
  expectedNativeSessionRef?: string;
  attemptId: AttemptId;
  clientMessageId: ClientMessageId;
  at: Timestamp;
}

/**
 * Only `claimed` may call the runtime (`dispatchOnce`, or the create call for a provision), and only after
 * this resolved: one conditional `pending → unknown` update decides the single caller.
 */
export type ClaimResult =
  | { status: 'claimed'; attempt: Extract<DispatchAttempt, { state: 'unknown' }> }
  | { status: 'not-found' | 'not-pending' | 'revision-changed' | 'target-changed' | 'target-not-ready' };

export type WriteResult = 'recorded' | 'stale';

export interface DeliveryStore {
  accept(input: AcceptInput): Promise<AcceptResult>;
  /**
   * Compare-and-set of the target binding (R-04 step 4): applied only while the delivery is still pending
   * and the stored target equals `expected`; otherwise `stale`. Used to bind a payload once its provision
   * is sent, so two writers cannot bind different targets.
   */
  updateTarget(operationId: OperationId, expected: DeliveryTarget, next: DeliveryTarget): Promise<WriteResult>;
  /** `pending → unknown` with a new attempt, as one conditional update (CR2_DELIVERY_FIX §1 step 3). */
  claim(input: ClaimInput): Promise<ClaimResult>;
  /** `unknown → sent`, only for this live attempt; `stale` when it no longer matches (CR2 §1 step 5). */
  recordSent(operationId: OperationId, attemptId: AttemptId, nativeRef: NativeRef, evidence: DeliveryEvidence): Promise<WriteResult>;
  /**
   * The user's decision on an unknown attempt (CR2_DELIVERY_FIX §2). `retry` abandons it and returns the
   * delivery to pending, keeping the attempt; the receive count does not change.
   */
  recordResolution(
    operationId: OperationId,
    attemptId: AttemptId,
    resolution: { decision: 'wait' | 'cancel' | 'retry'; at: Timestamp; note?: string },
  ): Promise<WriteResult>;
  /**
   * Records how the operation ended apart from delivery (C-05 of 0.4): once; a second call with another
   * outcome is `stale`. The delivery record is not touched (a later reconcile as sent is still recorded).
   */
  recordOutcome(operationId: OperationId, outcome: OperationOutcome): Promise<WriteResult>;
  get(operationId: OperationId): Promise<StoredDelivery | undefined>;
  /**
   * The operation a tool call with this native identity created (C-08), so a resend after a GUI restart is
   * recognised (CR2 §4). Identities are unique per runtime call; `undefined` when none.
   */
  findBySourceCallRef(sourceCallRef: string): Promise<StoredDelivery | undefined>;
  /**
   * For recovery after a restart: pending ones go through `claim` again; unknown ones are only reconciled.
   * Records carry their context or spec, so nothing else is needed to do either.
   */
  listByState(state: DeliveryRecord['state']): Promise<StoredDelivery[]>;
  /**
   * The records whose current target is this GUI session (C-20): payloads bound or waiting for it, and the
   * provision creating it. In acceptance order. Answers "does this session have work in flight" without
   * reading every record.
   */
  listByTarget(sessionId: SessionId): Promise<StoredDelivery[]>;
}

/** The store could not confirm its commit; treat the operation as not done and do not call the runtime. */
export class CommitUncertainError extends Error {
  override name = 'CommitUncertainError';
}
