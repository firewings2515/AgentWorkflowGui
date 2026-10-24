// Workflow templates, instances, tasks, handoffs and escalations (R-04, R-05, R-06).
import { z } from 'zod';
import { ModelSelection } from './agent';
import { AgentId, EscalationId, HandoffId, InstanceId, NodeId, Revision, SessionId, TaskId, Timestamp, WorkflowId } from './common';

/** Input rule: natural-language condition for the AI, plus the only fields the GUI enforces (R-04). */
export const InputRule = z.strictObject({
  id: z.string().min(1),
  condition: z.string().min(1),
  /** Max accepted handoffs for the same task (counted by the GUI). */
  acceptanceLimit: z.number().int().positive().optional(),
  /** Wait for every upstream sent in this round before starting (R-04, CR-4). */
  waitForAllUpstream: z.boolean().default(false),
});

/** Output rule: when / what / to whom. `target: 'root'` reports to the root session (R-05). */
export const OutputRule = z.strictObject({
  id: z.string().min(1),
  condition: z.string().min(1),
  payload: z.string(),
  target: z.union([NodeId, z.literal('root')]),
  /** Ask the user (through root) before handing off. */
  requiresUserConfirmation: z.boolean().default(false),
});

export const NodeKind = z.enum(['agent', 'merge']);
export const WritePolicy = z.enum(['write', 'read-only', 'exec-only']);

export const WorkflowNode = z.strictObject({
  id: NodeId,
  kind: NodeKind,
  label: z.string().min(1),
  /** Agent nodes only; merge nodes are run by the GUI (R-06). */
  agentId: AgentId.optional(),
  model: ModelSelection.optional(),
  writePolicy: WritePolicy,
  concurrency: z.number().int().positive().default(1),
  isRoot: z.boolean().default(false),
  inputRules: z.array(InputRule),
  outputRules: z.array(OutputRule),
  /** Canvas position for the drag-to-build editor (R-09); not used for execution. */
  position: z.strictObject({ x: z.number(), y: z.number() }),
});
export type WorkflowNode = z.infer<typeof WorkflowNode>;

/** Edges carry no conditions: they only mean "handoff allowed" (R-04). */
export const WorkflowEdge = z.strictObject({ source: NodeId, target: NodeId });

export const WorkflowTemplate = z.strictObject({
  id: WorkflowId,
  revision: Revision,
  name: z.string().min(1),
  description: z.string(),
  reworkLimit: z.number().int().nonnegative(),
  isolation: z.enum(['worktree', 'same-folder']),
  nodes: z.array(WorkflowNode).min(1),
  edges: z.array(WorkflowEdge),
  updatedAt: Timestamp,
});
export type WorkflowTemplate = z.infer<typeof WorkflowTemplate>;

export const TaskStatus = z.enum(['pending', 'running', 'blocked', 'awaiting-merge', 'merging', 'merged', 'failed', 'cancelled']);

/** A unit of parallel work inside an instance (R-06). Dependents start only after this task is merged. */
export const WorkflowTask = z.strictObject({
  id: TaskId,
  instanceId: InstanceId,
  title: z.string().min(1),
  dependsOn: z.array(TaskId),
  status: TaskStatus,
  currentNodeId: NodeId.optional(),
  worktree: z.strictObject({ path: z.string().min(1), branch: z.string().min(1) }).optional(),
  reworkCount: z.number().int().nonnegative(),
});
export type WorkflowTask = z.infer<typeof WorkflowTask>;

/** One run of a template (WF-05). Pinned to the template revision it started with. */
export const WorkflowInstance = z.strictObject({
  id: InstanceId,
  workflowId: WorkflowId,
  workflowRevision: Revision,
  title: z.string().min(1),
  rootSessionId: SessionId,
  state: z.enum(['running', 'blocked', 'completed', 'cancelled']),
  /** Consent to cross-tool handoffs between this instance's nodes, recorded at start (R-11). */
  crossToolConsentAt: Timestamp.optional(),
  tasks: z.array(WorkflowTask),
  createdAt: Timestamp,
});
export type WorkflowInstance = z.infer<typeof WorkflowInstance>;

/** Minimal delivery states (CR-2). `unknown` is never auto-resent; it is reconciled or escalated. */
export const DeliveryState = z.enum(['pending', 'sent', 'unknown']);
export type DeliveryState = z.infer<typeof DeliveryState>;

/** Runtime-side reference recorded once a delivery is acknowledged (CR-2). */
export const RuntimeRef = z.strictObject({
  sessionRef: z.string().min(1),
  turnRef: z.string().min(1).optional(),
});

export const Handoff = z.strictObject({
  id: HandoffId,
  operationId: z.string().min(1),
  instanceId: InstanceId,
  taskId: TaskId,
  fromNodeId: NodeId,
  toNodeId: NodeId,
  ruleId: z.string().min(1),
  /** Fan-out round and the upstream set expected in it (CR-4). */
  round: z.number().int().nonnegative(),
  expectedUpstream: z.array(NodeId).optional(),
  delivery: DeliveryState,
  runtimeRef: RuntimeRef.optional(),
  createdAt: Timestamp,
});
export type Handoff = z.infer<typeof Handoff>;

/** Something the root session must show the user (R-05). */
export const EscalationKind = z.enum(['confirmation', 'permission', 'limit-exceeded', 'no-rule-matched', 'setup-failed', 'merge-failed', 'delivery-unknown']);

export const Escalation = z.strictObject({
  id: EscalationId,
  instanceId: InstanceId.optional(),
  rootSessionId: SessionId,
  fromSessionId: SessionId,
  kind: EscalationKind,
  title: z.string().min(1),
  detail: z.string(),
  /** For `permission`: the escalation-list rule that matched (R-08). */
  rule: z.string().optional(),
  state: z.enum(['open', 'approved', 'declined', 'resolved']),
  createdAt: Timestamp,
  resolvedAt: Timestamp.optional(),
});
export type Escalation = z.infer<typeof Escalation>;
