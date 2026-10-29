// Sessions, turns, messages, artifacts, cross-session messages and native (runtime-spawned) sub-agents.
import { z } from 'zod';
import { ModelSelection, ObservedModel } from './agent';
import {
  AgentId,
  ArtifactId,
  HandoffId,
  InstanceId,
  MessageId,
  NativeTaskId,
  NodeId,
  OperationId,
  PayloadHash,
  PeerMessageId,
  Revision,
  Runtime,
  SessionId,
  TaskId,
  Timestamp,
  TransferId,
  TurnId,
} from './common';
import { DeliveryRecord, OperationOutcome, deliveryTargetIssues } from './delivery';
import { addRuleIssue, ruleIssue } from './rules';

/** Ordinary sessions can change Agent; workflow sessions keep the Agent fixed and may change Model (WB-02). */
export const SessionKind = z.enum(['ordinary', 'workflow']);
export type SessionKind = z.infer<typeof SessionKind>;

/** What the session is doing right now, as the GUI observed it (WB-05; R-14: never from agent self-report). */
export const SessionActivity = z.enum([
  'idle', // no turn running
  'running', // a turn is running (also when a Claude background sub-agent wakes the session, R-05)
  'waiting-user', // blocked on an escalation for the user (R-05)
  'waiting-lock', // a write is held until a file lock frees (R-07)
  'interrupted',
  'error',
  'reconciling', // outcome of the last delivery is unknown (CR-2)
  'closed', // runtime host released while idle; resumes on demand (SP-05)
]);
export type SessionActivity = z.infer<typeof SessionActivity>;

/**
 * Links a workflow session to its instance / node / task (R-06: one session per (node, task)). Root has no
 * task. The session's agent, model and write policy come from the node of the instance's pinned workflow
 * revision, not from the session (C-13); `requestedModel` records what the node asked for.
 */
export const WorkflowBinding = z.strictObject({
  instanceId: InstanceId,
  nodeId: NodeId,
  taskId: TaskId.optional(),
});

/** Token counts as one runtime report (T003 maps Codex `TokenUsageBreakdown` / Claude `usage`). */
export const TokenCounts = z.strictObject({
  input: z.number().int().nonnegative(),
  cachedInput: z.number().int().nonnegative().optional(),
  output: z.number().int().nonnegative(),
  reasoningOutput: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative(),
});

/**
 * Token usage of one session. `latest` is the most recent single report (Codex `last`, Claude per-message
 * usage); `cumulative` is the session total (Codex `total`). Shown only when reported (UI_BOUNDARIES §5).
 */
export const TokenUsage = z
  .strictObject({
    sessionId: SessionId,
    turnId: TurnId.optional(),
    /** Set when the usage belongs to a native sub-agent, so it never overwrites the session's own (R-13). */
    nativeTaskId: NativeTaskId.optional(),
    latest: TokenCounts.optional(),
    cumulative: TokenCounts.optional(),
    contextWindow: z.number().int().positive().optional(),
    at: Timestamp,
  })
  .refine((u) => u.latest !== undefined || u.cumulative !== undefined, ruleIssue('usage.needs-counts'));
export type TokenUsage = z.infer<typeof TokenUsage>;

/**
 * The session's effective folder scope (R-08): its workspace is the task worktree for task sessions (R-06),
 * otherwise its own folder. `writableRoots` is where it may write without escalating; it is empty for
 * read-only and exec-only nodes. Attachments only add readable roots, never writable ones (COM-04).
 */
export const FolderScope = z
  .strictObject({
    source: z.enum(['task-worktree', 'session-cwd']),
    workspaceRoot: z.string().min(1),
    writableRoots: z.array(z.string().min(1)),
    readableRoots: z.array(z.string().min(1)).default([]),
  })
  .refine((s) => s.writableRoots.length === 0 || s.writableRoots.includes(s.workspaceRoot), ruleIssue('scope.writable-includes-workspace'));
export type FolderScope = z.infer<typeof FolderScope>;

