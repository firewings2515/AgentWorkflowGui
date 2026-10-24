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
  Timestamp,
} from '../../contracts';

/** What is being delivered. `provision` creates a target session (CR2_DELIVERY_FIX §3). */
export type DeliveryKind = 'handoff' | 'peer-message' | 'transfer' | 'user-message' | 'provision';

export interface StoredDelivery {
  operationId: OperationId;
  kind: DeliveryKind;
  /** Native identity of the tool call that asked for it, to recognise a resend (CR2 §4). */
  sourceCallRef?: string;
  payload: string;
  payloadHash: PayloadHash;
  proposalRevision: Revision;
  target: DeliveryTarget;
  delivery: DeliveryRecord;
  acceptedAt: Timestamp;
}

export interface AcceptInput {
  operationId: OperationId;
  kind: DeliveryKind;
  sourceCallRef?: string;
  payload: string;
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

export type AcceptResult =
  | { status: 'accepted'; record: StoredDelivery; count?: number }
  /** Same operationId with the same payload, target and revision: nothing changes, nothing is counted. */
  | { status: 'duplicate'; record: StoredDelivery }
  /** Same operationId with a different payload, target or revision: rejected (R-04 step 3). */
  | { status: 'conflict'; existing: StoredDelivery }
  | { status: 'limit-exceeded'; count: number; limit: number };

export interface ClaimInput {
  operationId: OperationId;
  /** Re-checked inside the transaction (R-04 step 5). */
  expectedProposalRevision: Revision;
  expectedNativeSessionRef: string;
  attemptId: AttemptId;
  clientMessageId: ClientMessageId;
  at: Timestamp;
}

/** Only `claimed` may call the runtime, and only after this resolved (the commit is confirmed). */
export type ClaimResult =
  | { status: 'claimed'; attempt: Extract<DispatchAttempt, { state: 'unknown' }> }
  | { status: 'not-found' | 'not-pending' | 'revision-changed' | 'target-changed' | 'target-not-ready' };

export type WriteResult = 'recorded' | 'stale';

export interface DeliveryStore {
  accept(input: AcceptInput): Promise<AcceptResult>;
  /** Persists the target binding or provision progress before any dispatch (R-04 step 4). */
  updateTarget(operationId: OperationId, target: DeliveryTarget): Promise<WriteResult>;
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
  /** For recovery after a restart: pending ones go through `claim` again; unknown ones are only reconciled. */
  listByState(state: DeliveryRecord['state']): Promise<StoredDelivery[]>;
}

/** The store could not confirm its commit; treat the operation as not done and do not call the runtime. */
export class CommitUncertainError extends Error {
  override name = 'CommitUncertainError';
}
