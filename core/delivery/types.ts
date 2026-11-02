// Inputs and outcomes of the CR-2 delivery service (T008). Nothing here is persisted: the durable side is
// the DeliveryStore port, and these types only say what one call did.
import type {
  AttemptId,
  ClientMessageId,
  DeliveryEvidence,
  DeliveryState,
  DeliveryTarget,
  MessageOrigin,
  NativeRef,
  OperationId,
  PayloadHash,
  Runtime,
  Timestamp,
} from '../../contracts';
import type {
  AcceptResult,
  ClaimResult,
  DeliveryKind,
  DeliveryStore,
  DispatchEntry,
  DispatchResult,
  PayloadKind,
  ReconcileMatch,
  ReconcileResult,
  RuntimeAdapter,
  StoredDelivery,
} from '../ports';

export type PayloadDelivery = Extract<StoredDelivery, { kind: PayloadKind }>;
export type ProvisionDelivery = Extract<StoredDelivery, { kind: 'provision' }>;

export interface DeliveryServiceOptions {
  store: DeliveryStore;
  /** The adapter for each runtime; a delivery for a runtime without one is not dispatched. */
  runtimes: Partial<Record<Runtime, RuntimeAdapter>>;
  now(): Timestamp;
  /** A fresh UUID per call, for attempt and client message IDs (core has no crypto). */
  uuid(): string;
  /** `sha256:<hex>` of a payload's text; acceptance checks the given hash against it. */
  hashPayload(text: string): PayloadHash | Promise<PayloadHash>;
  /**
   * Makes sure the payload's target session is open in its adapter (e.g. resumes it from the record's
   * `context.session` after a restart). Runs before the claim, so a failure leaves the delivery pending.
   */
  prepareTarget?(record: PayloadDelivery): Promise<void>;
  /**
   * Receives every `delivery-unknown` item for the user (R-05: the root AI never decides). The same
   * unknown attempt can be reported again on a later reconcile; `key` is stable per attempt so the layer
   * above keeps one open escalation. It should not throw; a throw reaches the caller of the service call.
   */
  onEscalation?(item: DeliveryEscalation): void;
  /** Default for `DispatchOptions.timeoutMs`. */
  dispatchTimeoutMs?: number;
}

export type AcceptOutcome =
  | Exclude<AcceptResult, { status: 'invalid' }>
  /**
   * Rejected before the store: the hash does not match the payload, the target contradicts itself, or the
   * input carries an MCP mount that must never be stored (C-07).
   */
  | { status: 'invalid'; issues: string[] }
  /** The store could not confirm its commit. Accept again with the same operationId to find out. */
  | { status: 'commit-uncertain'; detail: string };

/**
 * One dispatch call's own record (T046 r4): what preparing its target threw, when it did. Written for this call alone,
 * so its caller reads why its own call did not go, never another call's to the same delivery or session.
 */
export interface DispatchCall {
  prepareError?: unknown;
}

export interface DispatchOptions {
  /**
   * How the payload enters the target session, chosen by the caller (idle: new turn; busy peer message:
   * insert). Defaults to the entry stored at acceptance. Ignored for a provision.
   */
  entry?: DispatchEntry;
  /** The currently confirmed proposal revision, re-checked by the claim; defaults to the accepted one. */
  expectedProposalRevision?: number;
  /** The caller's view of the bound native session, re-checked by the claim; defaults to the stored one. */
  expectedNativeSessionRef?: string;
  timeoutMs?: number;
  /**
   * Who the payload comes from, handed to the adapter as `DispatchRequest.origin` (R-03: peer and handoff
   * payloads are marked as not from the user). Absent means the user. Ignored for a provision.
   */
  origin?: MessageOrigin;
  /** Filled in when the target's preparation fails in this call (see DispatchCall). */
  call?: DispatchCall;
}

/** Why the runtime was not called. The delivery is unchanged unless `commit-uncertain` says otherwise. */
export type NotDispatchedReason =
  | Exclude<ClaimResult['status'], 'claimed'>
  /** A payload whose provision is not sent: it waits; it is never sent to a guessed target (CR2 §3). */
  | 'provision-not-sent'
  /**
   * The user cancelled the payload's provision. The payload stays pending (contracts keep cancel out of
   * the delivery states) and is never dispatched; the layer above records the operation as cancelled.
   */
  | 'provision-cancelled'
  | 'no-runtime'
  /**
   * The origin chosen for this dispatch does not fit the delivery (T020 r2 P1): only a user message is the
   * user's, and a user message is nobody else's. Nothing crossed the boundary.
   */
  | 'origin-mismatch'
  | 'prepare-failed'
  /** A claim or binding write whose commit could not be confirmed; recovery reconciles if it applied. */
  | 'commit-uncertain'
  /** A store write failed before committing. */
  | 'store-failed';