const sessionShape = {
  id: SessionId,
  revision: Revision,
  title: z.string(),
  agent: z.strictObject({ id: AgentId, revision: Revision }),
  requestedModel: ModelSelection,
  /** Latest observation for the header; per-reply models live on each Message (R-12). */
  observedModel: ObservedModel,
  activity: SessionActivity,
  /** Working folder: the task worktree for workflow sessions, the user's folder otherwise. */
  cwd: z.string().min(1),
  folderScope: FolderScope,
  /** Ordinary sessions: organising parent in the tree (WB-01). Workflow sessions: creating source. */
  parentId: SessionId.optional(),
  /** Set when this session was created by a cross-tool transfer from another session (R-02). */
  derivedFromSessionId: SessionId.optional(),
  /**
   * The native session/thread this GUI session is bound to once its provision was sent (C-03). The
   * delivery store's provision record stays the source of truth during creation; this is the binding
   * the session service resumes and dispatches with afterwards.
   */
  nativeSessionRef: z.string().min(1).optional(),
  tokenUsage: TokenUsage.optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
};

/**
 * The conversation the user sees (DATA_RUNTIME §1 LogicalSession; REVISION §3). A workflow session always
 * has a workflow binding and an ordinary one never does (WB-02), so the two cannot contradict.
 */
export const LogicalSession = z.discriminatedUnion('kind', [
  z.strictObject({ ...sessionShape, kind: z.literal('ordinary') }),
  z.strictObject({ ...sessionShape, kind: z.literal('workflow'), workflow: WorkflowBinding }),
]);
export type LogicalSession = z.infer<typeof LogicalSession>;

export const TurnState = z.enum(['running', 'completed', 'interrupted', 'failed']);

/** One runtime turn (R-12: Codex model changes take effect per turn, so the turn keeps what it started with). */
export const Turn = z
  .strictObject({
    id: TurnId,
    sessionId: SessionId,
    /** Set for a native sub-agent's own turn; such turns are not the session's turns (R-13). */
    nativeTaskId: NativeTaskId.optional(),
    state: TurnState,
    requestedModel: ModelSelection.optional(),
    failure: z.strictObject({ message: z.string() }).optional(),
    startedAt: Timestamp,
    endedAt: Timestamp.optional(),
  })
  .refine((t) => (t.state === 'running') === (t.endedAt === undefined), ruleIssue('turn.ended-at'))
  .refine((t) => t.state === 'failed' || t.failure === undefined, ruleIssue('turn.failure-only-failed'));
export type Turn = z.infer<typeof Turn>;

/**
 * Where a message came from. `peer` (send_message) and `handoff` come from another session via the GUI
 * broker (R-03, R-04); neither is ever treated as the user's approval. `transfer` is a cross-tool transfer
 * (R-02): the confirmed payload in the new session, or the GUI asking the source for its handoff note; its
 * `fromSessionId` is the transfer's source session (the session itself for that note request). It is not
 * the user's approval either.
 */
export const MessageOrigin = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user') }),
  z.strictObject({ kind: z.literal('agent') }),
  z.strictObject({ kind: z.literal('peer'), fromSessionId: SessionId, peerMessageId: PeerMessageId }),
  z.strictObject({ kind: z.literal('handoff'), fromSessionId: SessionId, handoffId: HandoffId }),
  z.strictObject({ kind: z.literal('transfer'), fromSessionId: SessionId, transferId: TransferId }),
  z.strictObject({ kind: z.literal('system') }),
]);

export const Attachment = z.strictObject({
  kind: z.enum(['file', 'folder', 'image']),
  path: z.string().min(1),
  name: z.string().min(1),
});

const originsByRole = { user: ['user', 'peer', 'handoff', 'transfer'], assistant: ['agent'], system: ['system'] } as const;

export const Message = z
  .strictObject({
    id: MessageId,
    sessionId: SessionId,
    turnId: TurnId.optional(),
    /** Set when the message belongs to a native sub-agent's conversation (R-13). */
    nativeTaskId: NativeTaskId.optional(),
    role: z.enum(['user', 'assistant', 'system']),
    origin: MessageOrigin,
    text: z.string(),
    attachments: z.array(Attachment).default([]),
    /**
     * Claude only: `message.model` of this assistant message (R-12), so a model switch inside one turn is
     * kept. Codex messages leave it empty; the session shows the configured model instead.
     */
    observedModel: z.string().min(1).optional(),
    createdAt: Timestamp,
  })
  .refine((m) => (originsByRole[m.role] as readonly string[]).includes(m.origin.kind), ruleIssue('message.origin-role'))
  .refine((m) => m.role === 'assistant' || m.observedModel === undefined, ruleIssue('message.model-only-assistant'));
