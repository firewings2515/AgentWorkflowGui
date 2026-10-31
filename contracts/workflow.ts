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
  MessageId,
  PeerMessageId,
  PermissionRequestId,
  ProjectId,
  Revision,
  SchemaVersion,
  SessionId,
  TaskId,
  TaskPlanId,
  Timestamp,
  TransferId,
  WorkflowId,
} from './common';
import { DeliveryRecord, DeliveryTarget, OperationOutcome, deliveryTargetIssues } from './delivery';
import { ProjectCommands } from './project';
import { addRuleIssue, ruleIssue, type ContractRule } from './rules';

/** Input rule: natural-language condition for the AI, plus the only fields the GUI enforces (R-04). */
export const InputRule = z
  .strictObject({
    id: z.string().min(1),
    condition: z.string().min(1),
    /** Max accepted handoffs for the same task (counted by the GUI). */
    acceptanceLimit: z.number().int().positive().optional(),
    /** Wait for every upstream sent in this round before starting (R-04, CR-4). */
    waitForAllUpstream: z.boolean().default(false),
    /** Optional wait limit of a round (CR-4): past it the round is blocked and escalated, never taken as complete. */
    waitTimeoutMs: z.number().int().positive().optional(),
  })
  .refine((r) => r.waitTimeoutMs === undefined || r.waitForAllUpstream, ruleIssue('input.timeout-needs-wait'));

const nodeTarget = z.strictObject({ kind: z.literal('node'), nodeId: NodeId });
const rootTarget = z.strictObject({ kind: z.literal('root') });

/** Where a `handoff` goes: a node, or "report to root" (R-05). Tagged so no node ID can collide with root. */
export const HandoffTarget = z.discriminatedUnion('kind', [nodeTarget, rootTarget]);
export type HandoffTarget = z.infer<typeof HandoffTarget>;

/**
 * Where an output rule sends: a handoff target, or `tasks` — root's rule for `create_tasks`, whose
 * `requiresUserConfirmation` decides whether the user confirms the task list first (R-06, O-07; the
 * built-in template sets it). Only root has `tasks` rules; a `handoff` never matches one.
 */
export const OutputTarget = z.discriminatedUnion('kind', [nodeTarget, rootTarget, z.strictObject({ kind: z.literal('tasks') })]);
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

const nodeShape = {
  id: NodeId,
  label: z.string().min(1),
  writePolicy: WritePolicy,
  concurrency: z.number().int().positive().default(1),
  inputRules: z.array(InputRule),
  outputRules: z.array(OutputRule),
  /** Canvas position for the drag-to-build editor (R-09); not used for execution. */
  position: z.strictObject({ x: z.number(), y: z.number() }),
};

/** Agent nodes run an Agent on a Model; merge nodes are run by the GUI (R-06) and are never the root. */
export const WorkflowNode = z.discriminatedUnion('kind', [
  z.strictObject({ ...nodeShape, kind: z.literal('agent'), agentId: AgentId, model: ModelSelection, isRoot: z.boolean().default(false) }),
  z.strictObject({ ...nodeShape, kind: z.literal('merge') }),
]);
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
    /** Overrides the project's setup script and test command for this workflow (O-06); absent fields use the project's. */
    setupOverride: ProjectCommands.optional(),
    nodes: z.array(WorkflowNode).min(1),
    edges: z.array(WorkflowEdge),
    updatedAt: Timestamp,
  })
  .superRefine((w, ctx) => {
    const ids = new Set<string>(w.nodes.map((n) => n.id));
    if (ids.size !== w.nodes.length) addRuleIssue(ctx, 'workflow.node-id-unique', ['nodes']);
    if (w.nodes.filter((n) => n.kind === 'agent' && n.isRoot).length !== 1) addRuleIssue(ctx, 'workflow.one-root', ['nodes']);
    const edges = new Set(w.edges.map((e) => `${e.source}->${e.target}`));
    w.edges.forEach((e, i) => {
      if (!ids.has(e.source) || !ids.has(e.target)) addRuleIssue(ctx, 'workflow.edge-missing-node', ['edges', i]);
    });
    // An output rule's destination draws its edge (R-04, R-09), so every node target needs one.
    w.nodes.forEach((n, ni) => {
      n.outputRules.forEach((r, ri) => {
        if (r.target.kind === 'node' && !edges.has(`${n.id}->${r.target.nodeId}`)) addRuleIssue(ctx, 'workflow.output-needs-edge', ['nodes', ni, 'outputRules', ri, 'target']);
        if (r.target.kind === 'tasks' && !(n.kind === 'agent' && n.isRoot)) addRuleIssue(ctx, 'workflow.tasks-rule-on-root', ['nodes', ni, 'outputRules', ri, 'target']);
      });
    });
  });
