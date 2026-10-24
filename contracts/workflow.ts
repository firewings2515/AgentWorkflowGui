// Workflow templates, instances, tasks, handoffs and escalations (R-04, R-05, R-06).
import { z } from 'zod';
import { ModelSelection } from './agent';
import {
  AgentId,
  EscalationId,
  HandoffId,
  InstanceId,
  NodeId,
  OperationId,
  PayloadHash,
  PeerMessageId,
  PermissionRequestId,
  Revision,
  SchemaVersion,
  SessionId,
  TaskId,
  Timestamp,
  TransferId,
  WorkflowId,
} from './common';
import { DeliveryRecord, ProvisionRecord, deliveryNeedsBoundTarget } from './delivery';

/** Input rule: natural-language condition for the AI, plus the only fields the GUI enforces (R-04). */
export const InputRule = z.strictObject({
  id: z.string().min(1),
  condition: z.string().min(1),
  /** Max accepted handoffs for the same task (counted by the GUI). */
  acceptanceLimit: z.number().int().positive().optional(),
  /** Wait for every upstream sent in this round before starting (R-04, CR-4). */
  waitForAllUpstream: z.boolean().default(false),
});

/** Where an output rule sends: a node, or "report to root" (R-05). Tagged so no node ID can collide with root. */
export const OutputTarget = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('node'), nodeId: NodeId }),
  z.strictObject({ kind: z.literal('root') }),
]);
export type OutputTarget = z.infer<typeof OutputTarget>;

/** Output rule: when / what / to whom (R-04). */
export const OutputRule = z.strictObject({
  id: z.string().min(1),
  condition: z.string().min(1),
  payload: z.string(),
  target: OutputTarget,
  /** Ask the user (through root) before handing off. */
  requiresUserConfirmation: z.boolean().default(false),
});

export const NodeKind = z.enum(['agent', 'merge']);
export const WritePolicy = z.enum(['write', 'read-only', 'exec-only']);

export const WorkflowNode = z
  .strictObject({
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
  })
  .refine((n) => (n.kind === 'agent' ? n.agentId !== undefined && n.model !== undefined : n.agentId === undefined && n.model === undefined), {
    message: 'agent nodes have an agent and a model; merge nodes have neither',
  })
  .refine((n) => !(n.isRoot && n.kind === 'merge'), { message: 'the root is an agent node' });
export type WorkflowNode = z.infer<typeof WorkflowNode>;

/** Edges carry no conditions: they only mean "handoff allowed" (R-04). */
export const WorkflowEdge = z.strictObject({ source: NodeId, target: NodeId });

