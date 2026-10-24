// IPC commands (renderer -> main), results, and events (main -> renderer). DATA_RUNTIME §7.
// Every command carries a requestId and explicit target IDs; the renderer's current selection is
// never used to decide where a command goes (HC-05). Commands that create something carry the new
// entity's ID, chosen by the renderer, so the caller can tell its own result apart from others'.
import { z } from 'zod';
import { AgentDefinition, ModelOption, ModelSelection } from './agent';
import {
  AgentId,
  EscalationId,
  InstanceId,
  ItemId,
  MessageId,
  NativeTaskId,
  RequestId,
  Revision,
  Runtime,
  SchemaVersion,
  SessionId,
  Timestamp,
  TransferId,
  TurnId,
  WorkflowId,
} from './common';
import { PermissionRequest, SessionItem } from './items';
import { Artifact, Attachment, LogicalSession, Message, NativeTask, PeerMessage, SessionActivity, TokenUsage, Turn } from './session';
import { TransferProposal, UiPreferences } from './transfer';
import { Escalation, Handoff, WorkflowInstance, WorkflowTemplate } from './workflow';

const cmd = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.strictObject({ type: z.literal(type), requestId: RequestId, ...shape });

export const Command = z.discriminatedUnion('type', [
  cmd('session.create', { sessionId: SessionId, kind: z.literal('ordinary'), agentId: AgentId, model: ModelSelection, cwd: z.string().min(1), parentId: SessionId.optional() }),
  cmd('session.send', { sessionId: SessionId, messageId: MessageId, expectedRevision: Revision, text: z.string().min(1), attachments: z.array(Attachment).default([]) }),
  cmd('session.interrupt', { sessionId: SessionId }),
  /** Same-runtime model change only; changing runtime goes through transfer (R-02, R-12). */
  cmd('session.setModel', { sessionId: SessionId, expectedRevision: Revision, model: ModelSelection }),
  /** Rejected for workflow sessions (WB-02). */
  cmd('session.setAgent', { sessionId: SessionId, expectedRevision: Revision, agentId: AgentId }),
  cmd('session.reparent', { sessionId: SessionId, expectedRevision: Revision, parentId: SessionId.nullable() }),
  cmd('nativeTask.stop', { sessionId: SessionId, nativeTaskId: NativeTaskId }),
  cmd('agent.save', { agent: AgentDefinition, expectedRevision: Revision.nullable() }),
  cmd('workflow.save', { workflow: WorkflowTemplate, expectedRevision: Revision.nullable() }),
  cmd('workflow.start', {
    instanceId: InstanceId,
    rootSessionId: SessionId,
    workflowId: WorkflowId,
    workflowRevision: Revision,
    title: z.string().min(1),
    cwd: z.string().min(1),
    firstMessage: z.string().min(1),
    crossToolConsent: z.boolean(),
  }),
  /** `content`: the user's form answers when approving an MCP elicitation (becomes `PermissionDecision.content`). */
  cmd('escalation.respond', { escalationId: EscalationId, decision: z.enum(['approve', 'decline']), note: z.string().optional(), content: z.json().optional() }).refine(
    (c) => c.content === undefined || c.decision === 'approve',
    { message: 'only an approval carries form content' },
  ),
  /**
   * The user's decision on a delivery whose outcome stayed unknown (CR2_DELIVERY_FIX §2). A retry may
   * deliver twice, so the user must acknowledge that explicitly.
   */
  cmd('delivery.resolve', { escalationId: EscalationId, decision: z.enum(['wait', 'cancel', 'retry']), acceptDuplicateRisk: z.boolean() }).refine(
    (c) => c.decision !== 'retry' || c.acceptDuplicateRisk,
    { message: 'a retry needs acceptDuplicateRisk' },
  ),
  cmd('transfer.prepare', { transferId: TransferId, sourceSessionId: SessionId, target: ModelSelection, noteSource: z.enum(['agent', 'gui-digest']) }),
  cmd('transfer.confirm', { transferId: TransferId, expectedRevision: Revision }),
  cmd('transfer.cancel', { transferId: TransferId }),
  cmd('preferences.set', { preferences: UiPreferences }),
]);
export type Command = z.infer<typeof Command>;

/** Error codes the renderer can act on; it must not parse message text (DATA_RUNTIME §7). */
export const ErrorCode = z.enum([
  'unsupported',
  'stale_revision',
  'permission_denied',
  'runtime_unavailable',
  'invalid_transition',
  'unknown_outcome',
  'storage_failed',
  'not_found',
  'already_exists', // a create command reused an existing ID
  'invalid_request',
  'usage_limit', // a RULES.md threshold stopped the action
]);