export type WorkflowTemplate = z.infer<typeof WorkflowTemplate>;

/**
 * Where a task stands (R-06, C-22):
 * - `pending`: not started; waiting for its dependencies to be merged, the task limit or a node slot.
 * - `running`: some node works on it. `blocked`: stopped until the user decides (`blockedReason` says why).
 * - `awaiting-merge` / `merging`: in the merge queue (worktree isolation).
 * - Final: `merged` (worktree isolation: the target branch has its work), `completed` (no merge: same-folder
 *   isolation, or the user ended the run as done with `workflow.complete`), `failed`, `cancelled`.
 * Dependents start only after a task is `merged` or `completed`.
 */
export const TaskStatus = z.enum(['pending', 'running', 'blocked', 'awaiting-merge', 'merging', 'merged', 'completed', 'failed', 'cancelled']);
export const finalTaskStatuses: readonly TaskStatus[] = ['merged', 'completed', 'failed', 'cancelled'];

/** Why a task is `blocked` (R-05, R-06): each one is escalated to root. */
export const TaskBlockedReason = z.enum(['setup-failed', 'merge-conflict', 'tests-failed', 'merge-failed', 'round-blocked', 'limit-exceeded', 'delivery-unknown']);

/**
 * A worktree the GUI made and must clean up (SP-07). `pending-cleanup`: `git worktree remove` failed (a process
 * held a file, or the folder is half deleted though no longer registered); retried with `rmSync` and prune.
 */
export const CleanupState = z.enum(['active', 'pending-cleanup', 'removed']);

export const TaskWorktree = z.strictObject({
  path: z.string().min(1),
  branch: z.string().min(1),
  /** The target branch commit the worktree was made from. */
  baseCommit: z.string().min(1).optional(),
  cleanup: CleanupState.default('active'),
});

/** The setup script run in a new task worktree (R-06): installs dependencies, assigns ports. */
export const TaskSetup = z
  .strictObject({
    state: z.enum(['running', 'succeeded', 'failed']),
    command: z.string().min(1),
    startedAt: Timestamp,
    endedAt: Timestamp.optional(),
    exitCode: z.number().int().nullable().optional(),
    /** The end of its output, for the root screen; never the whole log. */
    outputTail: z.string().default(''),
  })
  .refine((s) => (s.state === 'running') === (s.endedAt === undefined), ruleIssue('task.setup-ended'));

/** A unit of parallel work inside an instance (R-06). Dependents start only after this task is merged. */
export const WorkflowTask = z
  .strictObject({
    id: TaskId,
    instanceId: InstanceId,
    title: z.string().min(1),
    dependsOn: z.array(TaskId),
    status: TaskStatus,
    blockedReason: TaskBlockedReason.optional(),
    currentNodeId: NodeId.optional(),
    worktree: TaskWorktree.optional(),
    setup: TaskSetup.optional(),
    reworkCount: z.number().int().nonnegative(),
    /** When it reached `merged` or `completed`; absent on tasks stored before 0.6. */
    completedAt: Timestamp.optional(),
  })
  .superRefine((t, ctx) => {
    if (t.blockedReason !== undefined && t.status !== 'blocked') addRuleIssue(ctx, 'task.blocked-reason', ['blockedReason']);
    // One direction only: 0.5 stored no completion time (T028 r1 P1-1).
    if (t.completedAt !== undefined && t.status !== 'merged' && t.status !== 'completed') addRuleIssue(ctx, 'task.completed-at', ['completedAt']);
  });
export type WorkflowTask = z.infer<typeof WorkflowTask>;

/**
 * One wait of a node that waits for all upstream (R-04, CR-4), keyed by (task, node, round). Each fan-out
 * opens a new round and records the upstream expected in it: only branches actually sent, so an untaken
 * branch is never waited for. Only this round's handoffs count. An upstream that failed or was cancelled,
 * or the input rule's wait limit, blocks the round and escalates it to root; the set never shrinks and a
 * blocked round is never taken as complete.
 */
