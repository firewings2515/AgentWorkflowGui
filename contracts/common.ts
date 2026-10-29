// Shared primitives for every contract module. IDs are branded strings so they cannot be mixed up
// (HC-03: session ID, native thread ID, task ID and node ID are never interchangeable).
import { z } from 'zod';

/** Bump on any breaking change; contract changes go through the main session. */
export const CONTRACTS_VERSION = '0.5.0';

/**
 * Carried by every serialized boundary (Snapshot, event envelope, saved definitions) so stored data
 * says which contract version wrote it. Readers that migrate old data check this before parsing.
 */
export const SchemaVersion = z.literal(CONTRACTS_VERSION);

const id = <B extends string>() => z.string().min(1).brand<B>();

export const SessionId = id<'SessionId'>();
export const TurnId = id<'TurnId'>();
export const MessageId = id<'MessageId'>();
export const ItemId = id<'ItemId'>();
export const AgentId = id<'AgentId'>();
export const WorkflowId = id<'WorkflowId'>();
export const NodeId = id<'NodeId'>();
export const InstanceId = id<'InstanceId'>();
export const TaskId = id<'TaskId'>();
export const HandoffId = id<'HandoffId'>();
export const PeerMessageId = id<'PeerMessageId'>();
export const EscalationId = id<'EscalationId'>();
export const TransferId = id<'TransferId'>();
export const NativeTaskId = id<'NativeTaskId'>();
export const PermissionRequestId = id<'PermissionRequestId'>();
export const ArtifactId = id<'ArtifactId'>();
export const RequestId = id<'RequestId'>();
/** Logical operation fixed when a handoff / message / transfer is accepted; reused by every retry (CR-2). */
export const OperationId = id<'OperationId'>();
/** One crossing of the dispatch boundary (CR-2). */
export const AttemptId = id<'AttemptId'>();
/**
 * Per-attempt UUID sent to the runtime (Codex `clientUserMessageId`, Claude `SDKUserMessage.uuid`) and
 * used to reconcile. It is a reconciliation key, not a proven idempotency key (CR2_DELIVERY_FIX §4).
 */
export const ClientMessageId = z.uuid().brand<'ClientMessageId'>();

export type SessionId = z.infer<typeof SessionId>;
export type TurnId = z.infer<typeof TurnId>;
export type MessageId = z.infer<typeof MessageId>;
export type ItemId = z.infer<typeof ItemId>;
export type AgentId = z.infer<typeof AgentId>;
export type WorkflowId = z.infer<typeof WorkflowId>;
export type NodeId = z.infer<typeof NodeId>;
export type InstanceId = z.infer<typeof InstanceId>;
export type TaskId = z.infer<typeof TaskId>;
export type HandoffId = z.infer<typeof HandoffId>;
export type PeerMessageId = z.infer<typeof PeerMessageId>;
export type EscalationId = z.infer<typeof EscalationId>;
export type TransferId = z.infer<typeof TransferId>;
export type NativeTaskId = z.infer<typeof NativeTaskId>;
export type PermissionRequestId = z.infer<typeof PermissionRequestId>;
export type ArtifactId = z.infer<typeof ArtifactId>;
export type RequestId = z.infer<typeof RequestId>;
export type OperationId = z.infer<typeof OperationId>;
export type AttemptId = z.infer<typeof AttemptId>;
export type ClientMessageId = z.infer<typeof ClientMessageId>;

/** ISO-8601 timestamp with offset, e.g. `2026-10-24T13:50:00+08:00`. */
export const Timestamp = z.iso.datetime({ offset: true });
export type Timestamp = z.infer<typeof Timestamp>;

/** The two runtimes v1 must support (R-01). */
export const Runtime = z.enum(['claude', 'codex']);
export type Runtime = z.infer<typeof Runtime>;

/** Monotonic revision used for optimistic concurrency on editable records (DATA_RUNTIME §1). */
export const Revision = z.number().int().nonnegative();

/** Content hash of a fixed payload snapshot (R-04 step 3, CR-2). */
export const PayloadHash = z.string().regex(/^sha256:[0-9a-f]{64}$/);

// Inferred types for schemas that are not typed next to their definition.
export type SchemaVersion = z.infer<typeof SchemaVersion>;
export type Revision = z.infer<typeof Revision>;
export type PayloadHash = z.infer<typeof PayloadHash>;