/** Why an attempt that crossed the dispatch boundary has no evidence. */
export interface DispatchFailure {
  reason:
    | Extract<DispatchResult, { state: 'unknown' }>['reason']
    /** The adapter threw instead of answering. */
    | 'adapter-error'
    /** The runtime accepted it, but writing `sent` failed. */
    | 'record-failed'
    /** The store refused the evidence (another target, or the attempt is no longer live). */
    | 'evidence-rejected';
  /** The adapter's word on whether the payload left this process; absent when it did not say. */
  written?: boolean;
  detail: string;
}

export type DispatchOutcome =
  | { status: 'sent'; attemptId: AttemptId; nativeRef: NativeRef; evidence: DeliveryEvidence }
  /**
   * Crossed the boundary without evidence and the read-only reconcile right after did not find it. Never
   * resent; `escalation` is absent only when the attempt was resolved meanwhile or the store could not
   * be read (recovery escalates it then).
   */
  | { status: 'unknown'; attemptId: AttemptId; failure: DispatchFailure; escalation?: DeliveryEscalation }
  | { status: 'not-dispatched'; reason: NotDispatchedReason; detail: string; provisionState?: DeliveryState };

/** Why an unknown attempt is still unknown after reconciling. */
export type UnknownReason =
  | Extract<ReconcileResult, { state: 'unknown' }>['reason']
  | 'no-runtime'
  | 'record-failed'
  | 'evidence-rejected'
  /** A target creation has no read-only proof through the runtime port; the user decides (CR2 §3). */
  | 'provision-unverifiable';

/**
 * A `delivery-unknown` item for the user (contracts `EscalationKind`). The layer above maps it to an
 * `Escalation` pointing at its handoff, peer message or transfer, and answers it with `resolve`.
 */
export interface DeliveryEscalation {
  kind: 'delivery-unknown';
  /** `${operationId}/${attemptId}`: the same unknown attempt always gives the same key. */
  key: string;
  operationId: OperationId;
  deliveryKind: DeliveryKind;
  attemptId: AttemptId;
  clientMessageId: ClientMessageId;
  dispatchStartedAt: Timestamp;
  target: DeliveryTarget;
  reason: UnknownReason;
  detail: string;
  /** What the runtime's stored history showed for this clientMessageId. */
  matches: ReconcileMatch[];
  /** How the dispatch call in this process ended, when this process made it. */
  failure?: DispatchFailure;
  /**
   * What the UI must say about a retry (CR2 §2): `suspected` when the history holds the ID twice,
   * `unlikely` when the adapter said the payload never left this process, otherwise `possible`.
   */
  duplicateRisk: 'suspected' | 'possible' | 'unlikely';
  /** For a provision: the payloads waiting for it. */
  blocked?: OperationId[];
  /** The user's earlier decision on this attempt, if any. */
  decision?: 'wait' | 'cancel';
  at: Timestamp;
}

export type ReconcileOutcome =
  | { status: 'sent'; attemptId: AttemptId; nativeRef: NativeRef; evidence: DeliveryEvidence }
  | { status: 'unknown'; escalation: DeliveryEscalation }
  /** Nothing to reconcile: no such delivery, not unknown, or not this attempt any more. */
  | { status: 'not-unknown'; state?: DeliveryState }
  /** This process is still inside the attempt's runtime call; reconcile after it returns. */
  | { status: 'in-flight' };

/** The user's answer to a `delivery-unknown` item (contracts `delivery.resolve`). */
export interface ResolveInput {
  operationId: OperationId;
  attemptId: AttemptId;
  decision: 'wait' | 'cancel' | 'retry';
  /** Required for a retry: it may deliver twice. */
  acceptDuplicateRisk: boolean;
  note?: string;
}

export type ResolveOutcome =
  /** For a retry the delivery is pending again; the next `dispatch` makes a new attempt. */
  | { status: 'recorded'; decision: ResolveInput['decision'] }
  /** Not the live unknown attempt any more (reconciled, or already retried). */
  | { status: 'stale' }
  /** `in-flight`: a retry while this process is still inside the attempt's runtime call (wait / cancel are recorded). */
  | { status: 'refused'; reason: 'duplicate-risk-not-accepted' | 'in-flight' }
  | { status: 'commit-uncertain'; detail: string };

export interface RecoveryReport {
  /** Unknown at restart: reconciled only, never dispatched. */
  reconciled: { operationId: OperationId; outcome: ReconcileOutcome }[];
  /** Pending at restart: through the same dispatch entry (provisions first). */
  dispatched: { operationId: OperationId; outcome: DispatchOutcome }[];
  /** Calls that threw (e.g. the store failed); those deliveries are as the store left them. */
  failed: { operationId: OperationId; detail: string }[];
}

export interface RecoverOptions {
  /** Per pending delivery: how to dispatch it, or `skip` to leave it for the caller's own schedule. */
  select?(record: StoredDelivery): DispatchOptions | 'skip';
}