export const WorkflowTemplate = z
  .strictObject({
    schemaVersion: SchemaVersion,
    id: WorkflowId,
    revision: Revision,
    name: z.string().min(1),
    description: z.string(),
    reworkLimit: z.number().int().nonnegative(),
    isolation: z.enum(['worktree', 'same-folder']),
    nodes: z.array(WorkflowNode).min(1),
    edges: z.array(WorkflowEdge),
    updatedAt: Timestamp,
  })
  .superRefine((w, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    const ids = new Set<string>(w.nodes.map((n) => n.id));
    if (ids.size !== w.nodes.length) fail('node IDs must be unique');
    if (w.nodes.filter((n) => n.isRoot).length !== 1) fail('exactly one node is the root');
    const edges = new Set(w.edges.map((e) => `${e.source}->${e.target}`));
    for (const e of w.edges) if (!ids.has(e.source) || !ids.has(e.target)) fail(`edge ${e.source}->${e.target} references a missing node`);
    // An output rule's destination draws its edge (R-04, R-09), so every node target needs one.
    for (const n of w.nodes) {
      for (const r of n.outputRules) {
        if (r.target.kind === 'node' && !edges.has(`${n.id}->${r.target.nodeId}`)) fail(`output rule ${r.id} targets ${r.target.nodeId} without an edge`);
      }
    }
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
export const WorkflowInstance = z
  .strictObject({
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
  })
  .superRefine((inst, ctx) => {
    const ids = new Set<string>(inst.tasks.map((t) => t.id));
    for (const t of inst.tasks) {
      if (t.instanceId !== inst.id) ctx.addIssue({ code: 'custom', message: `task ${t.id} belongs to another instance` });
      for (const d of t.dependsOn) if (d === t.id || !ids.has(d)) ctx.addIssue({ code: 'custom', message: `task ${t.id} depends on invalid task ${d}` });
    }
  });
export type WorkflowInstance = z.infer<typeof WorkflowInstance>;

/**
 * A formal handoff (R-04 steps 3-7, CR2_DELIVERY_FIX). Accepted and counted once with a fixed payload,
 * hash and confirmation revision; the target binding (or its provision) is recorded before dispatch;
 * delivery then follows the CR-2 records. A resend with the same operationId must not change payload,
 * destination or revision.
 */
export const Handoff = z
  .strictObject({
    id: HandoffId,
    operationId: OperationId,
    /** Native identity of the `handoff` MCP tool call, to recognise a resend of the same call (CR2 §4). */
    sourceCallRef: z.string().min(1),
    instanceId: InstanceId,
    taskId: TaskId,
    fromNodeId: NodeId,
    toNodeId: NodeId,
    fromSessionId: SessionId,
    ruleId: z.string().min(1),
    payload: z.string(),
    payloadHash: PayloadHash,
    proposalRevision: Revision,
    /** Fan-out round and the upstream set expected in it (CR-4). */
    round: z.number().int().nonnegative(),
    expectedUpstream: z.array(NodeId).optional(),
    /** Target GUI session once bound; `provision` when the target had to be created (CR2 §3). */
    target: z.strictObject({ sessionId: SessionId.optional(), provision: ProvisionRecord.optional() }),
    delivery: DeliveryRecord,
    /** When the acceptance transaction counted it (once per operationId). */
    acceptedAt: Timestamp,
  })
  .superRefine((h, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (h.fromNodeId === h.toNodeId) fail('a node does not hand off to itself');
    if (h.expectedUpstream) {
      if (new Set(h.expectedUpstream).size !== h.expectedUpstream.length) fail('expectedUpstream must be unique');
      if (!h.expectedUpstream.includes(h.fromNodeId)) fail('expectedUpstream must include the sender');
    }
    if (h.delivery.state !== 'pending' && h.target.sessionId === undefined) fail('a dispatched handoff has a bound target session');
    if (!deliveryNeedsBoundTarget(h.delivery, h.target.provision)) fail('payload cannot be dispatched before the target is created');
  });
export type Handoff = z.infer<typeof Handoff>;

/** Something the root session must show the user (R-05). */
export const EscalationKind = z.enum(['confirmation', 'permission', 'limit-exceeded', 'no-rule-matched', 'setup-failed', 'merge-failed', 'delivery-unknown']);

/** What an escalation is about, so the root screen can open it. */
export const EscalationRef = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('permission'), permissionRequestId: PermissionRequestId }),
  z.strictObject({ kind: z.literal('handoff'), handoffId: HandoffId }),
  z.strictObject({ kind: z.literal('peerMessage'), peerMessageId: PeerMessageId }),
  z.strictObject({ kind: z.literal('transfer'), transferId: TransferId }),
  z.strictObject({ kind: z.literal('task'), taskId: TaskId }),
]);

export const Escalation = z
  .strictObject({
    id: EscalationId,
    instanceId: InstanceId.optional(),
    rootSessionId: SessionId,
    fromSessionId: SessionId,
    kind: EscalationKind,
    title: z.string().min(1),
    detail: z.string(),
    /** For `permission`: the escalation-list rule that matched (R-08). */
    rule: z.string().optional(),
    ref: EscalationRef.optional(),
    state: z.enum(['open', 'approved', 'declined', 'resolved']),
    /** Approve / decline only ever come from the user; the root AI cannot decide (R-05). */
    resolvedBy: z.enum(['user', 'system']).optional(),
    createdAt: Timestamp,
    resolvedAt: Timestamp.optional(),
  })
  .superRefine((e, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    const open = e.state === 'open';
    if (open !== (e.resolvedAt === undefined) || open !== (e.resolvedBy === undefined)) fail('resolvedAt and resolvedBy are set exactly when closed');
    if ((e.state === 'approved' || e.state === 'declined') && e.resolvedBy !== 'user') fail('only the user approves or declines');
    if (e.kind === 'permission' && e.ref?.kind !== 'permission') fail('a permission escalation points at its request');
    if (e.kind === 'delivery-unknown' && !['handoff', 'peerMessage', 'transfer'].includes(e.ref?.kind ?? '')) fail('a delivery escalation points at its operation');
  });
export type Escalation = z.infer<typeof Escalation>;
