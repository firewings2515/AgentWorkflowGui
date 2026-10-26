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
  NativeRef,
  OperationId,
  PayloadHash,
  Revision,
  Runtime,
  SessionId,
  Timestamp,
} from '../../contracts';
import type { DispatchEntry, SessionSettings } from './runtime';

/**
 * What is being delivered. `provision` creates a target session; it is its own operation with its own
 * three-state record, and payload deliveries to that target wait until it is sent (CR2_DELIVERY_FIX §3).
 */
export type DeliveryKind = 'handoff' | 'peer-message' | 'transfer' | 'user-message' | 'provision';
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
  payloadHash: PayloadHash;
  proposalRevision: Revision;
  target: DeliveryTarget;
  delivery: DeliveryRecord;
  acceptedAt: Timestamp;
}

export type StoredDelivery =
  | (StoredBase & { kind: PayloadKind; payload: string; context: PayloadContext })
  /** For a provision, `delivery` tracks the create call; a sent attempt's nativeRef is the new session. */
  | (StoredBase & { kind: 'provision'; spec: ProvisionSpec });

interface AcceptBase {
  operationId: OperationId;
  sourceCallRef?: string;
  payloadHash: PayloadHash;
  proposalRevision: Revision;
  target: DeliveryTarget;
  at: Timestamp;
  /**
   * Receive counting for handoffs (R-04): the key (instance, task, target node) and its limit. Counted in
   * the same transaction, once per operationId.
   */
  count?: { key: string; limit?: number };
}

export type AcceptInput =
  | (AcceptBase & { kind: PayloadKind; payload: string; context: PayloadContext })
  | (AcceptBase & { kind: 'provision'; spec: ProvisionSpec });

export type AcceptResult =
  | { status: 'accepted'; record: StoredDelivery; count?: number }
  /** Same operationId with the same payload, target and revision: nothing changes, nothing is counted. */
  | { status: 'duplicate'; record: StoredDelivery }
  /** Same operationId with a different payload, target, revision or kind: rejected (R-04 step 3). */
  | { status: 'conflict'; existing: StoredDelivery }
  | { status: 'limit-exceeded'; count: number; limit: number };

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
  get(operationId: OperationId): Promise<StoredDelivery | undefined>;
  /**
   * For recovery after a restart: pending ones go through `claim` again; unknown ones are only reconciled.
   * Records carry their context or spec, so nothing else is needed to do either.
   */
  listByState(state: DeliveryRecord['state']): Promise<StoredDelivery[]>;
}

/** The store could not confirm its commit; treat the operation as not done and do not call the runtime. */
export class CommitUncertainError extends Error {
  override name = 'CommitUncertainError';
}