export const JoinRound = z
  .strictObject({
    taskId: TaskId,
    nodeId: NodeId,
    round: z.number().int().nonnegative(),
    expectedUpstream: z.array(NodeId).min(1),
    arrived: z.array(z.strictObject({ fromNodeId: NodeId, handoffId: HandoffId })),
    state: z.enum(['waiting', 'ready', 'blocked']),
    blockedReason: z.enum(['upstream-failed', 'upstream-cancelled', 'timeout']).optional(),
    /** The upstream that failed or was cancelled. */
    blockedUpstream: NodeId.optional(),
    /** From the input rule's `waitTimeoutMs` at the round's start. */
    deadline: Timestamp.optional(),
    escalationId: EscalationId.optional(),
    openedAt: Timestamp,
    /** When it became ready or blocked. */
    settledAt: Timestamp.optional(),
  })
  .superRefine((r, ctx) => {
    const fail = (rule: ContractRule) => addRuleIssue(ctx, rule);
    const expected = new Set<string>(r.expectedUpstream);
    const from = r.arrived.map((a) => a.fromNodeId);
    if (expected.size !== r.expectedUpstream.length) fail('handoff.upstream-unique');
    if (new Set(from).size !== from.length || from.some((n) => !expected.has(n))) fail('round.arrived-expected');
    const complete = r.expectedUpstream.every((n) => from.includes(n));
    if ((r.state === 'ready') !== complete && r.state !== 'blocked') fail('round.ready-when-complete');
    if ((r.state === 'blocked') !== (r.blockedReason !== undefined)) fail('round.blocked-reason');
    if ((r.state === 'waiting') !== (r.settledAt === undefined)) fail('round.settled-at');
  });
export type JoinRound = z.infer<typeof JoinRound>;

/** States of a merge attempt (R-06 steps 1-6, CR-3). Active ones hold the instance's one merge slot. */
export const MergeState = z.enum(['queued', 'merging', 'resolving', 'testing', 'advancing', 'merged', 'conflict', 'tests-failed', 'failed', 'cancelled']);
export const activeMergeStates: readonly MergeState[] = ['merging', 'resolving', 'testing', 'advancing'];
const finalMergeStates: readonly MergeState[] = ['merged', 'conflict', 'tests-failed', 'failed', 'cancelled'];

/**
 * One try at merging a task (R-06, CR-3). The GUI merges in an integration worktree made from the target
 * branch's current commit; `resolving`: an agent works on the conflict; `conflict` / `tests-failed`: given
 * back to the task, the target branch untouched and dependents not started; `advancing`: fast-forwarding
 * the target branch, restarted from a new integration worktree (`restarts`) if the branch moved meanwhile.
 */
export const MergeAttempt = z
  .strictObject({
    taskId: TaskId,
    /** Per task, from 0. */
    attempt: z.number().int().nonnegative(),
    /** Queue order within the instance: one at a time, lowest first. */
    seq: z.number().int().nonnegative(),
    state: MergeState,
    integration: z.strictObject({ path: z.string().min(1), branch: z.string().min(1), cleanup: CleanupState.default('active') }).optional(),
    baseCommit: z.string().min(1).optional(),
    mergedCommit: z.string().min(1).optional(),
    conflictFiles: z.array(z.string().min(1)).default([]),
    test: z
      .strictObject({ command: z.string().min(1), exitCode: z.number().int().nullable(), passed: z.boolean(), outputTail: z.string(), endedAt: Timestamp })
      .optional(),
    restarts: z.number().int().nonnegative().default(0),
    detail: z.string().optional(),
    enqueuedAt: Timestamp,
    endedAt: Timestamp.optional(),
  })
  .superRefine((m, ctx) => {
    const fail = (rule: ContractRule) => addRuleIssue(ctx, rule);
    if (m.state === 'conflict' ? m.conflictFiles.length === 0 : m.conflictFiles.length > 0 && m.state !== 'resolving' && m.state !== 'cancelled') fail('merge.conflict-files');
    if (m.state === 'tests-failed' && m.test?.passed !== false) fail('merge.test-result');
    if (m.state === 'merged' && (m.mergedCommit === undefined || m.test?.passed !== true)) fail('merge.merged-needs-commit');
    if (finalMergeStates.includes(m.state) !== (m.endedAt !== undefined)) fail('merge.ended-at');
  });
export type MergeAttempt = z.infer<typeof MergeAttempt>;

