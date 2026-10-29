// Fixed IDs of a workflow run, so a repeat (a renderer resending `workflow.start`, a restart, a resend of
// the same tool call) finds what the first one made instead of making it again.
import { EscalationId, HandoffId, type InstanceId, MessageId, type OperationId, OperationId as OperationIdSchema, PeerMessageId, TaskId } from '../../contracts';

/** Batch 4 runs one task per instance (BATCH4_PLAN): its ID follows from the instance. */
export const taskIdOf = (instanceId: InstanceId): TaskId => TaskId.parse(`${instanceId}:task`);
export const firstMessageIdOf = (instanceId: InstanceId): MessageId => MessageId.parse(`${instanceId}:first`);
/** The session service's name for a user message's delivery (`user-message:<messageId>`). */
export const firstMessageOperationOf = (messageId: MessageId): OperationId => OperationIdSchema.parse(`user-message:${messageId}`);
/** The identity of the start that asked for the first message: the parts of it no other record keeps. */
export const startRefOf = (instanceId: InstanceId, title: string, crossToolConsent: boolean): string => `workflow.start:${JSON.stringify([instanceId, title, crossToolConsent])}`;
export const handoffIdOf = (operationId: OperationId): HandoffId => HandoffId.parse(`handoff-${operationId}`);
/** The same naming as the session service's peer messages, so their escalations point at the same ID. */
export const peerIdOf = (operationId: OperationId): PeerMessageId => PeerMessageId.parse(`peer-${operationId}`);
export const handoffConfirmationId = (operationId: OperationId): EscalationId => EscalationId.parse(`wf-confirm:${operationId}`);
export const reportConfirmationId = (operationId: OperationId): EscalationId => EscalationId.parse(`wf-report:${operationId}`);
/** One open escalation per limit key or per (task, node) without a matching rule; a later one gets a suffix. */
export const limitEscalationBase = (key: string): string => `wf-limit:${key}`;
export const noRuleEscalationBase = (instanceId: InstanceId, taskId: TaskId, nodeId: string): string => `wf-no-rule:${JSON.stringify([instanceId, taskId, nodeId])}`;
