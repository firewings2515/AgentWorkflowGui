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
  TurnId,
} from './common';
import { DeliveryRecord } from './delivery';

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

/** Links a workflow session to its instance / node / task (R-06: one session per (node, task)). Root has no task. */
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
    latest: TokenCounts.optional(),
    cumulative: TokenCounts.optional(),
    contextWindow: z.number().int().positive().optional(),
    at: Timestamp,
  })
  .refine((u) => u.latest !== undefined || u.cumulative !== undefined, { message: 'usage needs latest or cumulative counts' });
export type TokenUsage = z.infer<typeof TokenUsage>;

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
  /** Ordinary sessions: organising parent in the tree (WB-01). Workflow sessions: creating source. */
  parentId: SessionId.optional(),
  /** Set when this session was created by a cross-tool transfer from another session (R-02). */
  derivedFromSessionId: SessionId.optional(),
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
    state: TurnState,
    requestedModel: ModelSelection.optional(),
    failure: z.strictObject({ message: z.string() }).optional(),
    startedAt: Timestamp,
    endedAt: Timestamp.optional(),
  })
  .refine((t) => (t.state === 'running') === (t.endedAt === undefined), { message: 'endedAt is set exactly when the turn is over' })
  .refine((t) => t.state === 'failed' || t.failure === undefined, { message: 'only failed turns carry a failure' });
export type Turn = z.infer<typeof Turn>;

/**
 * Where a message came from. `peer` (send_message) and `handoff` come from another session via the GUI
 * broker (R-03, R-04); neither is ever treated as the user's approval.
 */
export const MessageOrigin = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user') }),
  z.strictObject({ kind: z.literal('agent') }),
  z.strictObject({ kind: z.literal('peer'), fromSessionId: SessionId, peerMessageId: PeerMessageId }),
  z.strictObject({ kind: z.literal('handoff'), fromSessionId: SessionId, handoffId: HandoffId }),
  z.strictObject({ kind: z.literal('system') }),
]);

export const Attachment = z.strictObject({
  kind: z.enum(['file', 'folder', 'image']),
  path: z.string().min(1),
  name: z.string().min(1),
});

const originsByRole = { user: ['user', 'peer', 'handoff'], assistant: ['agent'], system: ['system'] } as const;

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
  .refine((m) => (originsByRole[m.role] as readonly string[]).includes(m.origin.kind), { message: 'origin does not fit the role' })
  .refine((m) => m.role === 'assistant' || m.observedModel === undefined, { message: 'only assistant messages carry a model' });
export type Message = z.infer<typeof Message>;

/** A sub-agent spawned by the runtime itself, observed but not resumable as a GUI session (R-13). */
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
  .refine((a) => (a.source === 'user-attachment') === (a.section === 'input'), { message: 'inputs are exactly the user attachments' });
export type Artifact = z.infer<typeof Artifact>;

/**
 * A `send_message` between sessions (R-03). Delivery uses the CR-2 states; `sent` is not "read" or
 * "handled". Cancel / reject / failure are recorded separately in `outcome`, never as a delivery state.
 */
export const PeerMessage = z
  .strictObject({
    id: PeerMessageId,
    operationId: OperationId,
    fromSessionId: SessionId,
    toSessionId: SessionId,
    /** Set when both sides are in one workflow instance (start-time consent covers it, R-11). */
    instanceId: InstanceId.optional(),
    text: z.string().min(1),
    payloadHash: PayloadHash,
    /** How it entered the target: a new turn when idle, or inserted into the running turn (SP-05). */
    entry: z.enum(['new-turn', 'insert']).optional(),
    delivery: DeliveryRecord,
    outcome: z.strictObject({ kind: z.enum(['cancelled', 'rejected', 'failed']), detail: z.string(), at: Timestamp }).optional(),
    createdAt: Timestamp,
  })
  .refine((m) => m.fromSessionId !== m.toSessionId, { message: 'a session does not message itself' })
  .refine((m) => m.outcome?.kind !== 'cancelled' || m.delivery.state !== 'sent', { message: 'a sent message cannot be cancelled' });
export type PeerMessage = z.infer<typeof PeerMessage>;