/** One task of a `create_tasks` list. Keys name tasks within the list. */
export const TaskPlanItem = z.strictObject({
  key: z.string().min(1),
  title: z.string().min(1),
  /** Keys of other tasks in the same list. */
  dependsOn: z.array(z.string().min(1)).default([]),
  /** Tasks that already exist in the instance. */
  dependsOnExisting: z.array(TaskId).default([]),
});
export type TaskPlanItem = z.infer<typeof TaskPlanItem>;

/** Whether the tasks of a list depend on each other in a cycle (by key). */
export const hasDependencyCycle = (items: readonly { key: string; dependsOn: readonly string[] }[]): boolean => {
  const deps = new Map(items.map((t) => [t.key, t.dependsOn]));
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (key: string): boolean => {
    const s = state.get(key);
    if (s === 'done') return false;
    if (s === 'visiting') return true;
    state.set(key, 'visiting');
    for (const d of deps.get(key) ?? []) if (visit(d)) return true;
    state.set(key, 'done');
    return false;
  };
  return items.some((t) => visit(t.key));
};

/**
 * A task list root proposed with `create_tasks` (R-06, O-07), kept so a restart can still create it once the
 * user decides. `awaiting-confirmation` has its escalation open; `created` names the tasks it made.
 */
export const TaskPlan = z
  .strictObject({
    id: TaskPlanId,
    fromSessionId: SessionId,
    /** Native identity of the `create_tasks` call, to recognise a resend (CR2 §4). */
    sourceCallRef: z.string().min(1),
    /** Root's `tasks` output rule that allowed it. */
    ruleId: z.string().min(1),
    items: z.array(TaskPlanItem).min(1),
    state: z.enum(['awaiting-confirmation', 'declined', 'created']),
    escalationId: EscalationId.optional(),
    created: z.array(z.strictObject({ key: z.string().min(1), taskId: TaskId })).default([]),
    createdAt: Timestamp,
    decidedAt: Timestamp.optional(),
  })
  .superRefine((p, ctx) => {
    const fail = (rule: ContractRule) => addRuleIssue(ctx, rule);
    if (p.state === 'awaiting-confirmation' && p.escalationId === undefined) fail('taskplan.confirming-needs-escalation');
    const keys = p.items.map((i) => i.key).sort();
    const named = p.created.map((c) => c.key).sort();
    const oneEach = named.length === keys.length && named.every((k, i) => k === keys[i]) && new Set(p.created.map((c) => c.taskId)).size === p.created.length;
    if (p.state === 'created' ? !oneEach : p.created.length > 0) fail('taskplan.created-tasks');
    if ((p.state === 'awaiting-confirmation') !== (p.decidedAt === undefined)) fail('taskplan.decided-at');
  });
export type TaskPlan = z.infer<typeof TaskPlan>;