/** Receipt of what a command created; the IDs are the ones the command carried. */
export const CreatedRef = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session'), id: SessionId }),
  z.strictObject({ kind: z.literal('message'), id: MessageId }),
  z.strictObject({ kind: z.literal('instance'), id: InstanceId }),
  z.strictObject({ kind: z.literal('transfer'), id: TransferId }),
]);

export const CommandResult = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), requestId: RequestId, revision: Revision.optional(), created: z.array(CreatedRef).default([]) }),
  z.strictObject({
    ok: z.literal(false),
    requestId: RequestId,
    code: ErrorCode,
    message: z.string(),
    retryable: z.boolean(),
    /** True when a side effect may already have happened (do not blindly retry). */
    mayHaveSideEffects: z.boolean(),
  }),
]);
export type CommandResult = z.infer<typeof CommandResult>;

/** One plan-limit window (RULES.md §2). */
export const LimitWindow = z.strictObject({ percentUsed: z.number().min(0).max(100), resetsAt: Timestamp.optional() });

/** Push events. Each carries the target ID it belongs to; views filter by it (HC-05). */
export const AppEvent = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('session.updated'), session: LogicalSession }),
  z.strictObject({ type: z.literal('session.activity'), sessionId: SessionId, activity: SessionActivity, at: Timestamp }),
  z.strictObject({ type: z.literal('turn.updated'), turn: Turn }),
  z.strictObject({
    type: z.literal('message.delta'),
    sessionId: SessionId,
    turnId: TurnId.optional(),
    nativeTaskId: NativeTaskId.optional(),
    messageId: MessageId,
    delta: z.string(),
  }),
  z.strictObject({ type: z.literal('message.completed'), message: Message }),
  z.strictObject({ type: z.literal('item.updated'), item: SessionItem }),
  z.strictObject({ type: z.literal('item.outputDelta'), sessionId: SessionId, itemId: ItemId, delta: z.string() }),
  z.strictObject({ type: z.literal('permission.updated'), request: PermissionRequest }),
  z.strictObject({ type: z.literal('nativeTask.updated'), task: NativeTask }),
  z.strictObject({ type: z.literal('artifact.updated'), artifact: Artifact }),
  z.strictObject({ type: z.literal('instance.updated'), instance: WorkflowInstance }),
  z.strictObject({ type: z.literal('handoff.updated'), handoff: Handoff }),
  z.strictObject({ type: z.literal('peerMessage.updated'), message: PeerMessage }),
  z.strictObject({ type: z.literal('escalation.updated'), escalation: Escalation }),
  z.strictObject({ type: z.literal('transfer.updated'), proposal: TransferProposal }),
  z.strictObject({ type: z.literal('usage.tokens'), usage: TokenUsage }),
  z.strictObject({
    type: z.literal('usage.limits'),
    claude5h: LimitWindow.optional(),
    claudeWeekly: LimitWindow.optional(),
    codexWeekly: LimitWindow.optional(),
    at: Timestamp,
  }),
  z.strictObject({ type: z.literal('modelOptions.updated'), runtime: Runtime, options: z.array(ModelOption), at: Timestamp }),
]);
export type AppEvent = z.infer<typeof AppEvent>;

/** Wire form of an event: versioned and sequenced so a reconnecting renderer can resume after a Snapshot. */
export const EventEnvelope = z.strictObject({ schemaVersion: SchemaVersion, seq: z.number().int().nonnegative(), event: AppEvent });
export type EventEnvelope = z.infer<typeof EventEnvelope>;

/** Read-only snapshot the renderer loads on start / reconnect (UI re-mount never resends commands). */
export const Snapshot = z.strictObject({
  schemaVersion: SchemaVersion,
  /** Last event seq already reflected here; apply only envelopes with a larger seq. */
  seq: z.number().int().nonnegative(),
  agents: z.array(AgentDefinition),
  workflows: z.array(WorkflowTemplate),
  modelOptions: z.array(ModelOption),
  sessions: z.array(LogicalSession),
  messages: z.array(Message),
  turns: z.array(Turn),
  items: z.array(SessionItem),
  permissionRequests: z.array(PermissionRequest),
  nativeTasks: z.array(NativeTask),
  artifacts: z.array(Artifact),
  instances: z.array(WorkflowInstance),
  handoffs: z.array(Handoff),
  peerMessages: z.array(PeerMessage),
  escalations: z.array(Escalation),
  transfers: z.array(TransferProposal),
  preferences: UiPreferences,
});
export type Snapshot = z.infer<typeof Snapshot>;
