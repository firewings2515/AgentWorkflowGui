// Sessions, turns, messages and native (runtime-spawned) sub-agents.
import { z } from 'zod';
import { ModelSelection, ObservedModel } from './agent';
import { AgentId, InstanceId, MessageId, NativeTaskId, NodeId, Revision, Runtime, SessionId, TaskId, Timestamp, TurnId } from './common';

/** Ordinary sessions can change Agent; workflow sessions keep the Agent fixed and may change Model (WB-02). */
export const SessionKind = z.enum(['ordinary', 'workflow']);

/** What the session is doing right now, as the GUI observed it (WB-05; R-14: never from agent self-report). */
export const SessionActivity = z.enum([
  'idle', // no turn running
  'running', // a turn is running
  'waiting-user', // blocked on an escalation for the user (R-05)
  'waiting-lock', // a write is held until a file lock frees (R-07)
  'interrupted',
  'error',
  'reconciling', // outcome of the last delivery is unknown (CR-2)
  'closed', // runtime host released while idle; resumes on demand (SP-05)
]);
export type SessionActivity = z.infer<typeof SessionActivity>;

/** Links a workflow session to its instance / node / task (R-06: one session per (node, task)). */
export const WorkflowBinding = z.strictObject({
  instanceId: InstanceId,
  nodeId: NodeId,
  taskId: TaskId.optional(),
});

/** The conversation the user sees (DATA_RUNTIME §1 LogicalSession; REVISION §3). */
export const LogicalSession = z.strictObject({
  id: SessionId,
  revision: Revision,
  kind: SessionKind,
  title: z.string(),
  agent: z.strictObject({ id: AgentId, revision: Revision }),
  requestedModel: ModelSelection,
  observedModel: ObservedModel,
  activity: SessionActivity,
  /** Working folder: the task worktree for workflow sessions, the user's folder otherwise. */
  cwd: z.string().min(1),
  /** Ordinary sessions: organising parent in the tree (WB-01). Workflow sessions: creating source. */
  parentId: SessionId.optional(),
  /** Set when this session was created by a cross-tool transfer from another session (R-02). */
  derivedFromSessionId: SessionId.optional(),
  workflow: WorkflowBinding.optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type LogicalSession = z.infer<typeof LogicalSession>;

export const TurnState = z.enum(['running', 'completed', 'interrupted', 'failed']);

export const Turn = z.strictObject({
  id: TurnId,
  sessionId: SessionId,
  state: TurnState,
  startedAt: Timestamp,
  endedAt: Timestamp.optional(),
  /** Model as reported for this turn when the runtime reports it (Claude only, R-12). */
  observedModel: z.string().optional(),
});
export type Turn = z.infer<typeof Turn>;

/**
 * Where a message came from. `peer` is another session via the GUI broker (R-03); it is never
 * treated as the user's approval.
 */
export const MessageOrigin = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user') }),
  z.strictObject({ kind: z.literal('agent') }),
  z.strictObject({ kind: z.literal('peer'), fromSessionId: SessionId }),
  z.strictObject({ kind: z.literal('system') }),
]);

export const Attachment = z.strictObject({
  kind: z.enum(['file', 'folder', 'image']),
  path: z.string().min(1),
  name: z.string().min(1),
});

export const Message = z.strictObject({
  id: MessageId,
  sessionId: SessionId,
  turnId: TurnId.optional(),
  role: z.enum(['user', 'assistant', 'system']),
  origin: MessageOrigin,
  text: z.string(),
  attachments: z.array(Attachment).default([]),
  createdAt: Timestamp,
});
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
