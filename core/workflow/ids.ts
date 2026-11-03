// Fixed IDs of a workflow run, so a repeat (a renderer resending `workflow.start`, a restart, a resend of
// the same tool call) finds what the first one made instead of making it again.
import { EscalationId, HandoffId, type InstanceId, MessageId, type NodeId, type OperationId, OperationId as OperationIdSchema, PeerMessageId, TaskId, type WorkflowId } from '../../contracts';

/** Batch 4 runs one task per instance (BATCH4_PLAN): its ID follows from the instance. */
export const taskIdOf = (instanceId: InstanceId): TaskId => TaskId.parse(`${instanceId}:task`);
export const firstMessageIdOf = (instanceId: InstanceId): MessageId => MessageId.parse(`${instanceId}:first`);
/** The session service's name for a user message's delivery (`user-message:<messageId>`). */
export const firstMessageOperationOf = (messageId: MessageId): OperationId => OperationIdSchema.parse(`user-message:${messageId}`);
/**
 * The identity of the start that asked for the first message (r2-P1-4, r3-P1-1): every part of it no other
 * field of that delivery keeps, the instance first. The root node and the rework limit follow from the
 * workflow and its revision; they are kept as well, so the identity says which graph and limit it agreed to.
 */
export interface StartIdentity {
  instanceId: InstanceId;
  workflowId: WorkflowId;
  rootNodeId: NodeId;
  reworkLimit: number;
  title: string;
  crossToolConsent: boolean;
  /**
   * The run's folders (T048): set by every 0.8 start, the project folder in it when given. Absent: the identity a start
   * written before 0.8 had (six parts), so such a start is still recognised when it is sent again (r1 P1-5).
   */
  folders?: { projectFolder?: string };
}
const START = 'workflow.start:';
export const startRefOf = (s: StartIdentity): string =>
  `${START}${JSON.stringify([
    s.instanceId,
    s.workflowId,
    s.rootNodeId,
    s.reworkLimit,
    s.title,
    s.crossToolConsent,
    ...(s.folders !== undefined ? [s.folders.projectFolder !== undefined ? { projectFolder: s.folders.projectFolder } : {}] : []),
  ])}`;
/** A start written before 0.8 (T048 r1 P1-5): its identity has no folders part. */
export const isPre08StartRef = (sourceCallRef: string | undefined): boolean => {
  if (sourceCallRef?.startsWith(START) !== true) return false;
  try {
    const parsed: unknown = JSON.parse(sourceCallRef.slice(START.length));
    return Array.isArray(parsed) && parsed.length === 6;
  } catch {
    return false;
  }
};
/** The instance a first message's delivery was accepted for; undefined for any other delivery. */
export const startInstanceOf = (sourceCallRef: string | undefined): InstanceId | undefined => {
  if (sourceCallRef?.startsWith(START) !== true) return undefined;
  try {
    const parsed: unknown = JSON.parse(sourceCallRef.slice(START.length));
    return Array.isArray(parsed) && typeof parsed[0] === 'string' ? (parsed[0] as InstanceId) : undefined;
  } catch {
    return undefined;
  }
};
export const handoffIdOf = (operationId: OperationId): HandoffId => HandoffId.parse(`handoff-${operationId}`);
/** The same naming as the session service's peer messages, so their escalations point at the same ID. */
export const peerIdOf = (operationId: OperationId): PeerMessageId => PeerMessageId.parse(`peer-${operationId}`);
export const handoffConfirmationId = (operationId: OperationId): EscalationId => EscalationId.parse(`wf-confirm:${operationId}`);
export const reportConfirmationId = (operationId: OperationId): EscalationId => EscalationId.parse(`wf-report:${operationId}`);
/** One open escalation per limit key or per (task, node) without a matching rule; a later one gets a suffix. */
export const limitEscalationBase = (key: string): string => `wf-limit:${key}`;
/** One escalation per blocked round (CR-4), so a restart between blocking it and opening the question finds the same one. */
export const roundEscalationId = (instanceId: InstanceId, taskId: TaskId, nodeId: NodeId, round: number): EscalationId =>
  EscalationId.parse(`wf-round:${JSON.stringify([instanceId, taskId, nodeId, round])}`);
export const noRuleEscalationBase =(instanceId: InstanceId, taskId: TaskId, nodeId: string): string => `wf-no-rule:${JSON.stringify([instanceId, taskId, nodeId])}`;