/** One run of a template (WF-05). Pinned to the template revision it started with. */
export const WorkflowInstance = z
  .strictObject({
    id: InstanceId,
    /** Compare-and-set revision of this record (C-12): every change of state or tasks advances it. */
    revision: Revision,
    workflowId: WorkflowId,
    workflowRevision: Revision,
    title: z.string().min(1),
    rootSessionId: SessionId,
    state: z.enum(['running', 'blocked', 'completed', 'cancelled']),
    /** Consent to cross-tool handoffs between this instance's nodes, recorded at start (R-11). */
    crossToolConsentAt: Timestamp.optional(),
    /**
     * The template as it was at start (C-13), so a restart rebuilds the run from what was started and agreed
     * to (R-11), whatever the template became since: only the current revision of a template is stored (C-11).
     * Its `reworkLimit` is the one told to root and counted by the GUI per task (R-05).
     */
    template: WorkflowTemplate,
    /** The project whose setup script and test command the tasks use (O-06), when the cwd is one. */
    projectId: ProjectId.optional(),
    /** The branch merges go to (R-06); the pipeline sets it before its first merge (absent before 0.6). */
    targetBranch: z.string().min(1).optional(),
    /** Global limit of tasks in progress at once (O-05). */
    taskLimit: z.number().int().positive().default(3),
    tasks: z.array(WorkflowTask),
    /** Waits of nodes that wait for all upstream (CR-4); one per (task, node, round). */
    rounds: z.array(JoinRound).default([]),
    /** Every merge attempt, in queue order; at most one is active (CR-3). */
    mergeQueue: z.array(MergeAttempt).default([]),
    /** `create_tasks` lists of this run (O-07). */
    taskPlans: z.array(TaskPlan).default([]),
    createdAt: Timestamp,
    /** When the user ended it (`workflow.complete` / `workflow.cancel`); absent on runs stored before 0.6. */
    endedAt: Timestamp.optional(),
  })
  .superRefine((inst, ctx) => {
    if (inst.template.id !== inst.workflowId || inst.template.revision !== inst.workflowRevision) addRuleIssue(ctx, 'instance.template-pinned', ['template']);
    const ids = new Set<string>(inst.tasks.map((t) => t.id));
    inst.tasks.forEach((t, i) => {
      if (t.instanceId !== inst.id) addRuleIssue(ctx, 'instance.task-other-instance', ['tasks', i, 'instanceId']);
      if (t.dependsOn.some((d) => d === t.id || !ids.has(d))) addRuleIssue(ctx, 'instance.task-invalid-dependency', ['tasks', i, 'dependsOn']);
    });
    // Only what 0.5 could not store is checked here, so every run 0.5 stored still reads (T028 r1 P1-1): a
    // cycle is refused where tasks are made (`create_tasks`), a target branch is set by the pipeline before
    // it merges, and the tasks of an ended run are made final by the command that ends it.
    const ended = inst.state === 'completed' || inst.state === 'cancelled';
    if (inst.endedAt !== undefined && !ended) addRuleIssue(ctx, 'instance.ended-at', ['endedAt']);
    const rounds = new Set<string>();
    inst.rounds.forEach((r, i) => {
      const key = JSON.stringify([r.taskId, r.nodeId, r.round]);
      if (rounds.has(key)) addRuleIssue(ctx, 'instance.round-unique', ['rounds', i]);
      rounds.add(key);
      if (!ids.has(r.taskId)) addRuleIssue(ctx, 'instance.unknown-task', ['rounds', i, 'taskId']);
    });
    const attempts = new Set<string>();
    inst.mergeQueue.forEach((m, i) => {
      const key = JSON.stringify([m.taskId, m.attempt]);
      if (attempts.has(key)) addRuleIssue(ctx, 'instance.merge-attempt-unique', ['mergeQueue', i]);
      attempts.add(key);
      if (!ids.has(m.taskId)) addRuleIssue(ctx, 'instance.unknown-task', ['mergeQueue', i, 'taskId']);
    });
    if (new Set(inst.mergeQueue.map((m) => m.seq)).size !== inst.mergeQueue.length) addRuleIssue(ctx, 'instance.merge-attempt-unique', ['mergeQueue']);
    if (inst.mergeQueue.filter((m) => activeMergeStates.includes(m.state)).length > 1) addRuleIssue(ctx, 'instance.merge-one-at-a-time', ['mergeQueue']);
    if (new Set(inst.taskPlans.map((p) => p.id)).size !== inst.taskPlans.length) addRuleIssue(ctx, 'instance.task-plan-unique', ['taskPlans']);
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
    /** Rework (R-05): the target node already received a handoff of this task; see `HandoffMeta.rework`. */
    rework: z.boolean().default(false),
    payload: z.string(),
    payloadHash: PayloadHash,
    proposalRevision: Revision,
    /** Fan-out round and the upstream set expected in it (CR-4). */
    round: z.number().int().nonnegative(),
    expectedUpstream: z.array(NodeId).optional(),
    /** Target GUI session and its native binding once bound; `provision` when it had to be created (CR2 §3). */
    target: DeliveryTarget,
    delivery: DeliveryRecord,
    /** Cancelled, rejected or failed apart from delivery (C-05); e.g. its target's provision was cancelled. */
    outcome: OperationOutcome.optional(),
    /** When the acceptance transaction counted it (once per operationId). */
    acceptedAt: Timestamp,
  })
  .superRefine((h, ctx) => {
    const fail = (rule: ContractRule) => addRuleIssue(ctx, rule);
    if (h.fromNodeId === h.toNodeId) fail('handoff.not-self');
    if (h.expectedUpstream) {
      if (new Set(h.expectedUpstream).size !== h.expectedUpstream.length) fail('handoff.upstream-unique');
      if (!h.expectedUpstream.includes(h.fromNodeId)) fail('handoff.upstream-includes-sender');
    }
    for (const rule of deliveryTargetIssues(h.delivery, h.target)) fail(rule);
  });
export type Handoff = z.infer<typeof Handoff>;