export type Message = z.infer<typeof Message>;

/**
 * A sub-agent spawned by the runtime itself, observed but not resumable as a GUI session (R-13).
 * There is no `unknown` state (C-09): a task read from history without proof that it ended stays
 * `running`, and the read reports `complete: false`, so `running` alone never proves it is still running.
 */
export const NativeTask = z.strictObject({
  id: NativeTaskId,
  sessionId: SessionId,
  runtime: Runtime,
  /** Claude: `tool_use_id` of the parent Agent call; Codex: the parent thread. */
  parentRef: z.string().min(1),
  /** Claude: `task_id`; Codex: child thread ID. */
  nativeRef: z.string().min(1),
  parentTaskId: NativeTaskId.optional(),
  label: z.string(),
  agentType: z.string().optional(),
  state: z.enum(['running', 'completed', 'failed', 'stopped']),
  background: z.boolean(),
  lastActivity: z.string().optional(),
  summary: z.string().optional(),
  startedAt: Timestamp,
  endedAt: Timestamp.optional(),
});
export type NativeTask = z.infer<typeof NativeTask>;

/**
 * An entry of the 成果／檔案 tab (UI_BOUNDARIES §5): inputs (user attachments) and published outputs are
 * separate sections; scratch files in the cwd are not artifacts.
 */
export const Artifact = z
  .strictObject({
    id: ArtifactId,
    sessionId: SessionId,
    section: z.enum(['input', 'output']),
    source: z.enum(['user-attachment', 'agent', 'gui']),
    kind: z.enum(['file', 'folder', 'image']),
    name: z.string().min(1),
    path: z.string().min(1),
    mimeType: z.string().min(1).optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    revision: Revision,
    access: z.enum(['available', 'missing', 'out-of-scope', 'unreadable']),
    messageId: MessageId.optional(),
    turnId: TurnId.optional(),
    updatedAt: Timestamp,
  })
  .refine((a) => (a.source === 'user-attachment') === (a.section === 'input'), ruleIssue('artifact.inputs-are-attachments'));
export type Artifact = z.infer<typeof Artifact>;

/**
 * A `send_message` between sessions (R-03). Delivery uses the CR-2 states; `sent` is not "read" or
 * "handled". Cancel / reject / failure are recorded separately in `outcome`, never as a delivery state.
 */
export const PeerMessage = z
  .strictObject({
    id: PeerMessageId,
    operationId: OperationId,
    /** Native identity of the `send_message` MCP tool call, to recognise a resend of the same call (CR2 §4). */
    sourceCallRef: z.string().min(1),
    fromSessionId: SessionId,
    toSessionId: SessionId,
    /** Native session/thread the target was bound to when dispatched (R-04 step 4). */
    toNativeSessionRef: z.string().min(1).optional(),
    /** Set when both sides are in one workflow instance (start-time consent covers it, R-11). */
    instanceId: InstanceId.optional(),
    text: z.string().min(1),
    payloadHash: PayloadHash,
    /** How it entered the target: a new turn when idle, or inserted into the running turn (SP-05). */
    entry: z.enum(['new-turn', 'insert']).optional(),
    delivery: DeliveryRecord,
    /** Cancelling stops follow-up work; a delivery reconciled as sent afterwards is still recorded (CR2 §2). */
    outcome: OperationOutcome.optional(),
    createdAt: Timestamp,
  })
  .superRefine((m, ctx) => {
    if (m.fromSessionId === m.toSessionId) addRuleIssue(ctx, 'peer.not-self');
    for (const rule of deliveryTargetIssues(m.delivery, { sessionId: m.toSessionId, nativeSessionRef: m.toNativeSessionRef })) addRuleIssue(ctx, rule);
  });
export type PeerMessage = z.infer<typeof PeerMessage>;

// Inferred types for schemas that are not typed next to their definition.
export type WorkflowBinding = z.infer<typeof WorkflowBinding>;
export type TokenCounts = z.infer<typeof TokenCounts>;
export type TurnState = z.infer<typeof TurnState>;
export type MessageOrigin = z.infer<typeof MessageOrigin>;
export type Attachment = z.infer<typeof Attachment>;
