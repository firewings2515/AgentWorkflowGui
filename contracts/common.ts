// Shared primitives for every contract module. IDs are branded strings so they cannot be mixed up
// (HC-03: session ID, native thread ID, task ID and node ID are never interchangeable).
import { z } from 'zod';

const id = <B extends string>() => z.string().min(1).brand<B>();

export const SessionId = id<'SessionId'>();
export const TurnId = id<'TurnId'>();
export const MessageId = id<'MessageId'>();
export const AgentId = id<'AgentId'>();
export const WorkflowId = id<'WorkflowId'>();
export const NodeId = id<'NodeId'>();
export const InstanceId = id<'InstanceId'>();
export const TaskId = id<'TaskId'>();
export const HandoffId = id<'HandoffId'>();
export const EscalationId = id<'EscalationId'>();
export const TransferId = id<'TransferId'>();
export const NativeTaskId = id<'NativeTaskId'>();
export const RequestId = id<'RequestId'>();

export type SessionId = z.infer<typeof SessionId>;
export type TurnId = z.infer<typeof TurnId>;
export type MessageId = z.infer<typeof MessageId>;
export type AgentId = z.infer<typeof AgentId>;
export type WorkflowId = z.infer<typeof WorkflowId>;
export type NodeId = z.infer<typeof NodeId>;
export type InstanceId = z.infer<typeof InstanceId>;
export type TaskId = z.infer<typeof TaskId>;
export type HandoffId = z.infer<typeof HandoffId>;
export type EscalationId = z.infer<typeof EscalationId>;
export type TransferId = z.infer<typeof TransferId>;
export type NativeTaskId = z.infer<typeof NativeTaskId>;
export type RequestId = z.infer<typeof RequestId>;

/** ISO-8601 timestamp with offset, e.g. `2026-10-24T13:50:00+08:00`. */
export const Timestamp = z.iso.datetime({ offset: true });
export type Timestamp = z.infer<typeof Timestamp>;

/** The two runtimes v1 must support (R-01). */
export const Runtime = z.enum(['claude', 'codex']);
export type Runtime = z.infer<typeof Runtime>;

/** Monotonic revision used for optimistic concurrency on editable records (DATA_RUNTIME §1). */
export const Revision = z.number().int().nonnegative();