/** Something the root session must show the user (R-05). */
export const EscalationKind = z.enum([
  'confirmation',
  'permission',
  'limit-exceeded',
  'no-rule-matched',
  'setup-failed',
  'merge-failed',
  'delivery-unknown',
  /** A round's upstream failed or was cancelled, or its wait limit passed (CR-4). */
  'round-blocked',
  /** A held write waited for a file lock past its limit (R-07). */
  'lock-timeout',
  /** A file changed while its lock holder had no write in progress, e.g. a shell write (R-07). */
  'unlocked-write',
]);

/** What an escalation is about, so the root screen can open it. */
export const EscalationRef = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('permission'), permissionRequestId: PermissionRequestId }),
  z.strictObject({ kind: z.literal('handoff'), handoffId: HandoffId }),
  z.strictObject({ kind: z.literal('peerMessage'), peerMessageId: PeerMessageId }),
  z.strictObject({ kind: z.literal('transfer'), transferId: TransferId }),
  z.strictObject({ kind: z.literal('task'), taskId: TaskId }),
  /**
   * Creating a target session whose outcome stayed unknown (C-06); `blocked` are the payload operations
   * waiting for it, so the root screen can show what the decision affects.
   */
  z.strictObject({ kind: z.literal('provision'), operationId: OperationId, blocked: z.array(OperationId) }),
  /** A user message of an ordinary session whose delivery stayed unknown (C-02), resolved with `delivery.resolve`. */
  z.strictObject({ kind: z.literal('message'), operationId: OperationId, messageId: MessageId }),
  /**
   * A `report_to_root` call that asked for the user's confirmation (C-13); `operationId` is its delivery to
   * root. The report is delivered as a peer message, so if that delivery's outcome stays unknown, the
   * `delivery-unknown` escalation points at its `peerMessage` ref; both refs name the same operation.
   */
  z.strictObject({ kind: z.literal('report'), operationId: OperationId }),
  z.strictObject({ kind: z.literal('round'), taskId: TaskId, nodeId: NodeId, round: z.number().int().nonnegative() }),
  /** A `create_tasks` list waiting for the user (O-07), decided with `escalation.respond`. */
  z.strictObject({ kind: z.literal('taskPlan'), taskPlanId: TaskPlanId }),
  z.strictObject({ kind: z.literal('merge'), taskId: TaskId, attempt: z.number().int().nonnegative() }),
  /** A file lock (R-07): the session that waited or wrote, and the holder when there was one. */
  z.strictObject({ kind: z.literal('lock'), path: z.string().min(1), sessionId: SessionId, holderSessionId: SessionId.optional() }),
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
    const fail = (rule: ContractRule) => addRuleIssue(ctx, rule);
    const open = e.state === 'open';
    if (open !== (e.resolvedAt === undefined) || open !== (e.resolvedBy === undefined)) fail('escalation.resolved-fields');
    if ((e.state === 'approved' || e.state === 'declined') && e.resolvedBy !== 'user') fail('escalation.user-decides');
    if (e.kind === 'permission' && e.ref?.kind !== 'permission') fail('escalation.permission-ref');
    if (e.kind === 'delivery-unknown' && !['handoff', 'peerMessage', 'transfer', 'provision', 'message'].includes(e.ref?.kind ?? '')) fail('escalation.delivery-ref');
    if (e.kind === 'round-blocked' && e.ref?.kind !== 'round') fail('escalation.round-ref');
    if ((e.kind === 'lock-timeout' || e.kind === 'unlocked-write') && e.ref?.kind !== 'lock') fail('escalation.lock-ref');
    if (e.ref?.kind === 'taskPlan' && e.kind !== 'confirmation') fail('escalation.task-plan-confirmation');
  });
export type Escalation = z.infer<typeof Escalation>;

// Inferred types for schemas that are not typed next to their definition.
export type InputRule = z.infer<typeof InputRule>;
export type OutputRule = z.infer<typeof OutputRule>;
export type NodeKind = z.infer<typeof NodeKind>;
export type WritePolicy = z.infer<typeof WritePolicy>;
export type WorkflowEdge = z.infer<typeof WorkflowEdge>;
export type TaskStatus = z.infer<typeof TaskStatus>;
export type TaskBlockedReason = z.infer<typeof TaskBlockedReason>;
export type CleanupState = z.infer<typeof CleanupState>;
export type TaskWorktree = z.infer<typeof TaskWorktree>;
export type TaskSetup = z.infer<typeof TaskSetup>;
export type MergeState = z.infer<typeof MergeState>;
export type EscalationKind = z.infer<typeof EscalationKind>;
export type EscalationRef = z.infer<typeof EscalationRef>;
